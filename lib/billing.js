"use strict";
// ── Next charge per account (2.36.0, 2026-10-29) ─────────────────────────────
//
// Hanan: "beside each account show how many days are left until the next
// charge, so an account one day from renewal can be cancelled in time instead
// of dragging another month."
//
// No Anthropic endpoint publishes a billing period end (measured on the OAuth
// surface: /api/oauth/profile carries `subscription_created_at` and a status;
// /api/oauth/usage carries rate-limit windows and a monthly BUDGET reset that is
// the same instant on every account — a global window, never a billing date).
// So the date is DERIVED: a Stripe monthly subscription charges on the anchor's
// day-of-month at the anchor's time of day (UTC), clamped to a shorter month's
// last day, the first such instant STRICTLY after now; an anchor in the future
// is itself the next charge. The vectors in billing-anchor-vectors.json were
// computed BY HAND and pin this twin AND the PVE console's `next_charge`.
//
// The profile is read in the BACKGROUND with the account's own token (the
// token never leaves this process and is never cached), re-read every TTL_MS,
// a refusal backs off BACKOFF_MS and KEEPS the last good profile (the anchor is
// immutable, so a failed refresh must not erase a true date). `view()` never
// blocks: /auth/accounts answers from the cache and says WHY when it cannot.
// An operator may override the derivation with `billing_anchor` on the account
// in accounts.json (an ISO date or instant); an unreadable override is
// REPORTED, never silently ignored.

const fs = require("fs");
const path = require("path");
const https = require("https");

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TTL_MS = 6 * 3600 * 1000;
const BACKOFF_MS = 3600 * 1000;
const STALE_MS = 7 * 86400 * 1000;
const SOON_DAYS = 3;

// ── the derivation ───────────────────────────────────────────────────────────

// ISO instant or ISO date (midnight UTC) → epoch ms at whole seconds, or null.
// Fractional seconds are dropped: a charge is not scheduled to the millisecond
// and the vectors compare whole seconds (the PVE console does the same).
function parseAnchor(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (!m) return null;
  // Date.parse ROLLS an impossible calendar day (30 Feb → 2 Mar) instead of
  // refusing it; the written triplet must survive a round trip or it is not a
  // date. Checked on the digits as written, before any offset is applied.
  const Y = +m[1], M = +m[2], D = +m[3];
  const probe = new Date(Date.UTC(Y, M - 1, D));
  if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== M - 1 || probe.getUTCDate() !== D) return null;
  const ms = Date.parse(t.length === 10 ? t + "T00:00:00Z"
    : (/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t + "Z"));
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000) * 1000;
}

function daysInMonth(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }

// First instant STRICTLY after `nowMs` on the anchor's day-of-month at the
// anchor's time, clamped to a shorter month's last day. Future anchor → itself.
function nextChargeAt(anchorMs, nowMs) {
  if (anchorMs > nowMs) return anchorMs;
  const a = new Date(anchorMs);
  const n = new Date(nowMs);
  let y = n.getUTCFullYear(), m = n.getUTCMonth();
  let cand = 0;
  for (let i = 0; i < 3; i++) {
    const day = Math.min(a.getUTCDate(), daysInMonth(y, m));
    cand = Date.UTC(y, m, day, a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds());
    if (cand > nowMs) return cand;
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return cand; // unreachable: the second iteration is always after now
}

function daysLeft(nextMs, nowMs) { return Math.floor((nextMs - nowMs) / 86400000); }

const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ── the cache ────────────────────────────────────────────────────────────────

let cachePath = null;          // set by configure(); view() refuses nothing but reads {}
let fetcher = null;            // injectable for tests; default = real https GET
const inflight = new Set();
let offline = () => process.env.CLAUDE_BRIDGE_BILLING_OFFLINE === "1";

function configure(opts) {
  if (opts && opts.cachePath) cachePath = opts.cachePath;
  if (opts && typeof opts.fetcher === "function") fetcher = opts.fetcher;
  if (opts && typeof opts.offline === "function") offline = opts.offline;
}

function cacheLoad() {
  if (!cachePath) return {};
  try { const d = JSON.parse(fs.readFileSync(cachePath, "utf8")); return d && typeof d === "object" ? d : {}; }
  catch (_e) { return {}; }
}

function cacheSave(d) {
  if (!cachePath) return;
  const tmp = cachePath + ".tmp";
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_e) {}
  fs.renameSync(tmp, cachePath);
}

function readToken(account) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(account.config_dir, ".credentials.json"), "utf8"));
    return ((raw && raw.claudeAiOauth) || {}).accessToken || null;
  } catch (_e) { return null; }
}

// Real GET. Resolves {status, body} or rejects; never resolves with a token.
function httpsProfile(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(PROFILE_URL, {
      method: "GET", timeout: 15000,
      headers: { Authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20",
                 "User-Agent": "claude-bridge-cli/billing" },
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (buf.length < 200000) buf += c; });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(buf || "{}"); } catch (_e) { body = null; }
        resolve({ status: res.statusCode, body });
      });
      // A connection that drops AFTER the headers emits `aborted`/`error` on
      // the response and nothing on the request: without these the promise
      // never settles, `inflight` keeps the name for the life of the process,
      // and every later `kick` for that account returns false — a refresh
      // that can never happen again. (CodeRabbit, 2026-10-29.)
      res.on("aborted", () => reject(new Error("response aborted")));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

// One background read; stores a SUBSET of the profile — facts the row needs,
// never a token — or the refusal, with the time of either.
async function fetchOne(account) {
  const name = account.name;
  const now = Date.now();
  const entry = { fetched_at: null, profile: null, error: null, error_at: null };
  try {
    const tok = readToken(account);
    if (!tok) throw new Error("no access token on file");
    const r = await (fetcher || httpsProfile)(tok);
    if (!r || r.status !== 200) { entry.error = "profile refused HTTP " + (r && r.status); entry.error_at = now; }
    else {
      const org = (r.body && r.body.organization) || {};
      const acct = (r.body && r.body.account) || {};
      entry.profile = {
        subscription_created_at: org.subscription_created_at == null ? null : org.subscription_created_at,
        subscription_status: org.subscription_status == null ? null : org.subscription_status,
        organization_type: org.organization_type == null ? null : org.organization_type,
        billing_type: org.billing_type == null ? null : org.billing_type,
        has_extra_usage_enabled: org.has_extra_usage_enabled == null ? null : org.has_extra_usage_enabled,
        rate_limit_tier: org.rate_limit_tier == null ? null : org.rate_limit_tier,
        email: acct.email == null ? null : acct.email,
      };
      entry.fetched_at = now;
    }
  } catch (e) {
    entry.error = ("profile fetch failed: " + (e && e.message || String(e))).slice(0, 160);
    entry.error_at = now;
  }
  const cache = cacheLoad();
  const old = cache[name] || {};
  if (entry.profile === null && old.profile) {
    // Keep the last good profile beside the new refusal.
    entry.profile = old.profile;
    entry.fetched_at = old.fetched_at || null;
  }
  cache[name] = entry;
  try { cacheSave(cache); } catch (_e) { /* a cache that cannot be written costs one re-read, nothing else */ }
  inflight.delete(name);
}

// Start one background read if the cache is missing/past TTL and no refusal is
// still backing off. Returns true if a read started. Never throws, never waits.
function kick(account, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const name = account && account.name;
  if (!name || offline() || !cachePath) return false;
  if (inflight.has(name)) return false;
  const c = cacheLoad()[name] || {};
  const fresh = c.fetched_at && now - c.fetched_at < TTL_MS;
  const backingOff = c.error_at && now - c.error_at < BACKOFF_MS;
  if (fresh || backingOff) return false;
  inflight.add(name);
  // Detached: the caller is a request handler and must not wait for the net.
  setImmediate(() => { fetchOne(account).catch(() => { inflight.delete(name); }); });
  return true;
}

const fmtAt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

// Everything this bridge can honestly say about one account's next charge.
// The SAME shape the PVE console publishes, so the extension has one renderer.
function view(account, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const c = cacheLoad()[account && account.name] || {};
  const prof = c.profile || {};
  const override = account ? account.billing_anchor : undefined;
  let anchor, source;
  if (override != null) {
    anchor = parseAnchor(override);
    if (anchor === null) {
      return { available: false, source: "override",
               why: "billing_anchor in accounts.json is not an ISO date: " + JSON.stringify(String(override).slice(0, 40)) };
    }
    source = "override";
  } else {
    anchor = parseAnchor(prof.subscription_created_at);
    source = "subscription_start";
    if (anchor === null) {
      const pending = kick(account, now);
      return { available: false, source: null,
               why: c.error ? c.error : "the subscription start has not been read yet",
               pending: !!(pending || inflight.has(account && account.name)),
               error_at: c.error_at ? fmtAt(c.error_at) : null };
    }
  }
  kick(account, now);  // keep the status current; never blocks
  const next = nextChargeAt(anchor, now);
  const d = daysLeft(next, now);
  const status = prof.subscription_status == null ? null : prof.subscription_status;
  return {
    available: true,
    source,
    anchor: isoS(anchor),
    next_charge_at: isoS(next),
    days_left: d,
    soon: d <= SOON_DAYS,
    will_charge: status === null || status === "active",
    status,
    plan: prof.organization_type == null ? null : prof.organization_type,
    billing_type: prof.billing_type == null ? null : prof.billing_type,
    fetched_at: c.fetched_at ? fmtAt(c.fetched_at) : null,
    stale: !!c.fetched_at && (now - c.fetched_at > STALE_MS),
    error: c.error == null ? null : c.error,
  };
}

module.exports = {
  parseAnchor, nextChargeAt, daysLeft, view, kick, configure,
  PROFILE_URL, TTL_MS, BACKOFF_MS, STALE_MS, SOON_DAYS,
  _cacheLoad: cacheLoad, _inflight: inflight,
};

"use strict";
// ── Multi-account routing for the Node bridge ────────────────────────────────
//
// WHAT THIS CLOSES. Until now the Node bridge (every machine that is not the
// PVE host) had NO account concept and NO usage-limit detection at all: it
// spawned `claude` with a single inherited environment, and a usage cap came
// back to the user as a raw error. It did not merely fail to fail over — it
// dead-ended. The Python bridge on PVE has had sticky-drain account routing
// for months; this is that behaviour, ported, minus the parts that do not
// belong on a laptop.
//
// DELIBERATELY NOT PORTED: the OAuth usage-endpoint poller. On PVE it exists
// to read the exact % claude.ai shows, and its own comment records that
// hammering it "on every panel open" is what gets the fleet 429'd. A 429
// leaves an account with NO data, which is then rendered as *available* — a
// wrong number is worse than no number. The laptop learns from the one signal
// that cannot lie: a turn that actually failed. That makes the state here
// strictly evidence-based.
//
// THE STATE IS THIS MACHINE'S OWN VIEW, AND THAT IS STATED RATHER THAN HIDDEN.
// Two routers cannot see each other's blocks, so a shared account capped on
// PVE is discovered here by one failed turn, not in advance. That single
// wasted turn is the whole price of not building a distributed lease — which
// would add a stuck-lease failure mode that does not exist today.

const fs = require("fs");
const path = require("path");
const os = require("os");

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function dataDir() {
  const d = path.join(homeDir(), ".claude-bridge");
  try { fs.mkdirSync(d, { recursive: true }); } catch (_e) {}
  return d;
}

const CONFIG_PATH = () =>
  process.env.CLAUDE_BRIDGE_ACCOUNTS || path.join(dataDir(), "accounts.json");
const STATE_PATH = () =>
  process.env.CLAUDE_BRIDGE_ACCOUNT_STATE || path.join(dataDir(), "account-state.json");

// ── the ambient login ────────────────────────────────────────────────────────
//
// The login this machine uses TODAY when no accounts file exists — i.e. the
// ordinary single-account install, which is every machine until someone writes
// a config. It exists so RENEWAL is reachable with zero setup: a dying login
// is a fact about a machine, not a privilege of having opted into routing.
// The machine that most needs to be told its login is expiring is exactly the
// one with a single account and no failover to hide it.
//
// ⚠️ IT IS NOT A ROUTABLE ACCOUNT AND MUST NEVER BECOME ONE. `loadConfig()`
// does not consult it, so with no config the spawn path is byte-for-byte what
// it was: one inherited environment, no CLAUDE_CONFIG_DIR override, no
// failover, no state file. Only the auth read/renew surface sees this. Making
// it routable would silently change how every existing install runs its turns,
// which is the one thing "work mode is today's behaviour" promised not to do.
const AMBIENT_NAME = "this-machine";

function ambientAccount() {
  return {
    name: AMBIENT_NAME,
    // The directory the CLI itself would use — its own override if the
    // operator set one, else the default. Derived here, never from a request:
    // a caller that could name a directory could point a login at one it does
    // not own.
    config_dir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), ".claude"),
    scope: "local",
    implicit: true,
  };
}

// An account-level fault is human-fixable and lasts until a human fixes it,
// so the quarantine is long. It is cleared early by ground truth: the next
// turn that produces real tokens on that account.
const UNUSABLE_BLOCK_MS = 12 * 3600 * 1000;
// A cap with no parseable reset time: assume the shortest real window rather
// than blocking indefinitely on a guess.
const DEFAULT_BLOCK_MS = 30 * 60 * 1000;

const FAMILIES = ["fable", "opus", "sonnet", "haiku"];
// Order in which we look for a model family that IS routable when the
// requested one is not. Opus heads it deliberately: it is the most capable
// alternate, and falling back should cost capability last.
const PREFERRED_ALTERNATES = ["opus", "sonnet", "haiku", "fable"];

// ── model family ─────────────────────────────────────────────────────────────

// An empty/unknown model means the CLI default — we do not know which model
// that resolves to, so it maps to "default": only account-wide caps
// (session / plain weekly) disqualify it, never a model-specific weekly.
function family(model) {
  const m = String(model || "").toLowerCase();
  for (const f of FAMILIES) if (m.includes(f)) return f;
  return "default";
}

// ── config ───────────────────────────────────────────────────────────────────

// Modes, as asked for:
//   "work" — only this machine's own account(s). Byte-for-byte today's
//            behaviour when the file names exactly one account.
//   "pool" — this machine's own account FIRST, then the shared ones.
//
// The spill order is not decoration. The local account has exactly one
// consumer, so draining it first is the arrangement that minimises contention
// with the other machine by construction — it reaches a shared account only
// when it has nothing else left. That is also why light advisory coordination
// is enough and a lease is not.
function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")); }
  catch (_e) { return { enabled: false, mode: "work", accounts: [] }; }
  if (!raw || typeof raw !== "object") return { enabled: false, mode: "work", accounts: [] };

  const mode = raw.mode === "pool" ? "pool" : "work";
  const all = Array.isArray(raw.accounts) ? raw.accounts : [];
  const usable = all.filter(a =>
    a && typeof a === "object" &&
    typeof a.name === "string" && a.name &&
    typeof a.config_dir === "string" && a.config_dir &&
    a.enabled !== false);

  // scope: "local" (this machine owns it) | "shared" (the PVE pool owns it).
  // Absent scope means local — a config that predates modes describes one
  // machine's own account, and reading it as shared would silently enrol it
  // in a pool it was never meant to join.
  const scoped = usable.map(a => ({ ...a, scope: a.scope === "shared" ? "shared" : "local" }));
  const local = scoped.filter(a => a.scope === "local");
  const shared = scoped.filter(a => a.scope === "shared");

  const accounts = mode === "pool" ? [...local, ...shared] : local;
  return { enabled: raw.enabled !== false && accounts.length > 0, mode, accounts, all: scoped };
}

// ── state ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH(), "utf8"));
    return (s && typeof s === "object") ? s : {};
  } catch (_e) { return {}; }
}

function saveState(st) {
  // Write through a temp file in the SAME directory and rename: a reader that
  // catches us mid-write would otherwise parse a truncated document, fail,
  // and silently treat every block as absent — i.e. offer a capped account.
  try {
    const p = STATE_PATH();
    const tmp = p + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, p);
  } catch (_e) {}
}

function prune(st, now) {
  now = now || Date.now();
  for (const name of Object.keys(st.blocked || {})) {
    const kept = {};
    for (const [scope, ts] of Object.entries(st.blocked[name] || {})) {
      if (ts > now) kept[scope] = ts;
    }
    if (Object.keys(kept).length) st.blocked[name] = kept;
    else delete st.blocked[name];
  }
}

function isBlocked(st, name, fam, now) {
  now = now || Date.now();
  const blocks = (st.blocked || {})[name] || {};
  for (const [scope, ts] of Object.entries(blocks)) {
    if (ts <= now) continue;
    // "account" is a human-fixable fault (terms / dead login / suspension).
    // It is deliberately NOT model-scoped: a dead login cannot serve anything.
    if (scope === "account") return true;
    if (scope === "session") return true;
    if (scope === "weekly") return true;
    if (scope === "weekly:" + fam) return true;
  }
  return false;
}

// ── selection ────────────────────────────────────────────────────────────────

// Sticky drain: keep using the current head for this family until it caps,
// then move to the next. Deliberately NOT round-robin — spreading every turn
// across accounts empties all of them at once, whereas draining one keeps the
// others whole.
function pickAccount(model, opts) {
  const { exclude = [], prefer = null } = opts || {};
  const cfg = loadConfig();
  if (!cfg.enabled) return null;
  const ex = new Set(exclude);
  const fam = family(model);
  const st = loadState();
  prune(st);

  const byName = new Map(cfg.accounts.map(a => [a.name, a]));
  const order = cfg.accounts.map(a => a.name);
  const head = ((st.head || {})[fam]);

  // Pinned account first, then the sticky head, then registry order. A pin
  // falls through to the drain when it is blocked, so pinning can never wedge
  // you when that account caps.
  const candidates = [];
  if (prefer && byName.has(prefer)) candidates.push(prefer);
  if (head && byName.has(head) && head !== prefer) candidates.push(head);
  for (const n of order) if (n !== head && n !== prefer) candidates.push(n);

  for (const name of candidates) {
    if (ex.has(name)) continue;
    if (isBlocked(st, name, fam)) continue;
    st.head = st.head || {};
    st.head[fam] = name;
    saveState(st);
    return byName.get(name);
  }
  return null;
}

// The first alternate family an account can ACTUALLY serve right now, with the
// account that would serve it.
//
// This asks a different question from "is the current family capped fleet-wide"
// and the difference is the whole reason it exists. An account can hold plenty
// of Fable budget and still be unusable for THIS turn — its login expired, or
// it was already tried. A fleet-wide check answers "no alternate needed" about
// a turn that has just run out of accounts, and the caller dead-ends. Here the
// caller has ALREADY proven the current family is unroutable, so the only
// remaining question is what else is routable — answered by actually routing,
// since pickAccount is the one authority on that and therefore cannot disagree
// with the routing that follows.
//
// `exclude` is deliberately NOT defaulted to the turn's tried-accounts list:
// "tried and failed for Fable" does not mean "unusable for Opus", and every
// real disqualification is already in state and honoured by pickAccount.
function pickAlternate(currentModel, opts) {
  const { exclude = undefined } = opts || {};
  const cur = family(currentModel);
  for (const fam of PREFERRED_ALTERNATES) {
    if (fam === cur) continue;
    const a = pickAccount(fam, { exclude });
    if (a) return { family: fam, account: a };
  }
  return null;
}

// ── marking ──────────────────────────────────────────────────────────────────

function markBlocked(name, model, limitInfo) {
  const st = loadState();
  let scope = (limitInfo && limitInfo.scope) || "session";
  if (scope.startsWith("weekly:model")) scope = "weekly:" + family(model);
  const ts = (limitInfo && limitInfo.resetTs) || (Date.now() + DEFAULT_BLOCK_MS);
  st.blocked = st.blocked || {};
  st.blocked[name] = st.blocked[name] || {};
  st.blocked[name][scope] = ts;
  saveState(st);
  return scope;
}

function markAccountUnusable(name, info) {
  const st = loadState();
  st.blocked = st.blocked || {};
  st.blocked[name] = st.blocked[name] || {};
  st.blocked[name].account = Date.now() + UNUSABLE_BLOCK_MS;
  st.unusable = st.unusable || {};
  st.unusable[name] = { reason: (info && info.reason) || "unknown", at: Date.now() };
  saveState(st);
}

function noteOk(name, model) {
  const st = loadState();
  st.last = st.last || {};
  st.last[name] = { ok_at: Date.now(), model: model || "default" };
  // A successful turn is ground truth: it proves the session window is open
  // and the login is alive, whatever we believed a moment ago. Clearing these
  // is what stops a phantom block from starving an account that recovered.
  if (st.blocked && st.blocked[name]) {
    delete st.blocked[name].session;
    delete st.blocked[name].account;
    if (!Object.keys(st.blocked[name]).length) delete st.blocked[name];
  }
  if (st.unusable) delete st.unusable[name];
  saveState(st);
}

// A login that provably succeeded is ground truth about the CREDENTIAL — and
// about nothing else.
//
// ⚠️ THIS IS DELIBERATELY NOT noteOk(). A completed turn proves the session
// window is open AND the login is alive, so it clears both; a login proves
// only the second. Reusing noteOk here would silently hand back a 5-hour or
// weekly cap that is still genuinely in force, and the router would offer an
// account that cannot serve — the failure this whole file exists to avoid,
// arriving from the other direction.
//
// The measured defect it closes (work-laptop, 2026-09-24): the work account
// renewed cleanly — /auth/accounts read `state: ok`, expiry 2026-10-22 —
// while /accounts still read `available:false, unusable:"auth_expired"`, a
// verdict recorded at 07:30:53Z, HOURS before the login, on the 12 h
// UNUSABLE_BLOCK_MS. Nothing could clear it: noteOk's only caller is the
// bridge AFTER a successful turn, and the block is precisely what stops the
// router ever picking the account, so it stood the full twelve hours with a
// perfectly good credential behind it.
//
// `last` is deliberately NOT stamped: no turn ran, and ok_at means a turn did.
function noteCredentialRenewed(name) {
  const st = loadState();
  if (st.blocked && st.blocked[name]) {
    // ONLY the auth quarantine. `session` / `weekly` / `weekly:<family>` are
    // usage facts a login says nothing about.
    delete st.blocked[name].account;
    if (!Object.keys(st.blocked[name]).length) delete st.blocked[name];
  }
  if (st.unusable) delete st.unusable[name];
  saveState(st);
}

// ── detection ────────────────────────────────────────────────────────────────
// Patterns are ported VERBATIM from the PVE router. Two bridges that classify
// the same CLI output differently is how one machine fails over and its twin
// dead-ends on the identical message.

const LIMIT_RE = new RegExp(
  "(hit your (session|usage|weekly)? ?limit|usage limit reached" +
  "|weekly limit|rate.?limit(ed)? " +
  // Per-MODEL pool exhaustion phrases the CLI uses, e.g. "You've reached your
  // Fable 5 limit. Run /usage-credits to continue or switch models with
  // /model." These match none of the alternatives above, so without them a
  // model cap falls past both the limit and the transient branches and
  // surfaces as a bare non-zero exit with no account switch — even with a
  // fully idle account available.
  "|reached your [^.\\n]{0,60}limit|/usage-credits" +
  "|switch models with /model)", "i");

// Signals that a limit is scoped to ONE model family rather than the whole
// account — used to pick weekly:<family> over an account-wide session block.
const MODEL_SCOPED_RE = /\b(fable|opus|sonnet|haiku)\b|switch models with \/model|\/usage-credits/i;
const RESET_RE = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

const ACCOUNT_UNUSABLE_RE = new RegExp(
  "updated our consumer terms|accept them in claude\\.ai" +
  "|review the updated terms|action required\\] an update to our" +
  "|invalid api key|authentication[_ ](error|failed)|please run /login" +
  "|oauth (token|session) (has )?expired|refresh token (is )?invalid" +
  "|failed to authenticate|could not be refreshed" +
  "|account (is |has been )?(suspended|disabled|deactivated|banned)" +
  "|disabled claude subscription access", "i");

function parseReset(text) {
  const m = RESET_RE.exec(text || "");
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2] || "0", 10);
  const ampm = (m[3] || "").toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  else if (ampm === "am" && hour === 12) hour = 0;
  const now = new Date();
  const cand = new Date(now);
  cand.setHours(hour, minute, 0, 0);
  if (cand <= now) cand.setDate(cand.getDate() + 1);
  return cand.getTime();
}

function classifyLimitText(text) {
  // A message naming a model family (or telling you to switch models / buy
  // usage credits) is a PER-MODEL pool, never an account-wide session cap —
  // the account can still serve other families, so blocking it account-wide
  // would needlessly starve it.
  const modelScoped = MODEL_SCOPED_RE.test(text);
  const low = String(text).toLowerCase();
  let scope;
  if (low.includes("week")) scope = modelScoped ? "weekly:model" : "weekly";
  else if (modelScoped) scope = "weekly:model";
  else scope = "session";
  return { scope, resetTs: parseReset(text), raw: String(text).slice(0, 200) };
}

function detectLimit(stdout, stderr, code) {
  let text = "";
  let parsedOk = false;
  try {
    const out = JSON.parse(stdout || "");
    if (out && typeof out === "object") {
      parsedOk = true;
      // A turn that produced a normal result is not a cap, whatever it said.
      if (!out.is_error) return null;
      text = String(out.result || "");
    }
  } catch (_e) { /* not JSON */ }
  if (!parsedOk) {
    // Non-JSON stdout is only meaningful when the process failed — otherwise
    // a turn merely DISCUSSING usage limits would quarantine its own account.
    if (code === 0) return null;
    text = (stdout || "") + "\n" + (stderr || "");
  }
  if (!LIMIT_RE.test(text)) return null;
  return classifyLimitText(text);
}

function detectAccountUnusable(stdout, stderr, code) {
  // Guarded by ground truth: an account that produced REAL tokens on this turn
  // is usable by definition, whatever text it emitted.
  let res = null;
  try {
    const out = JSON.parse(stdout || "");
    if (out && typeof out === "object") res = out;
  } catch (_e) {}
  if (res && res.usage && res.usage.output_tokens) return null;
  if (res && !res.is_error && res.result) return null;

  const hay = [stderr || "", String(stdout || "").slice(-8000)].filter(Boolean).join("\n");
  const m = ACCOUNT_UNUSABLE_RE.exec(hay);
  if (!m) return null;
  const low = m[0].toLowerCase();
  let reason;
  if (low.includes("term") || low.includes("action required")) reason = "terms_not_accepted";
  else if (low.includes("subscription access")) reason = "subscription_access_disabled";
  else if (low.includes("suspend") || low.includes("disabl") ||
           low.includes("deactiv") || low.includes("banned")) reason = "account_suspended";
  else if (low.includes("oauth") || low.includes("refresh") ||
           low.includes("authenticat") || low.includes("/login")) reason = "auth_expired";
  else reason = "auth_invalid";
  return { reason, raw: hay.slice(-300) };
}

// A transient SERVICE failure is not a statement about an account, so it must
// never block one. It earns a re-run of the same turn (a fresh connection),
// not a model change: swapping models here would change the answer for a
// reason that has nothing to do with models.
const TRANSIENT_RE = /\b(529|502|503|504)\b|overloaded|internal server error|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN/i;

function isTransient(stdout, stderr, code) {
  if (code === 0) return false;
  if (detectLimit(stdout, stderr, code)) return false;
  if (detectAccountUnusable(stdout, stderr, code)) return false;
  return TRANSIENT_RE.test((stderr || "") + "\n" + String(stdout || "").slice(-4000));
}

// ── read surface ─────────────────────────────────────────────────────────────

// Shape mirrors the PVE bridge's GET /accounts so the extension's existing
// account pill consumes it unchanged. A field we cannot honestly fill is
// omitted, never guessed — the accounts pill renders headroom, and a number
// invented here would be indistinguishable from a measured one.
function status(model) {
  const cfg = loadConfig();
  const st = loadState();
  prune(st);
  const fam = family(model);
  const accounts = cfg.accounts.map(a => {
    const blocks = (st.blocked || {})[a.name] || {};
    const blocked = isBlocked(st, a.name, fam);
    const un = (st.unusable || {})[a.name] || null;
    let until = 0;
    for (const ts of Object.values(blocks)) if (ts > until) until = ts;
    return {
      name: a.name,
      email: a.email || null,
      scope: a.scope,
      primary: !!a.primary,
      available: !blocked,
      blocked_scopes: Object.keys(blocks),
      blocked_until: until || null,
      unusable: un ? un.reason : null,
      last_ok: ((st.last || {})[a.name] || {}).ok_at || null,
      is_head: ((st.head || {})[fam] === a.name),
    };
  });
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    model_family: fam,
    // How many of the configured accounts can serve THIS family right now.
    // The pill shows "n/m", so both numbers have to come from one evaluation
    // or they can disagree about what they are counting.
    usable: accounts.filter(a => a.available).length,
    total: accounts.length,
    accounts,
  };
}

module.exports = {
  loadConfig, loadState, saveState, prune,
  family, isBlocked,
  pickAccount, pickAlternate,
  markBlocked, markAccountUnusable, noteOk, noteCredentialRenewed,
  detectLimit, detectAccountUnusable, isTransient,
  classifyLimitText, parseReset,
  status,
  ambientAccount, AMBIENT_NAME,
  CONFIG_PATH, STATE_PATH,
  PREFERRED_ALTERNATES, FAMILIES,
  UNUSABLE_BLOCK_MS, DEFAULT_BLOCK_MS,
};

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
const { spawn } = require("child_process");

// ⚠️ ONE-WAY BY DESIGN. `credentials.js` requires nothing of ours, so this
// cannot become a cycle — `auth.js` already requires THIS module, and a cycle
// there would hand one of them a half-initialised copy of the other.
const credentials = require("./credentials");
// Same rule: `claude-spawn.js` requires nothing at all. Every spawn of the
// Claude CLI in this package goes through it, because the Windows cmd-shim
// rule was already paid for once per spawn SITE — `claude auth login` had
// never started on Windows for months while ordinary turns worked.
const claudeSpawn = require("./claude-spawn");

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

// ⚠️ EVERY TIMESTAMP IN `st.blocked` IS MILLISECONDS, AND ONE SOURCE SPEAKS
// SECONDS. `parseReset` and `Date.now()` produce ms; the CLI's own
// `rate_limit_event.rate_limit_info.resetsAt` is epoch SECONDS (the PVE router
// stores it straight into a table it compares against `time.time()`). Mixing
// them does not fail loudly — a seconds value is a date in 1970, so it is
// already in the past, `prune()` drops the block on the next read, and a
// genuinely capped account is offered again immediately. Normalised ONCE, by
// magnitude: no plausible epoch-seconds value this century reaches 1e11.
// (The extension's `acctResetSec` is the mirror of this rule on the other
// side of the wire, and it exists because this one did not.)
function normalizeResetMs(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 0;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

// One tiny turn is enough to read the live rate-limit state, so the probe's
// prompt is the smallest one that still produces a real assistant turn.
const PROBE_PROMPT = "say ok";
// Long enough for a cold CLI start on a laptop, short enough that a wedged
// probe cannot hold a panel button forever.
const PROBE_TIMEOUT_MS = 90 * 1000;
// With no model selected the panel is showing ACCOUNT-WIDE limits, so the
// question is "can this account serve anything at all" — asked with the
// cheapest model there is. When a model IS selected the probe uses THAT model,
// because "haiku said ok" is a true and useless answer about a Fable cap.
const PROBE_DEFAULT_MODEL = "haiku";

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
  const declared = Array.isArray(raw.accounts) ? raw.accounts : [];
  const wellFormed = declared.filter(a =>
    a && typeof a === "object" &&
    typeof a.name === "string" && a.name &&
    typeof a.config_dir === "string" && a.config_dir);

  // scope: "local" (this machine owns it) | "shared" (the PVE pool owns it).
  // Absent scope means local — a config that predates modes describes one
  // machine's own account, and reading it as shared would silently enrol it
  // in a pool it was never meant to join.
  //
  // ⚠️ `enabled` is RESOLVED TO AN EXPLICIT BOOLEAN HERE, once. It used to be
  // applied as a filter and then discarded, so every consumer had to re-derive
  // it from `a.enabled !== false` — and the read surface, which never did,
  // reported no on/off state at all. One fact, one home.
  const scoped = wellFormed.map(a => ({
    ...a,
    scope: a.scope === "shared" ? "shared" : "local",
    enabled: a.enabled !== false,
  }));

  const inMode = (list) => mode === "pool"
    ? [...list.filter(a => a.scope === "local"), ...list.filter(a => a.scope === "shared")]
    : list.filter(a => a.scope === "local");

  // THREE lists, three different questions, and conflating them is what hid
  // the on/off state:
  //   visible  — what this machine's panel should SHOW (mode-scoped)
  //   accounts — what the router may USE (mode-scoped AND enabled)
  //   all      — every configured account, whatever its mode or switch
  //
  // ⚠️ `all` NOW INCLUDES DISABLED ACCOUNTS, and its two consumers want that.
  // `sessionRoots` reads transcripts: switching an account off stops it taking
  // work, it does not hide its history. `renewable` offers login renewal:
  // a disabled account whose login cannot be renewed would be a trap, since
  // renewing it is exactly what you do before switching it back on.
  const visible = inMode(scoped);
  const accounts = visible.filter((a) => a.enabled);
  return { enabled: raw.enabled !== false && accounts.length > 0, mode, accounts, visible, all: scoped };
}

// Atomic replace, in the file's OWN directory — rename(2) is atomic only
// within one filesystem, and a half-written accounts file is a machine that
// cannot route at all.
function writeConfigRaw(raw) {
  const p = CONFIG_PATH();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.accounts.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  try { fs.chmodSync(tmp, 0o600); } catch (_e) {}
  fs.renameSync(tmp, p);
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
  // ⚠️ THE KNOWN-RESET SIDECAR IS RECONCILED HERE AND NOWHERE ELSE.
  // `st.reset_known[name][scope] = true` records that a block's timestamp came
  // from a source that CALLS IT A RESET (the CLI's own "resets 4am" text, or a
  // `rate_limit_event.resetsAt`) rather than from the `+30 min` retry-deadline
  // fallback. It is a SIDECAR rather than a richer value in `st.blocked`
  // because five functions iterate that table as bare numbers and compare
  // `ts > now`; turning its values into objects would make every one of them
  // silently truthy — every account permanently blocked.
  //
  // Reconciling by INTERSECTION in the one function every reader already calls
  // is what makes the two tables incapable of drifting: `noteOk`,
  // `noteCredentialRenewed` and `prune` itself all delete scopes, and a
  // sidecar cleaned at each of those sites would be three more places to
  // forget. An orphan can survive in the FILE; it can never be READ.
  if (st.reset_known) {
    for (const name of Object.keys(st.reset_known)) {
      const live = (st.blocked || {})[name] || {};
      const kept = {};
      for (const scope of Object.keys(st.reset_known[name] || {})) {
        if (st.reset_known[name][scope] && live[scope]) kept[scope] = true;
      }
      if (Object.keys(kept).length) st.reset_known[name] = kept;
      else delete st.reset_known[name];
    }
    if (!Object.keys(st.reset_known).length) delete st.reset_known;
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

// Record ONE block into an already-loaded state object. Split out so that the
// probe path and the failed-turn path cannot disagree about how a block is
// written — including whether its timestamp is a real reset.
//
// ⚠️ `known` IS A SEPARATE ARGUMENT FROM `ts` ON PURPOSE. Both callers can
// produce a usable number; only one of them can produce a number the SOURCE
// calls a reset. Deriving known-ness from the number itself is impossible —
// `Date.now() + 30 min` and a genuine reset 30 minutes out are the same value.
function applyBlock(st, name, scope, ts, known) {
  st.blocked = st.blocked || {};
  st.blocked[name] = st.blocked[name] || {};
  st.blocked[name][scope] = ts;
  if (known) {
    st.reset_known = st.reset_known || {};
    st.reset_known[name] = st.reset_known[name] || {};
    st.reset_known[name][scope] = true;
  } else if (st.reset_known && st.reset_known[name]) {
    // A later block on the SAME scope with an unknown reset must not inherit
    // the earlier one's credibility — the new timestamp is the one that will be
    // rendered, so the claim has to follow the number that replaced it.
    delete st.reset_known[name][scope];
  }
  return scope;
}

function markBlocked(name, model, limitInfo) {
  const st = loadState();
  let scope = (limitInfo && limitInfo.scope) || "session";
  if (scope.startsWith("weekly:model")) scope = "weekly:" + family(model);
  // ⚠️ THIS IS WHERE A REAL RESET WAS BEING THROWN AWAY. `classifyLimitText`
  // already runs `parseReset` over the CLI's own words, so when the refusal
  // says "resets 4am" this bridge HAS the reset — it just stored it in the same
  // field, indistinguishable from the `+30 min` guess, and the panel therefore
  // had to refuse to show either. Recorded as known now, so the one case where
  // a laptop can honestly state a reset time finally does.
  const parsed = limitInfo && limitInfo.resetTs ? normalizeResetMs(limitInfo.resetTs) : 0;
  const ts = parsed || (Date.now() + DEFAULT_BLOCK_MS);
  applyBlock(st, name, scope, ts, !!parsed);
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

// ── the live check: one real turn, on purpose ────────────────────────────────
//
// Hanan, 2026-09-30: *"maybe we can add test button so its actually test if the
// account is good?"* — and on this bridge there was nothing at all: `probe`
// appeared nowhere in the package, so the extension's "⚡ Live check" reached a
// handler that reads only `model`, spun, and returned byte-identical rows.
//
// ⚠️ "IS IT GOOD" IS THE WEAKEST OF THE THREE THINGS THIS DOES. The other two
// are the reason it is worth a real turn:
//   1. `rate_limit_event.resetsAt` from a turn that actually ran is the ONLY
//      source of a REAL reset time on a machine with no usage poller. Every
//      `blocked_until` this bridge has ever written was either a parsed "resets
//      4am" out of the refusal text or the `+30 min` retry deadline — and all
//      five values measured on the work laptop were the latter, so nobody there
//      could say when an account frees up.
//   2. A successful probe CLEARS A STALE BLOCK EARLY. The retry deadline stands
//      for a full 30 minutes even if the cap lifted five minutes in, and an
//      `account` quarantine lasts twelve hours with nothing able to clear it
//      but a turn the router refuses to send. This is the explicit escape
//      hatch, the same role the PVE router's own comment gives it.
//
// ⚠️ AND IT IS NOT SIDE-EFFECT-FREE, WHICH IS STATED RATHER THAN HIDDEN. A
// probe IS a real turn against the window being measured, and a probe that is
// REFUSED legitimately records a block — that is how the router learns, and it
// means a click can mark an account as capped. The caller surfaces that; it is
// not smoothed over here.
//
// ⚠️ THIS DOES NOT AND MUST NOT BECOME A USAGE READING. It answers pass/fail at
// one moment plus, when the service volunteers it, a reset. A percentage here
// would be the poller this package deliberately does not have (accounts.js:12),
// arrived at from a different direction.

// One probe per account at a time. A panel button is easy to click twice, and
// two concurrent turns on one account both spend budget to answer one question.
const _probing = new Set();

function probeInFlight(name) { return _probing.has(name); }

// Everything the probe learned, as BOUNDED tokens. Deliberately no raw CLI text
// in the record: it is rendered in a panel, and a refusal message can quote a
// prompt back. The reasons a row needs to say something different about are
// already separate fields (`unusable`, `blocked_scopes`).
function probeRecord(extra) {
  return Object.assign({
    at: Date.now(), ok: null, model: null, family: null,
    reason: null, scope: null, reset_at: null, reset_known: false,
    duration_ms: null, status: null, limit_type: null, windows: null,
  }, extra || {});
}

// ⚠️ MEASURED, AND IT REVERSED WHAT I HAD JUST TOLD HANAN. I said a probe
// "cannot measure headroom and must never render as a percentage". The CLI's
// own `rate_limit_event` on an ALLOWED turn says otherwise — captured live on
// acct2, 2026-09-30:
//
//   { status: "allowed_warning", rateLimitType: "seven_day",
//     resetsAt: 1791345600, utilization: 0.27, isUsingOverage: false,
//     unifiedWindows: { five_hour:  { utilization: 0.62, resetsAt: 1790776800 },
//                       seven_day: { utilization: 0.27, resetsAt: 1791345600 } } }
//
// So one tiny turn yields the exact figures claude.ai shows — 5-hour 62 %,
// weekly 27 %, both real resets — WITHOUT touching Anthropic's usage endpoint,
// which is the thing that 429s a fleet and is why the poller was never shipped
// here. The rule behind my caution survives in the only form the evidence
// supports: this is a reading AT A MOMENT, on ONE account, and it must be
// rendered with its timestamp and never as a live figure.
//
// ⚠️ AND A FIFTH UNIT DIVERGENCE, CAUGHT BEFORE IT SHIPPED. `utilization` here
// is a FRACTION (0.62); every consumer of the PVE bridge's `utilization.*.percent`
// reads 0-100. Rendering 0.62 as "1%" would be a confident, wrong, reassuring
// number on the one screen where that is most dangerous. Converted ONCE.
//
// ⚠️ AND THE WIRE UNIT FOR A RESET IS SECONDS, because that is what the PVE
// bridge has always sent and what the extension's `*_resets_at` readers expect.
// State keeps milliseconds (it compares against `Date.now()`); the conversion
// lives here and in `status()`, nowhere else. `blocked_until` remains
// milliseconds for compatibility and the client normalises it by magnitude —
// this is the field that taught us the lesson, not a licence to add a sixth.
function probeWindows(rl) {
  const uw = (rl && rl.unifiedWindows) || null;
  if (!uw || typeof uw !== "object") return null;
  const out = {};
  for (const key of Object.keys(uw)) {
    const w = uw[key];
    if (!w || typeof w !== "object") continue;
    const frac = Number(w.utilization);
    out[key] = {
      percent: Number.isFinite(frac) ? Math.round(Math.max(0, Math.min(1, frac)) * 100) : null,
      resets_at: normalizeResetMs(w.resetsAt) ? Math.floor(normalizeResetMs(w.resetsAt) / 1000) : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

// ⚠️ A RESET TIME AND A PERCENTAGE GO STALE DIFFERENTLY, SO THEY ARE STORED
// DIFFERENTLY. A percentage is a measurement and is only true at the moment it
// was taken — it stays inside the dated `probe` record. The 5-hour window's
// reset is a FUTURE APPOINTMENT: it remains true until it passes, so it is kept
// under the name the PVE bridge already uses for it (`window.session_resets_at`)
// and served as `window_resets_at`, which the extension has rendered for months.
// One fact, the existing home — not a second field meaning the same thing.
function rememberWindow(st, name, wins) {
  const sec = wins && wins.five_hour && wins.five_hour.resets_at;
  if (!sec) return;
  st.window = st.window || {};
  st.window[name] = { session_resets_at: sec * 1000, at: Date.now() };
}

function saveProbe(name, rec, mutate) {
  const st = loadState();
  if (typeof mutate === "function") mutate(st);
  st.probe = st.probe || {};
  st.probe[name] = rec;
  saveState(st);
  return rec;
}

// `claudeBin` is an ARGUMENT. accounts.js has never resolved the CLI path and
// must not start: bridge.js resolves it once per process (and prefers the
// Windows `.cmd` shim deliberately), so reading it from the environment here
// would be a second, quieter answer to a question that already has one.
async function probe(opts) {
  const { name, claudeBin, model = null, timeoutMs = PROBE_TIMEOUT_MS } = opts || {};
  if (!name) return { ok: false, error: "account name is required", code: "bad_request" };
  if (!claudeBin) return { ok: false, error: "the Claude CLI path was not supplied", code: "no_cli" };

  const cfg = loadConfig();
  // ⚠️ `all`, NOT `accounts` — a switched-off account is exactly the one you
  // want to test BEFORE switching it back on, and an account outside the
  // current mode still has a row in the panel.
  const account = (cfg.all || []).find((a) => a.name === name);
  if (!account) return { ok: false, error: "unknown account", code: "unknown_account" };

  // ⚠️ REFUSED RATHER THAN ATTEMPTED WHEN THERE IS NO CREDENTIAL AT ALL. `claude
  // -p` against an empty config dir does not fail fast — it tries to begin an
  // interactive login and sits there, so the probe would burn its whole timeout
  // to report something `credentials.credStatus` already knows for free. An
  // EXPIRED login is deliberately still probed: that is the useful case, since
  // the probe is how you confirm a renewal took.
  const cred = credentials.credStatus(account);
  if (cred.present !== true) {
    return {
      ok: false, code: "no_login",
      error: "this account has no login on this machine, so there is nothing to test — sign in for it first",
    };
  }

  if (_probing.has(name)) {
    return { ok: false, code: "probe_in_flight", error: "a live check is already running on this account" };
  }

  const fam = model ? family(model) : "default";
  // The model actually put on the command line. With no selection we ask the
  // cheapest model rather than the configured default, because the question
  // being asked account-wide is "can this serve anything at all".
  const modelArg = model && fam !== "default" ? fam : PROBE_DEFAULT_MODEL;
  const probeFam = family(modelArg);

  const args = ["-p", "--model", modelArg,
                "--output-format", "stream-json", "--verbose", PROBE_PROMPT];
  const tgt = claudeSpawn.buildSpawn(claudeBin, args);

  _probing.add(name);
  const started = Date.now();
  let res;
  try {
    res = await new Promise((done) => {
      let proc;
      try {
        proc = spawn(tgt.bin, tgt.args, {
          env: { ...process.env, CLAUDE_CONFIG_DIR: account.config_dir },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        return done({ spawnError: true, stderr: e.message || String(e) });
      }
      let out = "", err = "", settled = false;
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); done(v); };
      const timer = setTimeout(() => {
        try { proc.kill(); } catch (_e) {}
        finish({ timedOut: true, stdout: out, stderr: err });
      }, timeoutMs);
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => finish({ code, stdout: out, stderr: err }));
      proc.on("error", (e) => finish({ spawnError: true, stdout: out, stderr: e.message || String(e) }));
    });
  } finally {
    _probing.delete(name);
  }

  const duration = Date.now() - started;

  // ── read the stream ───────────────────────────────────────────────────────
  // Two frames matter. `rate_limit_event` is the whole point: it carries the
  // service's OWN status and reset. `result` says whether the turn completed.
  let rateLimit = null, turnOk = null, errText = "";
  for (const line of String(res.stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_e) { continue; }
    if (!o || typeof o !== "object") continue;
    if (o.type === "rate_limit_event" && o.rate_limit_info) rateLimit = o.rate_limit_info;
    else if (o.type === "result") {
      turnOk = !o.is_error;
      if (o.is_error) errText = String(o.result || "");
    }
  }
  if (res.spawnError || res.timedOut) turnOk = false;
  if (!errText) errText = String(res.stderr || "");

  // ── 1. the service told us outright ───────────────────────────────────────
  if (rateLimit && rateLimit.status === "rejected") {
    const scope = rateLimit.rateLimitType === "weekly"
      ? (probeFam === "default" ? "weekly" : "weekly:" + probeFam)
      : "session";
    const realReset = normalizeResetMs(rateLimit.resetsAt);
    const ts = realReset || (Date.now() + DEFAULT_BLOCK_MS);
    const wins = probeWindows(rateLimit);
    return saveProbe(name, probeRecord({
      ok: false, model: modelArg, family: probeFam, reason: "rate_limited",
      scope, reset_at: realReset ? Math.floor(realReset / 1000) : null,
      reset_known: !!realReset, duration_ms: duration,
      status: rateLimit.status || null,
      limit_type: rateLimit.rateLimitType || null,
      windows: wins,
    }), (st) => {
      applyBlock(st, name, scope, ts, !!realReset);
      rememberWindow(st, name, wins);
    });
  }

  // ── 2. it completed ───────────────────────────────────────────────────────
  if (turnOk === true) {
    // A completed turn is GROUND TRUTH about this account, and about exactly
    // as much as it proves. It clears the 5-hour window, the human-fixable
    // account quarantine, and the weekly cap for THE FAMILY IT ACTUALLY RAN —
    // and no other family. "haiku served a turn" says nothing whatever about a
    // `weekly:fable` cap, and clearing it would hand the router an account it
    // would immediately be refused on, which is the failure this file exists
    // to avoid arriving from the friendly direction.
    const cleared = [];
    const wins = probeWindows(rateLimit);
    const topMs = normalizeResetMs(rateLimit && rateLimit.resetsAt);
    return saveProbe(name, probeRecord({
      ok: true, model: modelArg, family: probeFam, duration_ms: duration,
      status: (rateLimit && rateLimit.status) || null,
      // ⚠️ THE TOP-LEVEL `resetsAt` IS NOT A NAMELESS "reset" — it belongs to
      // whichever window is currently binding, which the service states in
      // `rateLimitType`. Storing it without that name is how one fact starts
      // being rendered as another: on acct2 it was the SEVEN-DAY reset, a week
      // out, and a row that printed it beside "5h window" would have been off
      // by six days. The per-window figures below are the ones to render.
      limit_type: (rateLimit && rateLimit.rateLimitType) || null,
      reset_at: topMs ? Math.floor(topMs / 1000) : null,
      reset_known: !!topMs,
      windows: wins,
      // Passed through because it is what EXPLAINS the pair of seven-day
      // figures the service sends (acct2: `seven_day` 27 % beside
      // `seven_day_overage_included` 54 %). Without it the two read as a
      // contradiction rather than as base usage and usage-with-overage.
      is_using_overage: !!(rateLimit && rateLimit.isUsingOverage),
      cleared,
    }), (st) => {
      const blocks = st.blocked && st.blocked[name];
      if (blocks) {
        for (const s of ["session", "account", "weekly:" + probeFam]) {
          if (blocks[s]) { delete blocks[s]; cleared.push(s); }
        }
        if (!Object.keys(blocks).length) delete st.blocked[name];
      }
      if (st.unusable && st.unusable[name]) { delete st.unusable[name]; cleared.push("unusable"); }
      st.last = st.last || {};
      st.last[name] = { ok_at: Date.now(), model: modelArg + " (live check)" };
      rememberWindow(st, name, wins);
    });
  }

  // ── 3. it failed, and the reason is only in the text ──────────────────────
  // ⚠️ GATED ON `LIMIT_RE` FIRST, WHICH THE PVE PROBE'S SHAPE HIDES. Its
  // Python classifier returns None for text that is not a limit; this one
  // ALWAYS returns an object, so handing it a network error would have recorded
  // a `session` block against a perfectly healthy account — a live check that
  // takes an account out because the wifi dropped.
  if (errText && LIMIT_RE.test(errText)) {
    const lim = classifyLimitText(errText);
    let scope = lim.scope;
    if (scope.startsWith("weekly:model")) scope = "weekly:" + probeFam;
    const parsed = lim.resetTs ? normalizeResetMs(lim.resetTs) : 0;
    const ts = parsed || (Date.now() + DEFAULT_BLOCK_MS);
    return saveProbe(name, probeRecord({
      ok: false, model: modelArg, family: probeFam, reason: "rate_limited",
      scope, reset_at: ts, reset_known: !!parsed, duration_ms: duration,
    }), (st) => applyBlock(st, name, scope, ts, !!parsed));
  }

  const unusable = detectAccountUnusable(res.stdout, res.stderr, res.code);
  if (unusable) {
    return saveProbe(name, probeRecord({
      ok: false, model: modelArg, family: probeFam,
      reason: "account_unusable", scope: "account", duration_ms: duration,
      detail: unusable.reason,
    }), (st) => {
      applyBlock(st, name, "account", Date.now() + UNUSABLE_BLOCK_MS, false);
      st.unusable = st.unusable || {};
      st.unusable[name] = { reason: unusable.reason, at: Date.now() };
    });
  }

  // ── 4. it failed and said nothing about this account ──────────────────────
  // A timeout, a spawn failure, an overloaded service. NOTHING IS RECORDED: a
  // transient service fault is not a statement about an account, and a live
  // check that blocks an account for a 529 would be worse than no button. The
  // result still says the probe did not pass, because it did not.
  return saveProbe(name, probeRecord({
    ok: false, model: modelArg, family: probeFam, duration_ms: duration,
    reason: res.timedOut ? "timeout"
          : res.spawnError ? "spawn_failed"
          : isTransient(res.stdout, res.stderr, res.code) ? "transient"
          : "failed_unexplained",
  }));
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
  // ⚠️ VISIBLE, not routable. Reporting only the routable set meant a switched-
  // off account VANISHED from the panel — leaving no row to switch it back on
  // from, so the only way back was to edit the file by hand.
  const accounts = (cfg.visible || cfg.accounts).map(a => {
    const blocks = (st.blocked || {})[a.name] || {};
    const blocked = isBlocked(st, a.name, fam);
    const un = (st.unusable || {})[a.name] || null;
    // ⚠️ `until` AND ITS CREDIBILITY ARE DERIVED FROM THE SAME ENTRY, IN ONE
    // PASS. The panel renders a clock only when the bridge says the number is a
    // reset, so answering "is any of them known" separately from "which one is
    // the latest" would let it show the max timestamp under the credibility of
    // a different scope — a `+30 min` retry deadline printed as a reset because
    // some OTHER scope happened to have a real one.
    const known = (st.reset_known || {})[a.name] || {};
    let until = 0, untilKnown = false;
    for (const [scope, ts] of Object.entries(blocks)) {
      if (ts > until) { until = ts; untilKnown = known[scope] === true; }
    }
    // ⚠️ A ROUTABLE ACCOUNT IS NOT THE SAME FACT AS A USABLE LOGIN, and this
    // line used to answer only the first. `available: !blocked` is a statement
    // about the block table — true for an account that has never been signed
    // in on this machine, because nothing has failed on it yet. Measured on
    // the work laptop: five accounts, zero blocks, "5 of 5 can serve a turn
    // right now", three of them with no credentials file at all.
    //
    // ORDER IS THE CONTRACT — the login is asked FIRST. A dead login and a
    // usage cap are both reasons an account cannot serve, but they have
    // different remedies (sign in / wait), and a cap recorded against an
    // account that cannot authenticate is the less useful of the two to
    // report.
    const cred = credentials.credStatus(a);
    const loginReason = credentials.loginUnavailableReason(cred);
    return {
      name: a.name,
      email: a.email || null,
      scope: a.scope,
      primary: !!a.primary,
      // ⚠️ THE FIELD THE CLIENT WAS GUESSING. Its absence made every row read
      // `enabled === undefined`, so the panel labelled a live account "Enable"
      // and withheld the pin from all of them.
      enabled: a.enabled !== false,
      // Now: "the CLI can authenticate as this account AND the router is not
      // holding it back" — which is what every consumer already reads it as.
      available: a.enabled !== false && !loginReason && !blocked,
      // File presence only, matching the PVE bridge's field of the same name,
      // so the extension's existing "not logged in" row works on a laptop too.
      // It is NOT a liveness claim: an expired login still has a file.
      has_credentials: cred.present === true,
      // Which rule declined, as one bounded token — never free text, and never
      // a path. null whenever the account IS available, so a caller cannot
      // report a reason for a healthy account.
      // ⚠️ `disabled` OUTRANKS the login and the cap. Both may also be true,
      // but the operator's own switch is the proximate answer and the only one
      // whose remedy is a click rather than a sign-in or a wait.
      unavailable_reason: a.enabled === false ? "disabled" : (loginReason || (blocked ? "blocked" : null)),
      blocked_scopes: Object.keys(blocks),
      blocked_until: until || null,
      // ⚠️ THE FIELD THE EXTENSION HAS BEEN WAITING FOR. It already honours
      // `blocked_reset_known` and treats its ABSENCE as unknown — deliberately,
      // so an older bridge cannot have an answer invented for it. Until now
      // this bridge never sent it, so a laptop could not state a reset even on
      // the occasions when it genuinely had one (a refusal that printed "resets
      // 4am", and now a live check that read `resetsAt` off the wire).
      blocked_reset_known: untilKnown,
      unusable: un ? un.reason : null,
      last_ok: ((st.last || {})[a.name] || {}).ok_at || null,
      is_head: ((st.head || {})[fam] === a.name),
      // ⚠️ A PROBE RESULT IS DATED, NEVER A STANDING VERDICT. "served a turn at
      // 10:12" is a fact; "this account is good" is a claim about now that no
      // past turn can support. The panel renders the timestamp WITH it for
      // exactly that reason, so the field carries `at` rather than a bare
      // boolean.
      probe: ((st.probe || {})[a.name]) || null,
      probe_in_flight: probeInFlight(a.name),
      // The live 5-hour reset, in SECONDS, under the name both bridges use for
      // it — and dropped once it has passed rather than served as a stale
      // appointment the panel would render as "resets in -3h".
      window_resets_at: (() => {
        const ms = (((st.window || {})[a.name]) || {}).session_resets_at || 0;
        return ms > Date.now() ? Math.floor(ms / 1000) : null;
      })(),
    };
  });
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    model_family: fam,
    // How many of the configured accounts can serve THIS family right now.
    // The pill shows "n/m", so both numbers have to come from one evaluation
    // or they can disagree about what they are counting — which is why this
    // is derived from `available` above rather than recomputed.
    usable: accounts.filter(a => a.available).length,
    total: accounts.length,
    // ⚠️ THE CAPABILITY, STATED BY THE SERVER THAT HAS IT. The panel had to
    // decide whether a live check was possible from a SHAPE fact (does any row
    // carry `usage_known`?), because the alternative was a button that spun and
    // returned identical rows. That inference was right about the old bridge
    // and would be wrong about this one — it reports no usage AND can now
    // probe. A capability is the server's to declare, not the client's to
    // deduce from the absence of something else.
    can_probe: true,
    accounts,
  };
}

// ── mutation: switching an account off, and removing one ────────────────────
//
// ⚠️ THE GUARD IS THE INVARIANT, NOT THE `primary` FLAG. Both bridges used to
// refuse outright on `primary`, which is a proxy for the rule and not the rule:
// it blocks switching off the main account even when four others would remain,
// and it would happily let you switch off the last working one as long as it
// was not the one flagged. What the refusal exists to prevent is ending with
// NOTHING that can serve a turn, so that is what is checked.
//
// ⚠️ AND ONLY WHEN THE ACTION CAUSES IT. If nothing can serve already — every
// login expired, say — switching one more off makes nothing worse, and a guard
// that refuses in a state it cannot improve is an obstacle, not a safeguard.
// So it refuses exactly on the transition from "at least one" to "none".
function servableNames(scoped) {
  return (scoped || [])
    .filter((a) => a.enabled !== false && credentials.loginCanServe(credentials.credStatus(a)))
    .map((a) => a.name);
}

function lastUsableRefusal(cfg, name, verb) {
  const before = servableNames(cfg.all);
  const after = before.filter((n) => n !== name);
  if (before.length === 0 || after.length > 0) return null;
  return {
    ok: false,
    error: `refusing to ${verb} "${name}": it is the only account on this machine that can serve a turn right now`,
    code: "last_usable_account",
    servable: before,
  };
}

function setEnabled(name, enabled) {
  const cfg = loadConfig();
  const target = (cfg.all || []).find((a) => a.name === name);
  if (!target) return { ok: false, error: "unknown account", code: "unknown_account" };
  if (!enabled) {
    const refusal = lastUsableRefusal(cfg, name, "switch off");
    if (refusal) return refusal;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")); }
  catch (e) { return { ok: false, error: "accounts file unreadable", code: "config_unreadable" }; }
  const row = (Array.isArray(raw.accounts) ? raw.accounts : []).find((a) => a && a.name === name);
  if (!row) return { ok: false, error: "unknown account", code: "unknown_account" };
  row.enabled = !!enabled;
  writeConfigRaw(raw);
  const after = loadConfig();
  // ⚠️ ONE LIST, AND IT IS `servable`. This also returned
  // `routable: after.accounts` — the accounts the ROUTER will try, which ignores
  // whether their logins still work. Two lists for what an operator reads as one
  // fact is how a caller picks the wrong one, and one did: the panel read
  // `routable` and would have answered "turns now run on acct1..acct4" about four
  // accounts with dead logins. The question a switch-off raises is what can
  // actually serve, so that is the only list sent — and it is the field the PVE
  // bridge already sent, so the two now agree.
  return { ok: true, name, enabled: !!enabled, servable: servableNames(after.all) };
}

// Unregisters the account from ROUTING. Its credential directory is left
// exactly where it is — removing a row from a list is not a licence to delete
// somebody's login, and re-adding the entry restores it unchanged.
function removeAccount(name) {
  const cfg = loadConfig();
  const target = (cfg.all || []).find((a) => a.name === name);
  if (!target) return { ok: false, error: "unknown account", code: "unknown_account" };
  const refusal = lastUsableRefusal(cfg, name, "remove");
  if (refusal) return refusal;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")); }
  catch (e) { return { ok: false, error: "accounts file unreadable", code: "config_unreadable" }; }
  raw.accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).filter((a) => !(a && a.name === name));
  writeConfigRaw(raw);
  // The router's memory of an account it can no longer be asked about would
  // otherwise outlive it and be re-applied if the name were ever re-added.
  const st = loadState();
  for (const k of ["blocked", "last", "unusable"]) {
    if (st[k] && typeof st[k] === "object") delete st[k][name];
  }
  for (const [fam, n] of Object.entries(st.head || {})) if (n === name) delete st.head[fam];
  saveState(st);
  const after = loadConfig();
  return { ok: true, removed: name, config_dir: target.config_dir,
           servable: servableNames(after.all) };
}

module.exports = {
  loadConfig, loadState, saveState, prune,
  setEnabled, removeAccount, servableNames,
  family, isBlocked,
  pickAccount, pickAlternate,
  markBlocked, markAccountUnusable, noteOk, noteCredentialRenewed,
  applyBlock, normalizeResetMs,
  detectLimit, detectAccountUnusable, isTransient,
  classifyLimitText, parseReset,
  status,
  probe, probeInFlight,
  PROBE_TIMEOUT_MS, PROBE_DEFAULT_MODEL, PROBE_PROMPT,
  ambientAccount, AMBIENT_NAME,
  CONFIG_PATH, STATE_PATH,
  PREFERRED_ALTERNATES, FAMILIES,
  UNUSABLE_BLOCK_MS, DEFAULT_BLOCK_MS,
};

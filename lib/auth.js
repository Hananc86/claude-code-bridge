"use strict";
// ── Machine-local login renewal ──────────────────────────────────────────────
//
// WHAT THIS CLOSES. A Claude login lasts about a month (measured: refresh
// tokens 21–27 days out, and the expiry does NOT reset when the short-lived
// access token refreshes). Renewing one needs a browser and a human, so it
// cannot be automated away — but on every machine that is not the PVE host it
// could not be STARTED either. `claude-auth.cohenscloud.com` is bound
// vmbr1-only and cannot reach a laptop at all, so a dying login there is
// discovered when something fails.
//
// THE CREDENTIAL NEVER TRAVELS. The login runs HERE, on the machine that will
// own the token, and the only thing that crosses the wire is the ONE-TIME CODE
// the operator pastes — short-lived, single-use, and already pasted over the
// network by the existing console today. Nothing is copied between machines;
// each machine logs itself in. That is what makes "sent, not saved" true by
// construction rather than by discipline.
//
// THE FLOW IS OWNED BY THIS PROCESS, and that is the whole reason the PVE
// console works. A code is bound by PKCE to the exact `claude auth login`
// process that minted its URL: an operator with two browser tabs open will
// otherwise paste a code from the older one, and a server that does not hold
// the flow cannot tell. It is checked against the state of the process that is
// ACTUALLY waiting, and a mismatch is refused WITH AN EXPLANATION — that exact
// failure cost three round-trips by hand before the console existed.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");

const accounts = require("./accounts");

// A PKCE flow older than this is useless — the verifier is gone and any code
// minted against it can never be exchanged. A dead flow LEFT IN THE TABLE is
// worse than no flow: it answers a pasted code with a state that can never
// match, which reads as "you pasted the wrong code".
const FLOW_TTL_MS = 30 * 60 * 1000;

// `CODE#STATE` — the shape the CLI prints. Checked before anything is spawned
// or written, so a paste of the whole URL (a common slip) is refused with a
// sentence instead of being fed to a waiting process.
const CODE_RE = /^[A-Za-z0-9_-]{16,128}#[A-Za-z0-9_-]{16,128}$/;
const URL_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\S*/;

const flows = new Map();   // account name -> {proc, logPath, state, url, started}

function runDir() {
  const d = path.join(os.tmpdir(), "claude-bridge-auth");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ── account status ───────────────────────────────────────────────────────────

// ⚠️ `claude auth status` is a FALSE GREEN — it reads the local file and never
// validates against the server, and has reported `loggedIn: true` for an
// account whose refresh token had expired hours earlier. The only honest signal
// is `refreshTokenExpiresAt`, and EMPTY tokens mean an already-dead account
// (the CLI wipes both after a rejected refresh).
function credStatus(account) {
  const p = path.join(account.config_dir, ".credentials.json");
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    return { readable: false, reason: e.code === "ENOENT" ? "never_logged_in" : "unreadable" };
  }
  const o = (raw && raw.claudeAiOauth) || {};
  // Wiped tokens are a DISTINCT state from a missing file: the account was
  // logged in and the server rejected its refresh.
  if (!o.refreshToken && !o.accessToken) {
    return { readable: true, state: "wiped", reason: "tokens_wiped_after_rejected_refresh" };
  }
  const exp = Number(o.refreshTokenExpiresAt) || 0;
  if (!exp) return { readable: true, state: "unknown", reason: "no_expiry_recorded" };
  const daysLeft = Math.floor((exp - Date.now()) / 86400000);
  let state;
  if (exp <= Date.now()) state = "expired";
  else if (daysLeft <= 5) state = "expiring";
  else state = "ok";
  return { readable: true, state, expires_at: new Date(exp).toISOString(), days_left: daysLeft };
}

// The read surface. Carries expiry FACTS and never a token, a fragment of one,
// or a config-dir path the caller could later echo back as a target.
function listAccounts() {
  const cfg = accounts.loadConfig();
  const now = Date.now();
  const list = (cfg.all || cfg.accounts || []).map(a => {
    const st = credStatus(a);
    const f = flows.get(a.name);
    return {
      name: a.name,
      email: a.email || null,
      scope: a.scope,
      ...st,
      // A flow this process is holding, so the UI can offer "paste the code"
      // rather than starting a second one and killing the first.
      login_waiting: !!(f && now - f.started < FLOW_TTL_MS),
      state_tail: f ? String(f.state || "").slice(-10) : null,
    };
  });
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    // The one number that decides whether anything needs doing today.
    needs_attention: list.filter(a =>
      !a.readable || a.state === "expired" || a.state === "expiring" || a.state === "wiped").length,
    accounts: list,
  };
}

// ── flows ────────────────────────────────────────────────────────────────────

function killFlow(f) {
  // EXACT pid, never a pattern. A pattern kill on a shared PID namespace
  // reaches into processes that have nothing to do with us.
  try { if (f.proc.stdin) f.proc.stdin.end(); } catch (_e) {}
  try { process.kill(f.proc.pid, "SIGTERM"); } catch (_e) {}
}

function reap() {
  const now = Date.now();
  for (const [name, f] of [...flows]) {
    if (now - f.started > FLOW_TTL_MS || f.proc.exitCode !== null || f.proc.signalCode) {
      if (f.proc.exitCode === null && !f.proc.signalCode) killFlow(f);
      flows.delete(name);
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Start a login for ONE account, named. The config dir comes from THIS
// MACHINE'S OWN accounts file and never from the request — a caller that could
// name a directory could point a login at somewhere it does not own.
async function startFlow(name, claudeBin) {
  const cfg = accounts.loadConfig();
  const a = (cfg.all || cfg.accounts || []).find(x => x.name === name);
  if (!a) return { ok: false, error: "unknown account" };

  // ⚠️ The CLI self-updates in place and its path is briefly missing while the
  // package is swapped. Spawning into that window fails on a perfectly healthy
  // machine, so wait it out rather than reporting a broken install.
  const bin = claudeBin || process.env.CLAUDE_BIN || "claude";
  if (path.isAbsolute(bin)) {
    const end = Date.now() + 45000;
    let ready = false;
    while (Date.now() < end) {
      try { fs.accessSync(bin, fs.constants.X_OK); ready = true; break; } catch (_e) {}
      await sleep(1500);
    }
    if (!ready) {
      return { ok: false, error:
        `the Claude CLI is unavailable (${bin}) — it may be mid-update; try again in a minute` };
    }
  }

  reap();
  const old = flows.get(name);
  if (old) { flows.delete(name); killFlow(old); }  // a superseded flow's URL is dead

  // ⚠️ The name reaches a PATH JOIN. Today it can only be a key from this
  // machine's own accounts file, because the lookup above refuses anything
  // else — but that makes the safety of this line depend on a guard twenty
  // lines away, and a later "be lenient about unknown names" refactor would
  // silently turn it into a caller-controlled path. Bound it here too.
  const logName = String(a.name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "account";
  const logPath = path.join(runDir(), logName + ".log");
  try { fs.unlinkSync(logPath); } catch (_e) {}
  const lf = fs.openSync(logPath, "w", 0o600);

  const args = ["auth", "login"];
  if (a.email) args.push("--email", a.email);

  let proc;
  try {
    // stdin is an ORDINARY PIPE the parent holds open. `claude auth login`
    // blocks on stdin for the whole time the operator is in the browser, so
    // the write end has to survive across HTTP requests — which the parent
    // holding it does for free.
    proc = spawn(bin, args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: a.config_dir },
      stdio: ["pipe", lf, lf],
      detached: true,
      windowsHide: true,
    });
  } catch (e) {
    try { fs.closeSync(lf); } catch (_e) {}
    return { ok: false, error: "could not start the login: " + (e.message || String(e)) };
  }
  try { fs.closeSync(lf); } catch (_e) {}

  let url = null;
  for (let i = 0; i < 40; i++) {           // ~20 s; the CLI prints the URL early
    await sleep(500);
    let txt = "";
    try { txt = fs.readFileSync(logPath, "utf8"); } catch (_e) {}
    const m = URL_RE.exec(txt);
    if (m) { url = m[0]; break; }
    if (proc.exitCode !== null) break;
  }
  if (!url) {
    killFlow({ proc });
    let tail = "";
    try { tail = fs.readFileSync(logPath, "utf8").slice(-300); } catch (_e) {}
    return { ok: false, error: "the CLI did not produce a login URL", detail: tail };
  }

  const sm = /state=([^&\s]+)/.exec(url);
  const state = sm ? sm[1] : "";
  flows.set(name, { proc, logPath, state, url, started: Date.now() });
  console.error("[auth] login flow started for %s (state ...%s)", name, state.slice(-10));
  // `state_tail` lets the UI tell the operator WHICH code this flow will take,
  // so a stale browser tab is visible before it wastes a round trip.
  return { ok: true, url, state_tail: state.slice(-10) };
}

async function submitCode(name, code) {
  code = String(code || "").trim();
  if (!CODE_RE.test(code)) {
    return { ok: false, error: "that does not look like a login code — expected CODE#STATE" };
  }
  reap();
  const f = flows.get(name);
  if (!f) {
    return { ok: false, error: "no login is waiting for this account — start one first" };
  }
  const got = code.split("#", 2)[1];
  if (got !== f.state) {
    // THE FAILURE THIS CHECK EXISTS FOR: a code minted in an older browser tab
    // is bound to a flow whose PKCE verifier is gone. Exchanging it cannot
    // work, and saying so beats a generic failure from the CLI.
    return { ok: false, error:
      `this code belongs to an older login (state ...${got.slice(-10)}, this flow expects ` +
      `...${f.state.slice(-10)}). Close the old Claude tab and use the current link.` };
  }
  try {
    f.proc.stdin.write(code + "\n");
  } catch (e) {
    return { ok: false, error: "could not deliver the code: " + (e.message || String(e)) };
  }

  for (let i = 0; i < 50; i++) {           // ~25 s
    await sleep(500);
    let txt = "";
    try { txt = fs.readFileSync(f.logPath, "utf8"); } catch (_e) {}
    if (txt.includes("Login successful")) {
      flows.delete(name);
      const cfg = accounts.loadConfig();
      const a = (cfg.all || cfg.accounts || []).find(x => x.name === name);
      console.error("[auth] login OK for %s", name);
      // The status is re-READ from disk, never assumed — the point of the
      // whole exercise is the new expiry, and reporting an assumed one would
      // make a half-failed login look complete.
      return { ok: true, status: a ? credStatus(a) : null };
    }
    if (f.proc.exitCode !== null) {
      flows.delete(name);
      return { ok: false, error: "the login exited without succeeding", detail: txt.slice(-300) };
    }
  }
  return { ok: false, error: "timed out waiting for the login to complete" };
}

function cancelFlow(name) {
  const f = flows.get(name);
  if (!f) return { ok: true, cancelled: false };
  flows.delete(name);
  killFlow(f);
  return { ok: true, cancelled: true };
}

module.exports = {
  listAccounts, credStatus,
  startFlow, submitCode, cancelFlow, reap,
  FLOW_TTL_MS, CODE_RE, URL_RE,
  _flows: flows,
};

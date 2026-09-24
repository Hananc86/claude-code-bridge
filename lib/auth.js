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
const claudeSpawn = require("./claude-spawn");

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

// ── did this login actually succeed? ─────────────────────────────────────────
//
// ⚠️ SUCCESS IS A FACT ABOUT THE CREDENTIAL, NEVER ABOUT THE CLI'S STDOUT.
// This whole file used to decide by scraping the CLI's output — a URL to prove
// the login STARTED, the words "Login successful" to prove it FINISHED. On
// Windows the CLI writes NOTHING to the redirected handles (measured: a 0-byte
// log through a login that ran correctly and opened a browser), so neither
// question could be answered there and renewal was structurally impossible.
// Scraping prose is fragile everywhere besides — the wording is not ours.
function credFingerprint(account) {
  const p = path.join(account.config_dir, ".credentials.json");
  let st;
  try { st = fs.statSync(p); } catch (_e) { return null; }
  let exp = 0;
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    exp = Number(o && o.claudeAiOauth && o.claudeAiOauth.refreshTokenExpiresAt) || 0;
  } catch (_e) {}
  return { mtimeMs: st.mtimeMs, exp };
}

// ⚠️ A FILE THAT MERELY CHANGED IS NOT A LOGIN. The short-lived access token
// refreshes in place and rewrites `.credentials.json` with no human involved,
// so mtime alone would report a renewal that never happened — and the point of
// this whole exercise is the new expiry. `refreshTokenExpiresAt` does NOT move
// on a refresh (measured: 21–27 day gaps between file write and expiry), so a
// MOVED EXPIRY is exactly "a human just signed in", and a credential where
// there was none is the other way in.
function credAdvanced(before, after) {
  if (!after) return false;
  if (!before) return true;
  return after.exp > before.exp;
}

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
// THE SET THIS MACHINE CAN RENEW IS NOT THE SET IT CAN ROUTE BETWEEN, and
// conflating them is what made renewal unreachable on the machine that needed
// it most. Routing requires an accounts file; a login does not. When the file
// names nothing usable, the ambient login stands in — reported as implicit,
// with routing untouched and still off.
//
// ONE resolver, consumed by the read surface AND the renew path. Two lookups
// would eventually let the UI offer a row that `startFlow` then refuses as an
// unknown account — a button that reports a capability it does not have.
function renewable() {
  const cfg = accounts.loadConfig();
  const named = cfg.all || cfg.accounts || [];
  return { cfg, list: named.length ? named : [accounts.ambientAccount()] };
}

function listAccounts() {
  // ⚠️ SETTLE FIRST. A browser-completed login produces no code to submit and
  // no output to read, so THIS POLL is the only thing that will ever notice it
  // finished. Without the reap the account correctly flips to `ok` while
  // `login_waiting` stays true forever, and the UI keeps offering a paste box
  // for a login that is already done.
  reap();
  const { cfg, list: subjects } = renewable();
  const now = Date.now();
  const list = subjects.map(a => {
    const st = credStatus(a);
    const f = flows.get(a.name);
    return {
      name: a.name,
      email: a.email || null,
      scope: a.scope,
      // Stated, not inferred from its absence elsewhere: this row is the
      // machine's own login rather than a configured account, so a UI can say
      // so instead of implying routing exists.
      implicit: !!a.implicit,
      ...st,
      // A flow this process is holding, so the UI can offer "paste the code"
      // rather than starting a second one and killing the first.
      login_waiting: !!(f && now - f.started < FLOW_TTL_MS),
      state_tail: f ? String(f.state || "").slice(-10) : null,
    };
  });
  return {
    // ⚠️ ON THIS SURFACE `enabled` MEANS RENEWAL IS AVAILABLE HERE — the same
    // thing the PVE bridge's `/auth/accounts` has always meant by it. It used
    // to carry the ROUTING flag, so one word answered two questions and a
    // machine with a login but no accounts file reported itself as having
    // neither. Routing keeps its own answer, below and on `/accounts`.
    enabled: list.length > 0,
    routing: cfg.enabled,
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
    // A flow whose credential ADVANCED has succeeded, whatever it printed —
    // which is the ONLY way a browser-completed login (no code, no output) can
    // ever be settled. Settle it WITHOUT killing: the CLI exits on its own
    // after writing, and signalling it mid-write is how a successful login
    // becomes a corrupt credential file.
    if (f.account && credAdvanced(f.credBefore, credFingerprint(f.account))) {
      flows.delete(name);
      console.error("[auth] login completed for %s (credential advanced)", name);
      continue;
    }
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
  const a = renewable().list.find(x => x.name === name);
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
  // Taken BEFORE the spawn, or "did a new credential land?" has no baseline to
  // ask against and a login that was already valid would read as one that just
  // succeeded.
  const credBefore = credFingerprint(a);

  const logName = String(a.name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "account";
  const logPath = path.join(runDir(), logName + ".log");
  try { fs.unlinkSync(logPath); } catch (_e) {}
  const lf = fs.openSync(logPath, "w", 0o600);

  const args = ["auth", "login"];
  if (a.email) args.push("--email", a.email);

  // ⚠️ WINDOWS: `bin` is `claude.cmd`, a BATCH SHIM that bin/cli.js picks on
  // purpose — and spawning one DIRECTLY throws EINVAL on every currently
  // supported Node. This spawn used to do exactly that, so login renewal had
  // never once started on a Windows machine while ordinary turns worked fine;
  // the failure surfaced as "could not start the login: spawn EINVAL" from the
  // catch below, which reads like a broken account rather than a command that
  // was never legal to run. The shim rule now has ONE home (./claude-spawn).
  const tgt = claudeSpawn.buildSpawn(bin, args);

  // The email lands on cmd.exe's command line, which is RE-PARSED. It comes
  // from this machine's own accounts file rather than from the request, but
  // that makes the safety of this line depend on where that file came from —
  // the same reasoning already applied to `name` one screen up. Refuse with a
  // sentence instead of shipping a mangled command line and reading the
  // wreckage as a CLI failure.
  if (tgt.shim && args.some((x) => claudeSpawn.CMD_META_RE.test(String(x)))) {
    try { fs.closeSync(lf); } catch (_e) {}
    return { ok: false, error:
      "this account's email contains a character cmd.exe would reinterpret " +
      "(% & | < > ^ \") — correct it in the accounts file and try again" };
  }

  let proc;
  try {
    // stdin is an ORDINARY PIPE the parent holds open. `claude auth login`
    // blocks on stdin for the whole time the operator is in the browser, so
    // the write end has to survive across HTTP requests — which the parent
    // holding it does for free. cmd.exe /c passes stdin through to the shim's
    // child, so the pipe still reaches the CLI on Windows.
    proc = spawn(tgt.bin, tgt.args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: a.config_dir },
      stdio: ["pipe", lf, lf],
      // ⚠️ ON WINDOWS `detached: true` MEANS `DETACHED_PROCESS` — the child is
      // given NO CONSOLE AT ALL. That is the leading explanation for the 0-byte
      // log: the CLI's renderer has nowhere to draw and writes nothing to the
      // redirected handles. We do not need the child to outlive us here (we
      // hold its stdin for the whole flow), so the flag buys nothing on Windows
      // and costs the only output we had.
      // On POSIX it STAYS: there it is setsid, matching the PVE console's own
      // `start_new_session=True`, so a signal aimed at the bridge's process
      // group does not take a login in progress with it.
      // ⚠️ This is a HYPOTHESIS about the empty log, not a measurement — the
      // guarantee is that nothing below depends on the log any more.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (e) {
    try { fs.closeSync(lf); } catch (_e) {}
    return { ok: false, error: "could not start the login: " + (e.message || String(e)) };
  }
  try { fs.closeSync(lf); } catch (_e) {}

  let url = null, done = false;
  for (let i = 0; i < 40; i++) {           // ~20 s; the CLI prints the URL early
    await sleep(500);
    let txt = "";
    try { txt = fs.readFileSync(logPath, "utf8"); } catch (_e) {}
    const m = URL_RE.exec(txt);
    if (m) { url = m[0]; break; }
    // The whole flow can be OVER before this loop ends: when the CLI can open
    // a browser it runs its own localhost callback, so there is never a code
    // and never a link for us to hand anyone.
    if (credAdvanced(credBefore, credFingerprint(a))) { done = true; break; }
    if (proc.exitCode !== null) break;
  }

  if (done) {
    console.error("[auth] login completed for %s during start (browser callback)", name);
    return { ok: true, completed: true, url: null, awaiting: null, status: credStatus(a) };
  }

  if (!url) {
    // ⚠️ THE DEFECT THIS BRANCH EXISTS FOR: it used to `killFlow` here. On
    // Windows the CLI opens the sign-in page ITSELF and prints nothing, so the
    // bridge DESTROYED a login the operator was in the middle of completing,
    // twenty seconds in, and reported `the CLI did not produce a login URL`
    // with an empty detail — which reads like a broken account rather than a
    // link we simply could not see.
    // A RUNNING PROCESS IS NOT A FAILED LOGIN. Only an EXITED one is.
    if (proc.exitCode !== null) {
      let tail = "";
      try { tail = fs.readFileSync(logPath, "utf8").slice(-300); } catch (_e) {}
      return { ok: false, error: "the login exited without producing a link", detail: tail };
    }
    flows.set(name, { proc, logPath, state: null, url: null,
                      started: Date.now(), credBefore, account: a });
    console.error("[auth] login flow started for %s (no link printed — browser opened locally)", name);
    return {
      ok: true, url: null, state_tail: null,
      awaiting: "browser",
      note: "The Claude CLI opened the sign-in page in a browser on that machine — " +
            "finish it there. If it shows you a code, paste it below; if it completes " +
            "on its own, the new expiry appears here within a few seconds.",
    };
  }

  const sm = /state=([^&\s]+)/.exec(url);
  const state = sm ? sm[1] : "";
  flows.set(name, { proc, logPath, state, url, started: Date.now(), credBefore, account: a });
  console.error("[auth] login flow started for %s (state ...%s)", name, state.slice(-10));
  // `state_tail` lets the UI tell the operator WHICH code this flow will take,
  // so a stale browser tab is visible before it wastes a round trip.
  return { ok: true, url, state_tail: state.slice(-10), awaiting: "code" };
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
  // ⚠️ WHEN THE CLI PRINTED NOTHING THERE IS NO STATE TO COMPARE AGAINST, so
  // this guard has no subject and is SKIPPED rather than made to invent one.
  // What is lost is the precise sentence, not the refusal: this is a UX guard,
  // never a security one — the CLI holds the PKCE verifier and refuses a
  // foreign code itself. Comparing against a state we do not have would turn
  // every paste on Windows into "you pasted the wrong code", which is the exact
  // failure the guard was written to prevent.
  if (f.state && got !== f.state) {
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

  // The SAME resolver the flow was started from, in ONE place rather than at
  // each of the three sites that need it. A second lookup that did not know
  // about the ambient login would report `status: null` after a renewal that
  // genuinely succeeded — the operator renews, and the one number they came
  // for is missing.
  const resolve = () => renewable().list.find(x => x.name === name);

  for (let i = 0; i < 50; i++) {           // ~25 s
    await sleep(500);
    let txt = "";
    try { txt = fs.readFileSync(f.logPath, "utf8"); } catch (_e) {}
    const a = resolve();
    // ⚠️ THE CREDENTIAL IS ASKED FIRST, because on Windows the log is empty and
    // the prose branch can never fire there. Both are kept: the text is the
    // faster signal when it exists, the credential is the one that is always
    // true, and `confirmed_by` says which answered so a silent regression in
    // either is visible rather than masked by the other.
    const advanced = !!(a && credAdvanced(f.credBefore, credFingerprint(a)));
    if (advanced || txt.includes("Login successful")) {
      flows.delete(name);
      console.error("[auth] login OK for %s (%s)", name, advanced ? "credential" : "cli_output");
      // The status is re-READ from disk, never assumed — the point of the
      // whole exercise is the new expiry, and reporting an assumed one would
      // make a half-failed login look complete.
      return { ok: true, status: a ? credStatus(a) : null,
               confirmed_by: advanced ? "credential" : "cli_output" };
    }
    if (f.proc.exitCode !== null) {
      // ⚠️ RE-ASK BEFORE DECLARING FAILURE. The CLI writes the credential and
      // THEN exits, so observing the exit first is a race, not a verdict —
      // and reporting a successful login as a failed one is the worse error of
      // the two (the operator renews again, against an account that is fine).
      await sleep(400);
      const a2 = resolve();
      if (a2 && credAdvanced(f.credBefore, credFingerprint(a2))) {
        flows.delete(name);
        console.error("[auth] login OK for %s (credential, seen after exit)", name);
        return { ok: true, status: credStatus(a2), confirmed_by: "credential" };
      }
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

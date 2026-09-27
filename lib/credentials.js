"use strict";
// ── The ONE reader of `.credentials.json` ────────────────────────────────────
//
// WHAT THIS CLOSES. `GET /accounts` reported `available: !blocked` — a
// statement about the ROUTER's block table and nothing else — so an account
// that had never been signed in on this machine counted as ready to serve.
// Measured on the work laptop in pool mode: five accounts, zero blocks,
// `usable: 5, total: 5`, while three of them had no credentials file at all
// and could not run a single turn. The pill's own tooltip says "N of M
// accounts can serve a turn right now"; the number under it was counting
// something else.
//
// It is not merely cosmetic. `pickAccount` does not consult credentials
// either, so the router offers such an account, the turn fails, failover
// quarantines it for 12 h — and when that block expires the count reads 5/5
// again. The overstatement is a state the machine keeps returning to.
//
// ⚠️ WHY THIS IS ITS OWN MODULE. `auth.js` already read this file for the
// renewal surface and `accounts.js` now needs the same fact for the readiness
// count. Requiring `auth.js` from `accounts.js` would be a cycle (auth.js
// calls accounts.loadConfig), and Node resolves a cycle by handing back a
// half-initialised module — a failure that shows up as `undefined is not a
// function` somewhere unrelated. But the cycle is the smaller reason: TWO
// readers of this file would eventually disagree about what "wiped" means,
// and then the readiness count and the login line three pixels below it would
// contradict each other about the same account on the same screen.
//
// ⚠️ `claude auth status` IS A FALSE GREEN and is deliberately not used: it
// reads this same file and never validates against the server, and has
// reported `loggedIn: true` for an account whose refresh token had expired
// hours earlier. The only honest signal is `refreshTokenExpiresAt`, and EMPTY
// tokens mean an already-dead account (the CLI wipes both after a rejected
// refresh).

const fs = require("fs");
const path = require("path");

// The vocabulary a bridge may put on the wire as `unavailable_reason`. Bounded
// on purpose: it is rendered by the extension, and a free-text reason from a
// credential path is how a directory name reaches a UI.
//
// ⚠️ `disabled` is NOT in this list. The Node bridge's `loadConfig` filters
// `enabled: false` accounts out of the routable set before `status()` ever
// sees them, so a reason it cannot emit would be dead preparedness — the
// defect class this file exists to avoid. The PVE bridge DOES list disabled
// accounts and declares that member itself.
const UNAVAILABLE_REASONS = Object.freeze([
  "no_login",          // no credentials file: never signed in on this machine
  "login_wiped",       // both tokens cleared after a rejected refresh
  "login_expired",     // refreshTokenExpiresAt is in the past
  "login_unreadable",  // the file exists and cannot be parsed
  "blocked",           // a usage cap / account quarantine (see `blocked[]`)
]);

function credPath(account) {
  return path.join(account.config_dir, ".credentials.json");
}

// Facts only. No token, no fragment of one, and no path — a caller that could
// echo a config directory back is a caller that can point a login at one it
// does not own.
function credStatus(account, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(credPath(account), "utf8")); }
  catch (e) {
    // present:false vs present:true is the difference between "never signed
    // in here" and "signed in, and the file is now damaged" — two different
    // things to tell an operator, and two different remedies.
    return e.code === "ENOENT"
      ? { readable: false, present: false, reason: "never_logged_in" }
      : { readable: false, present: true, reason: "unreadable" };
  }
  const o = (raw && raw.claudeAiOauth) || {};
  // Wiped tokens are a DISTINCT state from a missing file: the account WAS
  // logged in and the server rejected its refresh.
  if (!o.refreshToken && !o.accessToken) {
    return { readable: true, present: true, state: "wiped",
             reason: "tokens_wiped_after_rejected_refresh" };
  }
  const exp = Number(o.refreshTokenExpiresAt) || 0;
  if (!exp) return { readable: true, present: true, state: "unknown",
                     reason: "no_expiry_recorded" };
  const daysLeft = Math.floor((exp - now) / 86400000);
  let state;
  if (exp <= now) state = "expired";
  else if (daysLeft <= 5) state = "expiring";
  else state = "ok";
  return { readable: true, present: true, state,
           expires_at: new Date(exp).toISOString(), days_left: daysLeft };
}

// Can the CLI authenticate as this account RIGHT NOW?
//
// ⚠️ `expiring` COUNTS. A login four days from expiry serves turns today, and
// a fleet a week out from renewal would otherwise report 0 of 5 ready while
// every account worked — the opposite overstatement, and just as wrong.
//
// ⚠️ `unknown` COUNTS, and this is the one place the permissive branch is
// chosen deliberately. Tokens are PRESENT; only the expiry metadata is
// missing, so the positive evidence exists and the CLI will very likely
// authenticate. Calling it unready would red-dot a working account on the
// strength of an absent field.
//
// Everything else does NOT count, including `unreadable`. That file IS the
// credential: a copy the CLI cannot parse is a dead login, not an unknown one
// — and the renewal surface already tells the operator exactly that ("no
// login on file"), so the two surfaces agree instead of arguing.
function loginCanServe(st) {
  if (!st || st.readable !== true) return false;
  return st.state === "ok" || st.state === "expiring" || st.state === "unknown";
}

// The bounded token naming WHY a login cannot serve. Returns null when it can,
// so a caller cannot accidentally report a reason for a healthy account.
function loginUnavailableReason(st) {
  if (loginCanServe(st)) return null;
  if (!st) return "login_unreadable";
  if (st.readable === false) {
    return st.reason === "never_logged_in" ? "no_login" : "login_unreadable";
  }
  if (st.state === "wiped") return "login_wiped";
  if (st.state === "expired") return "login_expired";
  // A state this version does not recognise is reported as unreadable rather
  // than guessed into one of the others — a wrong-but-plausible token is worse
  // than an honest "we cannot confirm this login".
  return "login_unreadable";
}

module.exports = {
  credStatus, loginCanServe, loginUnavailableReason,
  UNAVAILABLE_REASONS, credPath,
};

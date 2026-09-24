"use strict";

// ──────────────────  ONE HOME FOR THE WINDOWS CMD-SHIM RULE  ─────────────────
//
// npm installs the Claude CLI on Windows as `claude.cmd` — a BATCH SHIM — and
// bin/cli.js PREFERS it deliberately (`lines.find(l => l.endsWith(".cmd"))`).
// Since the CVE-2024-27980 hardening (Node >= 18.20.2 / 20.12.2 / 21.7.3)
// child_process.spawn REFUSES to execute a .cmd/.bat directly: it throws
// EINVAL. So a direct spawn of claudeBin on Windows is not "slower" or "quoted
// oddly" — it does not run at all.
//
// ⚠️ THE DEFECT THIS MODULE EXISTS FOR. The rule lived in bridge.js TWICE —
// once as `/\.(cmd|bat)$/i` and once as a `.endsWith(".cmd")` that misses
// `.bat` and `.CMD` — and in auth.js NOT AT ALL. Ordinary turns therefore
// worked on Windows for months while `claude auth login` had never once
// started there: every "Restart login" returned `spawn EINVAL` out of auth.js's
// catch, which reads like a broken account rather than a spawn that was never
// legal. bridge.js already records paying this exact price one ARGUMENT at a
// time — "the lesson was applied to one argument instead of to the rule" — and
// this is that same lesson applied one SPAWN SITE at a time. Every spawn of the
// Claude CLI goes through buildSpawn().

const SHIM_RE = /\.(cmd|bat)$/i;

// ⚠️ `platform` and `comspec` are ARGUMENTS with defaults, never ambient reads.
// A rule that can only be exercised by running on the OS it guards is a rule
// nobody tests from CI — which is exactly how this one stayed wrong on Windows,
// unnoticed, for the entire life of the auth surface.
function isCmdShim(claudeBin, platform = process.platform) {
  return platform === "win32" && SHIM_RE.test(String(claudeBin || ""));
}

// cmd.exe RE-PARSES the command line the shim receives, and a newline TRUNCATES
// it — silently, at line 1. bridge.js learned that twice: once on the prompt,
// then again one argument over when --append-system-prompt became multi-line
// and the trailing --resume/--model were dropped, so every Windows resume
// quietly began a NEW session on the default model with no error to explain it.
// Newlines are meaningless in every value we pass, so they are flattened for
// EVERY shim-bound argument rather than for whichever one last caused an
// incident.
const flattenForCmd = (a) =>
  typeof a === "string" ? a.replace(/\r\n|\r|\n/g, " ") : a;

// The binary that will actually be executed. Split out because the ask path
// resolves it ONCE per turn while rebuilding argv PER ATTEMPT (a model fallback
// rewrites --model, and an earlier inline version that reassigned only the
// local model variable left the original --model on the command line, so the
// "fallback" re-ran the capped model and failed identically).
function spawnBin(claudeBin, opts = {}) {
  if (!isCmdShim(claudeBin, opts.platform || process.platform)) return claudeBin;
  return opts.comspec || process.env.COMSPEC || "cmd.exe";
}

function buildSpawn(claudeBin, args, opts = {}) {
  const platform = opts.platform || process.platform;
  if (!isCmdShim(claudeBin, platform)) {
    return { bin: claudeBin, args, shim: false, flattened: 0 };
  }
  const safe = args.map(flattenForCmd);
  const flattened = args.filter((a, i) => a !== safe[i]).length;
  return {
    bin: spawnBin(claudeBin, opts),
    args: ["/c", claudeBin, ...safe],
    shim: true,
    flattened,
  };
}

// cmd.exe INTERPRETS these, and Node's argv quoting cannot defend against a
// second parse it does not perform. This module deliberately does NOT refuse
// them itself: the ask path puts prompt-shaped values on the command line and
// already neutralises them a different way (an @file for every shim prompt), so
// a refusal here would newly reject turns that work today. Callers that place a
// CONFIGURED value on a shim command line bound it with this and refuse for
// themselves — shared mechanism, caller-owned policy.
const CMD_META_RE = /[%&|<>^"]/;

module.exports = { isCmdShim, buildSpawn, spawnBin, flattenForCmd, SHIM_RE, CMD_META_RE };

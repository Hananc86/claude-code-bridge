#!/usr/bin/env node
"use strict";

const { parseArgs } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { startBridge } = require("../lib/bridge");
const { startRelay } = require("../lib/relay-client");

// ── Pair flow (browser-OTP based auth) ────────────────────────────────────
// When --token isn't supplied, the CLI:
//   1. POSTs /pair-cli/start to the relay's HTTP base (public endpoint)
//   2. Prints the short code + pair URL — user opens it, OTPs into CF Access,
//      confirms in the browser
//   3. Long-polls /pair-cli/claim until the bearer arrives
//   4. Saves the bearer to ~/.claude-bridge/auth.json so subsequent starts
//      pick it up automatically
// Replaces the old workflow of running `claude-relay-ctl provision <m>` on
// the host and copy-pasting a long bearer onto the CLI command line.

function authFilePath() {
  return path.join(os.homedir(), ".claude-bridge", "auth.json");
}

function readAuthFile() {
  try { return JSON.parse(fs.readFileSync(authFilePath(), "utf8")); }
  catch { return { bearers: {} }; }
}

function writeAuthFile(data) {
  const fp = authFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function relayHttpBase(wsUrl) {
  // wss://host/agent/ws → https://host
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}`;
}

async function pairInteractive(relayWsUrl, machine, ephemeral) {
  const base = relayHttpBase(relayWsUrl);
  process.stdout.write(`[bridge] Starting pair flow for "${machine}" against ${base}\n`);
  if (ephemeral) process.stdout.write(`[bridge] Ephemeral mode — bearer will NOT be saved to disk.\n`);

  const startResp = await fetch(`${base}/pair-cli/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });
  if (!startResp.ok) {
    const text = await startResp.text();
    throw new Error(`pair start failed (${startResp.status}): ${text}`);
  }
  const { code, poll_token, pair_url, expires_in } = await startResp.json();

  console.log("\n  ┌─────────────────────────────────────────────────┐");
  console.log("  │  Open this URL in a browser to pair the device  │");
  console.log("  ├─────────────────────────────────────────────────┤");
  console.log(`  │  ${pair_url.padEnd(47)} │`);
  console.log("  │                                                 │");
  console.log(`  │  Confirm this code matches:  ${code.padEnd(17)}│`);
  console.log("  └─────────────────────────────────────────────────┘");
  console.log(`  Code expires in ${expires_in}s. Waiting for confirmation…\n`);

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await fetch(`${base}/pair-cli/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poll_token }),
      });
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    if (resp.status === 202) continue;      // still waiting, re-poll
    if (resp.status === 404 || resp.status === 410) {
      throw new Error("pair expired or invalidated — re-run to start over");
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`pair claim failed (${resp.status}): ${text}`);
    }
    const { bearer, machine: confirmed } = await resp.json();
    if (ephemeral) {
      console.log(`[bridge] ✓ Paired as "${confirmed}" (in-memory only, nothing written to disk).`);
    } else {
      console.log(`[bridge] ✓ Paired as "${confirmed}". Bearer saved to ${authFilePath()}`);
      const auth = readAuthFile();
      auth.bearers = auth.bearers || {};
      auth.bearers[base] = auth.bearers[base] || {};
      auth.bearers[base][confirmed] = bearer;
      writeAuthFile(auth);
    }
    return bearer;
  }
  throw new Error("pair window expired — re-run to start over");
}

function lookupSavedBearer(relayWsUrl, machine) {
  const auth = readAuthFile();
  return auth.bearers?.[relayHttpBase(relayWsUrl)]?.[machine] || null;
}

const HELP = `
claude-code-bridge — Bridge server for Claude Code CLI

Usage:
  claude-code-bridge start [options]        Start the bridge (+ optional relay)
  claude-code-bridge install-service        Register as a system service (auto-start on boot)
  claude-code-bridge uninstall-service      Remove the system service
  claude-code-bridge --help                 Show this help
  claude-code-bridge --version               Print the installed version

Options:
  --port <n>              HTTP port for the local bridge (default: 8091)
  --host <ip>             Bind address (default: 127.0.0.1)
  --token <secret>        Bridge password (use the same in the extension). Auto-generated if omitted.
  --cwd <path>            Default working directory for Claude (default: current dir)
  --claude-bin <path>     Path to claude CLI binary (default: auto-detect)
  --timeout <seconds>     Max time for a single Claude call (default: 10800)

Relay options (connect to a remote relay server):
  --relay-url <url>       WebSocket URL of the relay server
  --machine <name>        Machine name for the relay
  --token <bearer>        Machine bearer (skips both auth.json and pair flow)
  --save-auth             Cache the bearer in ~/.claude-bridge/auth.json so the
                          next start reuses it. Required for unattended /
                          systemd-service installs. WITHOUT this flag the CLI
                          re-pairs (browser OTP) on every start — the default.
  --cf-id <id>            Cloudflare Access Client ID (optional)
  --cf-secret <secret>    Cloudflare Access Client Secret (optional)

Environment variables:
  All options can be set via env vars with BRIDGE_ prefix:
  BRIDGE_PORT, BRIDGE_HOST, BRIDGE_CWD, BRIDGE_TIMEOUT,
  BRIDGE_RELAY_URL, BRIDGE_MACHINE_NAME, BRIDGE_MACHINE_TOKEN,
  BRIDGE_SAVE_AUTH=1 (cache the bearer to ~/.claude-bridge/auth.json
                       for unattended restarts; default re-pairs every
                       start so nothing is persisted),
  BRIDGE_CF_ID, BRIDGE_CF_SECRET
`;

function env(key, def) {
  return process.env["BRIDGE_" + key] || def;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v") || args[0] === "version") {
    console.log(require("../package.json").version);
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];
  if (command === "start") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        port:       { type: "string", default: env("PORT", "8091") },
        host:       { type: "string", default: env("HOST", "127.0.0.1") },
        cwd:        { type: "string", default: env("CWD", process.cwd()) },
        "claude-bin": { type: "string", default: env("CLAUDE_BIN", "") },
        timeout:    { type: "string", default: env("TIMEOUT", "10800") },
        "relay-url":  { type: "string", default: env("RELAY_URL", "") },
        machine:    { type: "string", default: env("MACHINE_NAME", "") },
        token:      { type: "string", default: env("MACHINE_TOKEN", "") },
        "save-auth":{ type: "boolean", default: env("SAVE_AUTH", "") === "1" },
        ephemeral:  { type: "boolean", default: false },  // deprecated, now default behavior — kept as a no-op for compatibility
        "cf-id":    { type: "string", default: env("CF_ID", "") },
        "cf-secret": { type: "string", default: env("CF_SECRET", "") },
      },
      strict: false,
    });

    const config = {
      port: parseInt(values.port, 10),
      host: values.host,
      cwd: values.cwd,
      claudeBin: values["claude-bin"],
      timeout: parseInt(values.timeout, 10) * 1000,
      relay: values["relay-url"] ? {
        url: values["relay-url"],
        machine: values.machine,
        token: values.token,
        // Default = ephemeral (pair on every start, never persist). Opt in
        // to caching with --save-auth when running unattended / as a service.
        // The legacy --ephemeral flag is a no-op (kept for back-compat).
        saveAuth: !!values["save-auth"],
        cfId: values["cf-id"],
        cfSecret: values["cf-secret"],
      } : null,
    };

    const crypto = require("node:crypto");
    if (config.relay) {
      config.bearerToken = crypto.randomBytes(32).toString("hex");
    } else {
      config.bearerToken = values.token || crypto.randomBytes(32).toString("hex");
    }

    run(config);
  } else if (command === "install-service") {
    installService();
  } else if (command === "uninstall-service") {
    uninstallService();
  } else {
    console.error(`Unknown command: ${command}\nRun claude-code-bridge --help`);
    process.exit(1);
  }
}

async function run(config) {
  console.log(`[bridge] claude-bridge-cli v${require("../package.json").version}`);
  console.log(`[bridge] Starting on http://${config.host}:${config.port}`);
  console.log(`[bridge] Claude CWD: ${config.cwd}`);

  // Find claude binary
  if (!config.claudeBin) {
    const { execSync } = require("node:child_process");
    try {
      const lines = execSync(
        process.platform === "win32" ? "where claude" : "which claude",
        { encoding: "utf8" }
      ).trim().split(/\r?\n/);
      if (process.platform === "win32") {
        config.claudeBin = lines.find(l => l.endsWith(".cmd")) || lines[0];
      } else {
        config.claudeBin = lines[0];
      }
    } catch {
      console.error("[bridge] ERROR: claude CLI not found. Install it: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
  }
  console.log(`[bridge] Claude CLI: ${config.claudeBin}`);

  // Start bridge HTTP server
  const bridge = await startBridge(config);
  console.log(`[bridge] Bridge ready on http://${config.host}:${config.port}`);
  if (!config.relay) {
    console.log(`[bridge] Bearer token: ${config.bearerToken}`);
    console.log(`[bridge] Use this token when adding the endpoint in the extension.`);
  }

  // Start relay client if configured
  if (config.relay) {
    if (!config.relay.machine) {
      console.error("[bridge] ERROR: --machine required when using --relay-url");
      process.exit(1);
    }
    // Resolve a bearer:
    //   --token            → use it directly (never look at auth.json)
    //   --save-auth        → reuse saved auth.json; pair only if no entry exists
    //   default (no flags) → pair fresh on every start, never read or write
    //                        auth.json (most secure; requires user at the
    //                        keyboard for every launch)
    if (!config.relay.token) {
      const saved = config.relay.saveAuth
        ? lookupSavedBearer(config.relay.url, config.relay.machine)
        : null;
      if (saved) {
        config.relay.token = saved;
        console.log(`[bridge] Using saved bearer from ${authFilePath()}`);
      } else {
        try {
          // ephemeral == NOT saveAuth: don't write back when pair completes.
          config.relay.token = await pairInteractive(
            config.relay.url, config.relay.machine, /* ephemeral */ !config.relay.saveAuth
          );
        } catch (e) {
          console.error(`[bridge] ERROR: ${e.message}`);
          process.exit(1);
        }
      }
    }
    console.log(`[bridge] Connecting to relay as "${config.relay.machine}"...`);
    startRelay(config);
  } else {
    console.log("[bridge] No relay configured — running in local-only mode.");
  }

  // Graceful shutdown
  const cleanup = () => {
    console.log("\n[bridge] Shutting down...");
    bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function installService() {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");

  // Save current args to a config file for the service
  const configPath = path.join(os.homedir(), ".claude-code-bridge.env");
  const args = process.argv.slice(2).filter(a => a !== "install-service");

  if (process.platform === "win32") {
    // Windows: create a scheduled task
    const { execSync } = require("node:child_process");
    const script = `claude-code-bridge start ${args.join(" ")}`;
    const taskCmd = `schtasks /Create /TN "Claude Code Bridge" /TR "cmd /c ${script}" /SC ONLOGON /F /RL HIGHEST`;
    try {
      execSync(taskCmd, { stdio: "inherit" });
      console.log("[bridge] Service installed (Windows Scheduled Task).");
      console.log("[bridge] To remove: claude-code-bridge uninstall-service");
    } catch (e) {
      console.error("[bridge] Failed to create scheduled task:", e.message);
    }
  } else if (process.platform === "darwin") {
    // macOS: launchd
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-code-bridge</string>
  <key>ProgramArguments</key><array><string>claude-code-bridge</string><string>start</string>${args.map(a => `<string>${a}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>`;
    const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.claude-code-bridge.plist");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    try { require("node:child_process").execSync(`launchctl load -w "${plistPath}"`); } catch {}
    console.log("[bridge] Service installed (macOS LaunchAgent).");
  } else {
    // Linux: systemd user unit
    const unit = `[Unit]
Description=Claude Code Bridge
After=network-online.target

[Service]
Type=simple
ExecStart=claude-code-bridge start ${args.join(" ")}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target`;
    const unitDir = path.join(os.homedir(), ".config/systemd/user");
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, "claude-code-bridge.service"), unit);
    try {
      const { execSync } = require("node:child_process");
      execSync("systemctl --user daemon-reload");
      execSync("systemctl --user enable claude-code-bridge.service");
      console.log("[bridge] Service installed (systemd user unit).");
    } catch {}
  }
}

function uninstallService() {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");

  if (process.platform === "win32") {
    try {
      require("node:child_process").execSync('schtasks /Delete /TN "Claude Code Bridge" /F', { stdio: "inherit" });
    } catch {}
    console.log("[bridge] Service removed (Windows).");
  } else if (process.platform === "darwin") {
    const p = path.join(os.homedir(), "Library/LaunchAgents/com.claude-code-bridge.plist");
    try { require("node:child_process").execSync(`launchctl unload -w "${p}"`); } catch {}
    try { fs.unlinkSync(p); } catch {}
    console.log("[bridge] Service removed (macOS).");
  } else {
    try {
      const { execSync } = require("node:child_process");
      execSync("systemctl --user disable --now claude-code-bridge.service");
      fs.unlinkSync(path.join(os.homedir(), ".config/systemd/user/claude-code-bridge.service"));
      execSync("systemctl --user daemon-reload");
    } catch {}
    console.log("[bridge] Service removed (Linux).");
  }
}

main();

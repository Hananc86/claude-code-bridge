#!/usr/bin/env node
"use strict";

const { parseArgs } = require("node:util");
const { startBridge } = require("../lib/bridge");
const { startRelay } = require("../lib/relay-client");

const HELP = `
claude-code-bridge — Bridge server for Claude Code CLI

Usage:
  claude-code-bridge start [options]        Start the bridge (+ optional relay)
  claude-code-bridge install-service        Register as a system service (auto-start on boot)
  claude-code-bridge uninstall-service      Remove the system service
  claude-code-bridge --help                 Show this help

Options:
  --port <n>              HTTP port for the local bridge (default: 8091)
  --host <ip>             Bind address (default: 127.0.0.1)
  --cwd <path>            Default working directory for Claude (default: current dir)
  --claude-bin <path>     Path to claude CLI binary (default: auto-detect)
  --timeout <seconds>     Max time for a single Claude call (default: 7200)

Relay options (connect to a remote relay server):
  --relay-url <url>       WebSocket URL of the relay server
  --machine <name>        Machine name for the relay
  --token <bearer>        Machine bearer token
  --cf-id <id>            Cloudflare Access Client ID (optional)
  --cf-secret <secret>    Cloudflare Access Client Secret (optional)

Environment variables:
  All options can be set via env vars with BRIDGE_ prefix:
  BRIDGE_PORT, BRIDGE_HOST, BRIDGE_CWD, BRIDGE_TIMEOUT,
  BRIDGE_RELAY_URL, BRIDGE_MACHINE_NAME, BRIDGE_MACHINE_TOKEN,
  BRIDGE_CF_ID, BRIDGE_CF_SECRET
`;

function env(key, def) {
  return process.env["BRIDGE_" + key] || def;
}

function main() {
  const args = process.argv.slice(2);
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
        timeout:    { type: "string", default: env("TIMEOUT", "7200") },
        "relay-url":  { type: "string", default: env("RELAY_URL", "") },
        machine:    { type: "string", default: env("MACHINE_NAME", "") },
        token:      { type: "string", default: env("MACHINE_TOKEN", "") },
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
        cfId: values["cf-id"],
        cfSecret: values["cf-secret"],
      } : null,
    };

    // Generate a random local bearer token for bridge ↔ relay-client auth
    const crypto = require("node:crypto");
    config.bearerToken = crypto.randomBytes(32).toString("hex");

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
  console.log(`[bridge] Starting on http://${config.host}:${config.port}`);
  console.log(`[bridge] Claude CWD: ${config.cwd}`);

  // Find claude binary
  if (!config.claudeBin) {
    const { execSync } = require("node:child_process");
    try {
      config.claudeBin = execSync(
        process.platform === "win32" ? "where claude" : "which claude",
        { encoding: "utf8" }
      ).trim().split("\n")[0];
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
    if (!config.relay.machine || !config.relay.token) {
      console.error("[bridge] ERROR: --machine and --token required when using --relay-url");
      process.exit(1);
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

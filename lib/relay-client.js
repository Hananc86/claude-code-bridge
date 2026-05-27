"use strict";

const WebSocket = require("ws");
const http = require("node:http");

function startRelay(config) {
  const { relay, bearerToken, port, host } = config;
  let backoff = 1000;
  let ws = null;

  function connect() {
    const headers = {};
    if (relay.cfId) headers["CF-Access-Client-Id"] = relay.cfId;
    if (relay.cfSecret) headers["CF-Access-Client-Secret"] = relay.cfSecret;

    ws = new WebSocket(relay.url, { headers });

    ws.on("open", () => {
      console.log("[relay] Connected to relay, sending hello...");
      ws.send(JSON.stringify({ type: "hello", machine: relay.machine, token: relay.token }));
      backoff = 1000;
    });

    ws.on("message", (data) => {
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }

      if (frame.type === "hello_ack") {
        console.log(`[relay] Authenticated as "${relay.machine}" (socket: ${frame.socket_id})`);
        return;
      }

      if (frame.type === "shutdown") {
        console.log("[relay] Received shutdown — exiting.");
        removeService();
        process.exit(0);
      }

      if (frame.type === "cancel") {
        return; // bridge handles its own stop
      }

      if (frame.type === "request") {
        handleRequest(frame);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[relay] Disconnected (${code}). Reconnecting in ${backoff / 1000}s...`);
      setTimeout(connect, backoff);
      backoff = Math.min(60000, backoff * 2);
    });

    ws.on("error", (err) => {
      console.error(`[relay] Error: ${err.message}`);
    });
  }

  function handleRequest(frame) {
    const { requestId, method, path: reqPath, query, body } = frame;

    // Build local HTTP request to the bridge
    const url = new URL(`http://${host || "127.0.0.1"}:${port}${reqPath || "/"}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }

    const reqHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bearerToken}`,
    };

    const reqBody = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method || "GET",
      headers: reqHeaders,
      timeout: 7200000, // 2 hours
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let respBody;
        try { respBody = JSON.parse(data); } catch { respBody = data ? { _raw: data } : null; }
        sendResponse(requestId, res.statusCode, respBody);
      });
    });

    req.on("error", (err) => {
      sendResponse(requestId, 502, { error: `local_bridge_unreachable: ${err.message}` });
    });

    req.on("timeout", () => {
      req.destroy();
      sendResponse(requestId, 504, { error: "local_bridge_timeout" });
    });

    if (reqBody) req.write(reqBody);
    req.end();
  }

  function sendResponse(requestId, status, body) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", requestId, status, body }));
    }
  }

  function removeService() {
    try {
      if (process.platform === "win32") {
        require("node:child_process").execSync('schtasks /Delete /TN "Claude Code Bridge" /F', { stdio: "ignore" });
      } else if (process.platform === "darwin") {
        const p = require("node:path").join(require("node:os").homedir(), "Library/LaunchAgents/com.claude-code-bridge.plist");
        try { require("node:child_process").execSync(`launchctl unload -w "${p}"`, { stdio: "ignore" }); } catch {}
        try { require("node:fs").unlinkSync(p); } catch {}
      } else {
        const { execSync } = require("node:child_process");
        try { execSync("systemctl --user disable --now claude-code-bridge.service", { stdio: "ignore" }); } catch {}
        const unitPath = require("node:path").join(require("node:os").homedir(), ".config/systemd/user/claude-code-bridge.service");
        try { require("node:fs").unlinkSync(unitPath); } catch {}
        try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }); } catch {}
      }
    } catch {}
  }

  connect();
}

module.exports = { startRelay };

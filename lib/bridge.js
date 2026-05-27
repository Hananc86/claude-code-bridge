"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// In-memory session processes (pid → {proc, sessionId})
const running = new Map();

// Data directory for marks, bindings, title overrides, starred
function dataDir(config) {
  const d = path.join(config.cwd || process.cwd(), ".claude-bridge-data");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Simple JSON file helpers
function readJson(filePath, def) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return def; }
}
function writeJson(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// Claude projects dir (where JONSLs live)
function projectsDir() {
  return path.join(process.env.HOME || process.env.USERPROFILE || "~", ".claude", "projects");
}

// List sessions by scanning JSONL files
function listSessions(config, opts = {}) {
  const base = projectsDir();
  if (!fs.existsSync(base)) return [];
  const sessions = [];
  for (const project of fs.readdirSync(base)) {
    const projDir = path.join(base, project);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const file of fs.readdirSync(projDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.replace(".jsonl", "");
      const filePath = path.join(projDir, file);
      const stat = fs.statSync(filePath);
      let preview = "", aiTitle = "", msgCount = 0, lastPrompt = "";
      try {
        const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
        msgCount = lines.length;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "summary" && obj.summary) { preview = preview || obj.summary.slice(0, 200); }
            if (obj.type === "user" && obj.message?.content) {
              const text = typeof obj.message.content === "string" ? obj.message.content : JSON.stringify(obj.message.content);
              if (!preview) preview = text.slice(0, 200);
              lastPrompt = text.slice(0, 200);
            }
            if (obj.type === "result" && obj.result) {
              aiTitle = aiTitle || (obj.result.metadata?.title?.value || "");
            }
          } catch {}
        }
      } catch {}
      sessions.push({
        id, project,
        cwd: projDir,
        mtime: stat.mtimeMs / 1000,
        mtime_iso: stat.mtime.toISOString(),
        preview, ai_title: aiTitle,
        message_count: msgCount,
        last_prompt: lastPrompt,
        size_bytes: stat.size,
      });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);

  // Add starred flag
  const starred = new Set(readJson(path.join(dataDir(config), "starred.json"), []));
  for (const s of sessions) s.starred = starred.has(s.id);
  sessions.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.mtime - a.mtime);

  return sessions;
}

// Get session messages
function getSessionMessages(sessionId) {
  const base = projectsDir();
  for (const project of fs.readdirSync(base)) {
    const filePath = path.join(base, project, sessionId + ".jsonl");
    if (fs.existsSync(filePath)) {
      const messages = [];
      for (const line of fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user" && obj.message?.content) {
            messages.push({ role: "user", text: typeof obj.message.content === "string" ? obj.message.content : JSON.stringify(obj.message.content), timestamp: obj.timestamp });
          } else if (obj.type === "assistant" && obj.message?.content) {
            const parts = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
            const text = parts.map(p => typeof p === "string" ? p : p.text || "").join("");
            if (text) messages.push({ role: "assistant", text, timestamp: obj.timestamp });
          } else if (obj.type === "result" && obj.result?.assistantMessage) {
            const text = typeof obj.result.assistantMessage === "string" ? obj.result.assistantMessage : "";
            if (text) messages.push({ role: "assistant", text, timestamp: obj.timestamp });
          }
        } catch {}
      }
      return { session_id: sessionId, messages };
    }
  }
  return { error: "session not found" };
}

// Run claude -p
function askClaude(config, { prompt, session_id, images, cwd, plan_mode, allow_tools }) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json"];
    if (session_id) args.push("--session-id", session_id);
    if (plan_mode) args.push("--plan");

    const proc = spawn(config.claudeBin, args, {
      cwd: cwd || config.cwd,
      timeout: config.timeout,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    if (session_id) running.set(session_id, proc);

    proc.on("close", (code) => {
      if (session_id) running.delete(session_id);
      try {
        const result = JSON.parse(stdout);
        resolve({
          response: result.result || result.assistantMessage || stdout.slice(0, 5000),
          session_id: result.session_id || session_id || crypto.randomUUID(),
          cost_usd: result.cost_usd || null,
          duration_ms: result.duration_ms || null,
          context: result.context || null,
        });
      } catch {
        if (stdout.trim()) {
          resolve({ response: stdout.trim(), session_id: session_id || crypto.randomUUID() });
        } else {
          resolve({ error: stderr.trim() || `claude exited with code ${code}` });
        }
      }
    });

    proc.on("error", (err) => {
      if (session_id) running.delete(session_id);
      resolve({ error: err.message });
    });
  });
}

// Stop a running session
function stopSession(sessionId) {
  const proc = running.get(sessionId);
  if (!proc) return { stopped: false, reason: "not_running" };
  try { proc.kill("SIGINT"); } catch {}
  setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 3000);
  return { stopped: true };
}

// HTTP server
function startBridge(config) {
  const dd = dataDir(config);

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Confirm-Wipe");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // Auth
    const auth = req.headers.authorization || "";
    if (req.url !== "/health" && auth !== `Bearer ${config.bearerToken}`) {
      send(401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Health
    if (url.pathname === "/health") {
      send(200, { ok: true }); return;
    }

    // Ask
    if (url.pathname === "/ask" && req.method === "POST") {
      const body = await readBody(req);
      const result = await askClaude(config, body);
      send(result.error ? 500 : 200, result);
      return;
    }

    // Sessions list
    if (url.pathname === "/sessions" && req.method === "GET") {
      const includeTiny = url.searchParams.get("include_tiny") === "1";
      let sessions = listSessions(config);
      if (!includeTiny) sessions = sessions.filter(s => s.message_count >= 3);
      send(200, { sessions: sessions.slice(0, 120) });
      return;
    }

    // Starred list
    if (url.pathname === "/sessions/starred" && req.method === "GET") {
      send(200, { starred: readJson(path.join(dd, "starred.json"), []) });
      return;
    }

    // Session messages
    let m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/messages$/);
    if (m && req.method === "GET") {
      const result = getSessionMessages(m[1]);
      send(result.error ? 404 : 200, result);
      return;
    }

    // Star toggle
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/star$/);
    if (m && req.method === "POST") {
      const starred = readJson(path.join(dd, "starred.json"), []);
      const sid = m[1];
      const idx = starred.indexOf(sid);
      if (idx >= 0) { starred.splice(idx, 1); writeJson(path.join(dd, "starred.json"), starred); send(200, { starred: false, session_id: sid }); }
      else { starred.unshift(sid); writeJson(path.join(dd, "starred.json"), starred); send(200, { starred: true, session_id: sid }); }
      return;
    }

    // Stop
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/stop$/);
    if (m && req.method === "POST") {
      send(200, stopSession(m[1]));
      return;
    }

    // Marks
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/marks$/);
    if (m) {
      const marksFile = path.join(dd, "marks.json");
      const allMarks = readJson(marksFile, {});
      if (req.method === "GET") {
        send(200, { marks: allMarks[m[1]] || {} });
        return;
      }
      if (req.method === "PATCH" || req.method === "POST") {
        const body = await readBody(req);
        const sess = allMarks[m[1]] || {};
        for (const [k, v] of Object.entries(body)) {
          sess[k] = { ...(sess[k] || {}), ...v };
        }
        allMarks[m[1]] = sess;
        writeJson(marksFile, allMarks);
        send(200, { ok: true });
        return;
      }
    }

    // Title rename
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/title$/);
    if (m && (req.method === "PATCH" || req.method === "POST")) {
      const body = await readBody(req);
      const overrides = readJson(path.join(dd, "title-overrides.json"), {});
      overrides[m[1]] = body.title || "";
      writeJson(path.join(dd, "title-overrides.json"), overrides);
      send(200, { ok: true, title: body.title });
      return;
    }

    // Bindings
    if (url.pathname === "/chatgpt-bindings") {
      const bindingsFile = path.join(dd, "bindings.json");
      if (req.method === "GET") {
        send(200, { bindings: readJson(bindingsFile, {}) });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const bindings = readJson(bindingsFile, {});
        if (body.conv_id) {
          if (body.session_id) bindings[body.conv_id] = body.session_id;
          else delete bindings[body.conv_id];
          writeJson(bindingsFile, bindings);
        }
        send(200, { bindings });
        return;
      }
    }

    send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}

// Read JSON body
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

module.exports = { startBridge };

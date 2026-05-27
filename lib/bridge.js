"use strict";

const http = require("node:http");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const running = new Map();

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function dataDir() {
  const d = path.join(homeDir(), ".claude-bridge");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJson(filePath, def) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return def; }
}
function writeJson(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function projectsDir() {
  return path.join(homeDir(), ".claude", "projects");
}

// ── Image handling ──

const ALLOWED_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function sanitizeFilename(name, fallbackExt = "png") {
  let base = path.basename(name || "image").replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = path.extname(base).slice(1).toLowerCase();
  if (!ext || !ALLOWED_IMAGE_EXTS.has(ext)) base += "." + fallbackExt;
  return base.slice(0, 200);
}

function saveImages(images, sessionId) {
  if (!Array.isArray(images) || !images.length) return [];
  const dir = path.join(dataDir(), "images", sessionId || "unsorted");
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  const ts = Date.now();
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || !img.data_base64) continue;
    const buf = Buffer.from(img.data_base64, "base64");
    if (buf.length > MAX_IMAGE_BYTES) continue;
    const name = sanitizeFilename(img.name || `image-${i}.png`);
    const filename = `${ts}-${i}-${name}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buf, { mode: 0o600 });
    saved.push(filePath);
  }
  return saved;
}

function splitUserTextAndImages(text) {
  const m = text.match(/\nThe user attached \d+ image\(s\) at these absolute paths\. Use the Read tool to view them:\n([\s\S]+)$/);
  if (!m) return { cleanText: text, imagePaths: [] };
  const cleanText = text.slice(0, m.index).trimEnd();
  const paths = m[1].split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  const imageData = [];
  for (const p of paths) {
    try {
      const buf = fs.readFileSync(p);
      const ext = path.extname(p).slice(1).toLowerCase();
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/png";
      imageData.push({ name: path.basename(p), data_base64: buf.toString("base64"), mime });
    } catch {}
  }
  return { cleanText, imagePaths: paths, imageData };
}

// ── Session scanning ──

function scanSessionFiles() {
  const base = projectsDir();
  if (!fs.existsSync(base)) return [];
  const results = [];
  let dirs;
  try { dirs = fs.readdirSync(base); } catch { return []; }
  for (const project of dirs) {
    const projDir = path.join(base, project);
    let stat;
    try { stat = fs.statSync(projDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(projDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.replace(".jsonl", "");
      const filePath = path.join(projDir, file);
      results.push({ id, project, filePath });
    }
  }
  return results;
}

function looksLikeInternal(text) {
  if (!text) return false;
  const t = text.slice(0, 500);
  return /^\s*\{/.test(t) && /"tool_use_id"|"tool_result"|"is_error"/.test(t);
}

function parseSessionFile(filePath) {
  let preview = "", aiTitle = "", customTitle = "", msgCount = 0, lastPrompt = "";
  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    msgCount = lines.length;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "summary" && obj.summary) preview = preview || obj.summary.slice(0, 200);
        if (obj.type === "user" && obj.message?.content) {
          const text = typeof obj.message.content === "string" ? obj.message.content : JSON.stringify(obj.message.content);
          if (!preview && !looksLikeInternal(text)) preview = text.slice(0, 200);
          if (!looksLikeInternal(text)) lastPrompt = text.slice(0, 200);
        }
        if (obj.type === "result" && obj.result) {
          aiTitle = aiTitle || (obj.result.metadata?.title?.value || "");
        }
        if (obj.type === "ai-title" && obj.title) aiTitle = obj.title;
        if (obj.type === "custom-title" && obj.title) customTitle = obj.title;
      } catch {}
    }
  } catch {}
  return { preview, ai_title: customTitle || aiTitle, message_count: msgCount, last_prompt: lastPrompt };
}

function projectDirToCwd(name) {
  return name.replace(/-/g, "/");
}

function listSessions(opts = {}) {
  const dd = dataDir();
  const files = scanSessionFiles();
  const titleOverrides = readJson(path.join(dd, "title-overrides.json"), {});
  const starred = new Set(readJson(path.join(dd, "starred.json"), []));
  const sessions = [];

  for (const { id, project, filePath } of files) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const parsed = parseSessionFile(filePath);
    if (!opts.includeTiny && parsed.message_count < 3) continue;
    if (opts.project && project !== opts.project) continue;
    const title = titleOverrides[id] || parsed.ai_title;
    sessions.push({
      id, project,
      cwd: projectDirToCwd(project),
      mtime: stat.mtimeMs / 1000,
      mtime_iso: stat.mtime.toISOString(),
      preview: parsed.preview,
      ai_title: title,
      message_count: parsed.message_count,
      last_prompt: parsed.last_prompt,
      size_bytes: stat.size,
      starred: starred.has(id),
      in_progress: running.has(id),
    });
  }

  sessions.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.mtime - a.mtime);
  return sessions.slice(0, opts.limit || 400);
}

// ── Search ──

function searchSessions(query, limit = 30) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const dd = dataDir();
  const titleOverrides = readJson(path.join(dd, "title-overrides.json"), {});
  const starred = new Set(readJson(path.join(dd, "starred.json"), []));
  const files = scanSessionFiles();

  files.sort((a, b) => {
    try {
      return fs.statSync(b.filePath).mtimeMs - fs.statSync(a.filePath).mtimeMs;
    } catch { return 0; }
  });

  const results = [];
  for (const { id, project, filePath } of files.slice(0, 200)) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    let content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch { continue; }

    const lower = content.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) continue;

    const matchCount = lower.split(q).length - 1;
    const snippetStart = Math.max(0, idx - 40);
    const snippetEnd = Math.min(content.length, idx + q.length + 80);
    const snippet = content.slice(snippetStart, snippetEnd).replace(/\n/g, " ").trim();

    let aiTitle = "", msgCount = 0;
    try {
      const lines = content.split("\n").filter(Boolean);
      msgCount = lines.length;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "result" && obj.result?.metadata?.title?.value) {
            aiTitle = obj.result.metadata.title.value;
          }
          if (obj.type === "ai-title" && obj.title) aiTitle = obj.title;
          if (obj.type === "custom-title" && obj.title) aiTitle = obj.title;
        } catch {}
      }
    } catch {}

    results.push({
      id, project,
      cwd: projectDirToCwd(project),
      mtime: stat.mtimeMs / 1000,
      mtime_iso: stat.mtime.toISOString(),
      ai_title: titleOverrides[id] || aiTitle,
      snippet,
      match_count: matchCount,
      message_count: msgCount,
      starred: starred.has(id),
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ── Session messages ──

function getSessionMessages(sessionId) {
  const base = projectsDir();
  let dirs;
  try { dirs = fs.readdirSync(base); } catch { return { error: "session not found" }; }
  for (const project of dirs) {
    const filePath = path.join(base, project, sessionId + ".jsonl");
    if (!fs.existsSync(filePath)) continue;
    const messages = [];
    for (const line of fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && obj.message?.content) {
          let text = typeof obj.message.content === "string" ? obj.message.content : JSON.stringify(obj.message.content);
          const split = splitUserTextAndImages(text);
          messages.push({
            role: "user",
            text: split.cleanText,
            images: split.imageData || [],
            timestamp: obj.timestamp,
          });
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
    return { session_id: sessionId, messages, in_progress: running.has(sessionId) };
  }
  return { error: "session not found" };
}

// ── Session delete / wipe ──

function deleteSession(sessionId) {
  const base = projectsDir();
  let dirs;
  try { dirs = fs.readdirSync(base); } catch { return { error: "not found" }; }
  for (const project of dirs) {
    const filePath = path.join(base, project, sessionId + ".jsonl");
    if (!fs.existsSync(filePath)) continue;
    fs.unlinkSync(filePath);
    const imgDir = path.join(dataDir(), "images", sessionId);
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch {}
    return { deleted: true, session_id: sessionId };
  }
  return { error: "not found" };
}

function wipeAllSessions() {
  const base = projectsDir();
  let removed = 0;
  try {
    for (const project of fs.readdirSync(base)) {
      const projDir = path.join(base, project);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const file of fs.readdirSync(projDir)) {
        if (!file.endsWith(".jsonl")) continue;
        try { fs.unlinkSync(path.join(projDir, file)); removed++; } catch {}
      }
    }
  } catch {}
  const dd = dataDir();
  for (const f of ["marks.json", "bindings.json", "title-overrides.json", "starred.json"]) {
    try { fs.unlinkSync(path.join(dd, f)); } catch {}
  }
  try { fs.rmSync(path.join(dd, "images"), { recursive: true, force: true }); } catch {}
  return { removed_jsonls: removed };
}

// ── Session rename ──

function renameSession(sessionId, title) {
  const dd = dataDir();
  const overrides = readJson(path.join(dd, "title-overrides.json"), {});
  overrides[sessionId] = (title || "").slice(0, 500);
  writeJson(path.join(dd, "title-overrides.json"), overrides);
  return { ok: true, title: overrides[sessionId] };
}

// ── Run claude -p ──

function askClaude(config, { prompt, session_id, images, cwd, plan_mode, allow_tools }) {
  return new Promise((resolve) => {
    let finalPrompt = prompt;
    if (images && images.length) {
      const saved = saveImages(images, session_id || "pending");
      if (saved.length) {
        finalPrompt += `\nThe user attached ${saved.length} image(s) at these absolute paths. Use the Read tool to view them:\n` +
          saved.map(p => `- ${p}`).join("\n");
      }
    }

    const isWin = process.platform === "win32";
    const isCmdShim = isWin && config.claudeBin.endsWith(".cmd");

    // Write prompt to temp file — avoids Windows 8K arg limit and stdin
    // piping issues through cmd.exe. Works on all platforms.
    const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tmpFile, finalPrompt, "utf8");

    const args = ["-p", `@${tmpFile}`, "--output-format", "json"];
    if (session_id) {
      const sessionExists = scanSessionFiles().some(s => s.id === session_id);
      args.push(sessionExists ? "--resume" : "--session-id", session_id);
    }
    if (plan_mode) args.push("--plan");

    const bin = isCmdShim ? process.env.COMSPEC || "cmd.exe" : config.claudeBin;
    const fullArgs = isCmdShim ? ["/c", config.claudeBin, ...args] : args;

    const proc = spawn(bin, fullArgs, {
      cwd: cwd || config.cwd,
      timeout: config.timeout,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    if (session_id) running.set(session_id, proc);

    proc.on("close", (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (session_id) running.delete(session_id);
      try {
        const result = JSON.parse(stdout);
        const sid = result.session_id || session_id || crypto.randomUUID();
        if (images && images.length && session_id === "pending" && sid !== "pending") {
          const oldDir = path.join(dataDir(), "images", "pending");
          const newDir = path.join(dataDir(), "images", sid);
          try { fs.renameSync(oldDir, newDir); } catch {}
        }
        resolve({
          response: result.result || result.assistantMessage || stdout.slice(0, 5000),
          session_id: sid,
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
      try { fs.unlinkSync(tmpFile); } catch {}
      if (session_id) running.delete(session_id);
      resolve({ error: err.message });
    });
  });
}

// ── Stop session ──

function stopSession(sessionId) {
  const proc = running.get(sessionId);
  if (!proc) return { stopped: false, reason: "not_running" };
  if (process.platform === "win32" && proc.pid) {
    try { execSync(`taskkill /f /t /pid ${proc.pid}`, { stdio: "ignore" }); } catch {}
  } else {
    try { proc.kill("SIGINT"); } catch {}
    setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 3000);
  }
  running.delete(sessionId);
  return { stopped: true };
}

// ── HTTP server ──

function startBridge(config) {
  const dd = dataDir();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Confirm-Wipe");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    const auth = req.headers.authorization || "";
    if (req.url !== "/health" && auth !== `Bearer ${config.bearerToken}`) {
      send(401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let m;

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
      const project = url.searchParams.get("project") || "";
      const sessions = listSessions({ includeTiny, project });
      send(200, { sessions });
      return;
    }

    // Search
    if (url.pathname === "/sessions/search" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const limit = parseInt(url.searchParams.get("limit") || "30", 10);
      const results = searchSessions(q, limit);
      send(200, { results });
      return;
    }

    // Starred list
    if (url.pathname === "/sessions/starred" && req.method === "GET") {
      send(200, { starred: readJson(path.join(dd, "starred.json"), []) });
      return;
    }

    // Wipe all sessions
    if (url.pathname === "/sessions/all" && req.method === "DELETE") {
      if (req.headers["x-confirm-wipe"] !== "yes-i-am-sure") {
        send(400, { error: "missing X-Confirm-Wipe header" });
        return;
      }
      send(200, wipeAllSessions());
      return;
    }

    // Session messages
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/messages$/);
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
      send(200, renameSession(m[1], body.title));
      return;
    }

    // Delete single session
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)$/);
    if (m && req.method === "DELETE") {
      const result = deleteSession(m[1]);
      send(result.error ? 404 : 200, result);
      return;
    }

    // ChatGPT bindings
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

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

// ── MCP auto-allow ───────────────────────────────────────────────────────────
// Headless `claude -p` has no interactive permission prompt, so any tool not in
// `permissions.allow` is auto-DENIED ("Claude requested permissions to use
// mcp__x__y, but you haven't granted it yet"). MCP servers the user configured
// in their CLI therefore LOAD fine (claude mcp list shows "✓ Connected") but
// every call fails — which reads as "MCP doesn't work through the extension".
// Verified against a probe server: allow ["mcp__probe"] works; ["mcp__*"] does
// NOT (no wildcard support), so real server names must be enumerated.
// Opt out with CLAUDE_BRIDGE_MCP_AUTOALLOW=0.
function discoverMcpServers(cwd) {
  const names = new Set();
  const base = process.env.CLAUDE_CONFIG_DIR || homeDir();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(base, ".claude.json"), "utf8"));
    for (const k of Object.keys(cfg.mcpServers || {})) names.add(k);
    const projects = cfg.projects || {};
    if (cwd && projects[cwd]) {
      for (const k of Object.keys(projects[cwd].mcpServers || {})) names.add(k);
    } else {
      // Unknown/!matching cwd: union every project's local servers so a session
      // resumed in any directory still gets its tools granted.
      for (const p of Object.values(projects)) {
        for (const k of Object.keys((p && p.mcpServers) || {})) names.add(k);
      }
    }
  } catch {}
  if (cwd) {
    try {
      const proj = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8"));
      for (const k of Object.keys(proj.mcpServers || {})) names.add(k);
    } catch {}
  }
  return [...names].filter(Boolean).sort();
}

function withMcpAllow(allow, cwd) {
  if (process.env.CLAUDE_BRIDGE_MCP_AUTOALLOW === "0") return allow;
  const out = [...allow];
  for (const name of discoverMcpServers(cwd)) {
    const rule = "mcp__" + name;
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
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

// ── Persisted turn-completion markers ──────────────────────────────────────
// A turn is "complete" ONLY when its claude process actually resolved with a
// parseable result. We persist that fact to disk (keyed by session id) so the
// completion signal survives a bridge restart. Without it, getSessionMessages
// falls back to the in-memory `running` set — which is wiped on restart — and
// then promotes the trailing JSONL assistant line to `final_text`. For a turn
// orphaned by a restart, that trailing line is often a mid-turn tool-call
// preamble ("Running the type-check: I'll report once…") which then gets
// mis-rendered as the final answer. The marker lets us tell genuine completion
// apart from an interrupted/orphaned turn.
function completionDir() {
  const d = path.join(dataDir(), "completions");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function completionMarkerPath(sid) {
  return path.join(completionDir(), encodeURIComponent(sid) + ".json");
}
function writeCompletionMarker(sid, finalText) {
  if (!sid || sid === "pending") return;
  try {
    writeJson(completionMarkerPath(sid), {
      session_id: sid,
      stop_reason: "end_turn",
      final_text: typeof finalText === "string" ? finalText : "",
      completed_at: Date.now(),
    });
  } catch {}
  // Best-effort prune of stale markers (>30d) so the dir can't grow forever.
  try {
    const dir = completionDir();
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}
function readCompletionMarker(sid) {
  if (!sid) return null;
  return readJson(completionMarkerPath(sid), null);
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

// ── Per-session file exchange (the Files drawer) ──────────────────────────
// Same per-session folder used for images doubles as a two-way file drawer:
// the user uploads ANY file here (Claude reads it), and Claude drops files here
// (the user downloads them). Old files pruned on access.
const MAX_FILE_BYTES = 45 * 1024 * 1024;
const FILE_PRUNE_DAYS = 14;
const FILE_NAME_RE = /^[A-Za-z0-9._ ()+\-]+$/;
const EXT_MIME = {
  drawio: "application/xml", pdf: "application/pdf", json: "application/json",
  csv: "text/csv", txt: "text/plain", md: "text/markdown", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", zip: "application/zip", gz: "application/gzip",
  tar: "application/x-tar", html: "text/html", css: "text/css", js: "text/javascript",
  ts: "text/plain", py: "text/x-python", cs: "text/plain", java: "text/x-java",
  yml: "text/yaml", yaml: "text/yaml", sql: "text/plain", log: "text/plain", sh: "text/x-sh",
};
function mimeFor(name) {
  const e = path.extname(name || "").slice(1).toLowerCase();
  return EXT_MIME[e] || "application/octet-stream";
}
function sanitizeAnyFilename(name) {
  let base = path.basename((name || "").trim())
    .replace(/[^A-Za-z0-9._ ()+\-]/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "");
  return (base || "upload.bin").slice(0, 200);
}
function sessionFilesDir(sid) {
  if (!/^[A-Za-z0-9._-]+$/.test(sid || "")) throw new Error("bad session id");
  return path.join(dataDir(), "images", sid);
}
function pruneSessionFiles(dir) {
  const cutoff = Date.now() - FILE_PRUNE_DAYS * 86400 * 1000;
  let entries; try { entries = fs.readdirSync(dir); } catch { return; }
  for (const f of entries) {
    const fp = path.join(dir, f);
    try { const st = fs.statSync(fp); if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
  }
}
function listSessionFiles(sid) {
  const dir = sessionFilesDir(sid);
  pruneSessionFiles(dir);
  let entries; try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of entries.sort()) {
    const fp = path.join(dir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile()) out.push({ name: f, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mime: mimeFor(f) });
    } catch {}
  }
  return out;
}
function readSessionFile(sid, name) {
  const dir = sessionFilesDir(sid);
  const safe = path.basename(name || "");
  if (!safe || safe !== name || !FILE_NAME_RE.test(safe)) throw new Error("bad file name");
  const fp = path.join(dir, safe);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { const e = new Error("file not found"); e.notFound = true; throw e; }
  if (fs.statSync(fp).size > MAX_FILE_BYTES) throw new Error("file exceeds limit — too large to transfer");
  const buf = fs.readFileSync(fp);
  return { name: safe, size: buf.length, mime: mimeFor(safe), data_base64: buf.toString("base64") };
}
function saveSessionFile(sid, name, dataB64) {
  const dir = sessionFilesDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  pruneSessionFiles(dir);
  if (typeof dataB64 !== "string") throw new Error("missing data_base64");
  const mm = dataB64.match(/^data:[^;]+;base64,([\s\S]+)$/);
  if (mm) dataB64 = mm[1];
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_FILE_BYTES) throw new Error("file too large");
  const final = `${Date.now()}-${sanitizeAnyFilename(name || "upload.bin")}`;
  const fp = path.join(dir, final);
  fs.writeFileSync(fp, buf, { mode: 0o600 });
  return { name: final, size: buf.length, mime: mimeFor(final), path: fp };
}
function deleteSessionFile(sid, name) {
  const dir = sessionFilesDir(sid);
  const safe = path.basename(name || "");
  if (!safe || safe !== name || !FILE_NAME_RE.test(safe)) throw new Error("bad file name");
  const fp = path.join(dir, safe);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { const e = new Error("file not found"); e.notFound = true; throw e; }
  fs.unlinkSync(fp);
  return { deleted: safe };
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
  let preview = "", aiTitle = "", customTitle = "", msgCount = 0, lastPrompt = "", cwd = "";
  try {
    // For listing, read just the first 64KB and the last 64KB.
    // First chunk: get preview + ai_title from early events.
    // Last chunk: get last_prompt and custom-title overrides (latest wins).
    // Message count is approximated from file size.
    const stat = fs.statSync(filePath);
    const CHUNK = 64 * 1024;
    const fd = fs.openSync(filePath, "r");
    try {
      const headBuf = Buffer.alloc(Math.min(CHUNK, stat.size));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      const head = headBuf.toString("utf8");
      for (const line of head.split("\n")) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          // The real working directory is recorded on the session's events;
          // capture the first one. Far more accurate than decoding the project
          // dir name (which is lossy — it can't recover ":" or distinguish a
          // path separator from a literal "-", e.g. Windows "C:\GIT\…").
          if (!cwd && typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
          if (obj.type === "summary" && obj.summary) preview = preview || obj.summary.slice(0, 200);
          if (obj.type === "user" && obj.message?.content) {
            const text = typeof obj.message.content === "string" ? obj.message.content : JSON.stringify(obj.message.content);
            if (!preview && !looksLikeInternal(text)) preview = text.slice(0, 200);
          }
          if (obj.type === "result" && obj.result?.metadata?.title?.value) aiTitle = aiTitle || obj.result.metadata.title.value;
          if (obj.type === "ai-title") aiTitle = obj.aiTitle || obj.title || aiTitle;
          if (obj.type === "custom-title") customTitle = obj.customTitle || obj.title || customTitle;
        } catch {}
      }
      if (stat.size > CHUNK) {
        const tailBuf = Buffer.alloc(CHUNK);
        fs.readSync(fd, tailBuf, 0, CHUNK, stat.size - CHUNK);
        const tail = tailBuf.toString("utf8");
        const tailLines = tail.split("\n");
        if (tailLines.length > 1) tailLines.shift();
        for (const line of tailLines) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" && obj.message?.content) {
              const text = typeof obj.message.content === "string" ? obj.message.content : JSON.stringify(obj.message.content);
              if (!looksLikeInternal(text)) lastPrompt = text.slice(0, 200);
            }
            if (obj.type === "ai-title") aiTitle = obj.aiTitle || obj.title || aiTitle;
            if (obj.type === "custom-title") customTitle = obj.customTitle || obj.title || customTitle;
          } catch {}
        }
      }
      // Count newlines accurately by streaming chunks.
      const COUNT_BUF = Buffer.alloc(64 * 1024);
      let pos = 0;
      while (pos < stat.size) {
        const got = fs.readSync(fd, COUNT_BUF, 0, COUNT_BUF.length, pos);
        if (got <= 0) break;
        for (let i = 0; i < got; i++) if (COUNT_BUF[i] === 0x0A) msgCount++;
        pos += got;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return { preview, ai_title: customTitle || aiTitle, message_count: msgCount, last_prompt: lastPrompt, cwd };
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
      cwd: parsed.cwd || projectDirToCwd(project),
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

    let aiTitle = "", msgCount = 0, realCwd = "";
    try {
      const lines = content.split("\n").filter(Boolean);
      msgCount = lines.length;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (!realCwd && typeof obj.cwd === "string" && obj.cwd) realCwd = obj.cwd;
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
      cwd: realCwd || projectDirToCwd(project),
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

const INTERNAL_USER_PATTERNS = [
  "<system-reminder>", "<command-name>", "<command-message>",
  "<local-command-stdout>", "<command-stderr>", "<local-command-stderr>",
  "Caveat: The messages below were generated by",
];

function extractUserText(content) {
  // Only extract type:"text" parts. tool_result records don't have a text
  // part so they return empty string and get filtered out.
  let raw = "";
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text") {
        raw = part.text || "";
        break;
      }
    }
  }
  return resolveAtFileRefs(raw);
}

// When the bridge sends a multi-line prompt to claude on Windows it writes
// the prompt to a temp file and passes "@C:\...\claude-prompt-NNN.txt" as
// the -p arg. claude records that literal @path in the session JSONL as
// the user message. When we read the session back we want to show the
// actual content, not the path — otherwise history looks like a wall of
// temp-file paths. If the file still exists on disk, inline its contents;
// otherwise leave the @path alone so the user at least sees something.
function resolveAtFileRefs(text) {
  if (!text || typeof text !== "string") return text;
  // Match a leading @<path> that points at a claude-prompt-*.txt temp file.
  // Restrict to the temp-file pattern we generate ourselves — never inline
  // arbitrary user-typed @file references (which are a real Claude Code
  // feature that should remain as-is).
  const trimmed = text.trim();
  if (!trimmed.startsWith("@")) return text;
  const m = trimmed.match(/^@(.+?claude-prompt-\d+-[a-z0-9]+\.txt)\s*$/i);
  if (!m) return text;
  const filePath = m[1];
  try {
    if (fs.existsSync(filePath)) {
      const body = fs.readFileSync(filePath, "utf8");
      if (body && body.length) return body;
    }
  } catch {}
  // Legacy: the temp file was already cleaned up (pre-2.0.13 behavior deleted
  // them at turn end) — show an honest placeholder instead of a confusing path.
  return "(your message text is unavailable — it was passed via a temp file that was cleaned up; fixed for new messages in bridge 2.0.13)";
  return text;
}

function shouldSkipUserText(text) {
  if (!text) return true;
  const t = text.replace(/^\s+/, "");
  if (INTERNAL_USER_PATTERNS.some(p => t.startsWith(p))) return true;
  return false;
}

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
        // Skip transcript-only and meta records (replays, recaps)
        if (obj.isMeta === true) continue;
        if (obj.isVisibleInTranscriptOnly === true) continue;
        if (obj.type === "user" && obj.message?.content) {
          const text = extractUserText(obj.message.content);
          if (shouldSkipUserText(text)) continue;
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
          if (!text) continue;
          // Merge consecutive assistant turns into one (tool_use cycles).
          // Track the trailing event's stop_reason — `end_turn`/`stop_sequence`
          // means the turn finished; `tool_use` means it stopped on a tool-call
          // preamble (i.e. mid-action). This is the authoritative, in-transcript
          // completion signal and works for every session, old or new.
          const sr = obj.message?.stop_reason || null;
          const mdl = obj.message?.model || null;   // claude records the model per reply
          if (messages.length && messages[messages.length - 1].role === "assistant") {
            messages[messages.length - 1].text = (messages[messages.length - 1].text + "\n" + text).trim();
            messages[messages.length - 1].timestamp = obj.timestamp || messages[messages.length - 1].timestamp;
            messages[messages.length - 1]._stop_reason = sr;
            if (mdl) messages[messages.length - 1].model = mdl;
          } else {
            messages.push({ role: "assistant", text, timestamp: obj.timestamp, _stop_reason: sr, model: mdl });
          }
        } else if (obj.type === "result" && obj.result?.assistantMessage) {
          const text = typeof obj.result.assistantMessage === "string" ? obj.result.assistantMessage : "";
          if (text) messages.push({ role: "assistant", text, timestamp: obj.timestamp });
        }
      } catch {}
    }
    // Match the Python bridge's shape so the app's reconnect/resume loader can
    // detect completion. Without `status` (and end-of-turn markers on the
    // trailing assistant), the loader never finalizes — it shows "still working"
    // forever even though Claude is done (the stuck-loader bug on this bridge).
    const inProgress = running.has(sessionId);
    const last_event_ts = messages.length ? (messages[messages.length - 1].timestamp || null) : null;
    let status = inProgress ? "in_progress" : "complete";
    let interrupted = false;
    if (!inProgress && messages.length) {
      const last = messages[messages.length - 1];
      // Completion is decided by two independent signals, either of which is
      // sufficient:
      //   1. Transcript: the trailing assistant event's stop_reason is
      //      `end_turn`/`stop_sequence` (claude closed the turn). Authoritative
      //      and present in every session, so old sessions stay "complete".
      //   2. Marker: a persisted completion record exists AND was written no
      //      earlier than the trailing event (nothing newer ran after it).
      // If NEITHER holds — e.g. the trailing line is a `tool_use` preamble and
      // no fresh marker exists because the bridge was restarted mid-turn — the
      // turn was orphaned. We must NOT fabricate an end_turn on that line.
      const transcriptDone = last._stop_reason === "end_turn" || last._stop_reason === "stop_sequence";
      const marker = readCompletionMarker(sessionId);
      const lastTs = last_event_ts ? Date.parse(last_event_ts) : 0;
      const markerGenuine = marker && (!lastTs || lastTs <= (marker.completed_at + 2000));
      const genuine = transcriptDone || markerGenuine;
      if (last.role === "assistant" && last.text) {
        if (genuine) {
          last.stop_reason = "end_turn";
          last.final_text = last.text;
        } else {
          // Interrupted/orphaned: finalize honestly instead of passing the
          // trailing preamble off as the answer (and instead of leaving the
          // client's loader spinning forever with no end marker).
          status = "interrupted";
          interrupted = true;
          last.interrupted = true;
          last.stop_reason = "interrupted";
          last.final_text = last.text +
            "\n\n⚠️ This turn was interrupted before it finished (the bridge was " +
            "likely restarted mid-turn). The text above may be a partial step, not " +
            "the final result. Reply \"continue\" to resume.";
        }
      }
    }
    for (const m of messages) delete m._stop_reason;  // internal-only signal
    return {
      session_id: sessionId,
      messages,
      in_progress: inProgress,
      status,
      interrupted,
      last_event_ts,
    };
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

// Injected into every turn (--append-system-prompt) so Claude never ends a turn
// promising async follow-up it can't keep: a bridge turn is one-shot and atomic —
// nothing re-invokes Claude after it stops, so "I'll report once the build
// completes" is a promise that never resolves (it leaves the UI dead-ended).
const ATOMIC_TURN_PROMPT =
  "You are running inside a one-shot, non-interactive bridge: THIS TURN IS ATOMIC. " +
  "It ends the moment you stop producing output, and nothing re-invokes you afterward. " +
  "You cannot do work in the background, report back later, be re-triggered when an " +
  "external job (build/CI/deploy/long command) finishes, or continue on your own. " +
  "Therefore NEVER end a turn by promising future follow-up such as 'I'll report once " +
  "it completes', 'I'll continue when CI is done', or 'waiting on X to finish'. Instead, " +
  "run any work to completion within this turn and report the actual result now. If a " +
  "task genuinely cannot finish in this turn, say so plainly and tell the user the exact " +
  "command(s) to run or the next message to send to continue — do not imply you will resume.";

function askClaude(config, { prompt, session_id, images, cwd, plan_mode, allow_tools, model, fork }) {
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

    // Pass the prompt via a temp file (@file, read by claude itself) instead of as
    // a command-line argument when:
    //  1) Prompt exceeds Windows cmd.exe's ~8K arg limit (threshold 6000).
    //  2) We're on Windows with a .cmd shim — period. The shim runs through
    //     `cmd.exe /c`, which RE-PARSES the prompt with CMD's own rules: a double
    //     quote (") or a metacharacter (% & | < > ^) breaks the command line and
    //     surfaces as the cryptic "The system cannot find the file specified";
    //     a newline silently truncates the prompt at line 1. Node's argv quoting
    //     can't protect against cmd.exe's second parse. Passing @file sidesteps ALL
    //     of it, so do it for EVERY cmd-shim prompt — not just multi-line ones.
    //     (Previously only triggered on \r|\n, so quoted single-line prompts failed.)
    const useTempFile =
      finalPrompt.length > 6000 ||
      (isWin && isCmdShim);
    let tmpFile = null;
    if (useTempFile) {
      // PERSISTENT prompts dir — NOT os.tmpdir(). The session JSONL records the
      // literal "@<path>" as the user message, and getSessionMessages resolves
      // it by reading the file back. Deleting the file after the turn (the old
      // behavior) made every reload show the raw @C:\...\claude-prompt-*.txt
      // path instead of the user's text. Files are pruned after 30 days.
      const promptsDir = path.join(dataDir(), "prompts");
      fs.mkdirSync(promptsDir, { recursive: true });
      try {
        const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
        for (const f of fs.readdirSync(promptsDir)) {
          const fp = path.join(promptsDir, f);
          try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
        }
      } catch {}
      tmpFile = path.join(promptsDir, `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(tmpFile, finalPrompt, "utf8");
    }

    // Allow list — the caller (extension) can override via `allow_tools`, e.g.
    // after the user clicks "Allow <tool>" on a permission denial, so an MCP
    // tool (mcp__server__tool) or any other non-default tool can be granted for
    // the session. Falls back to the default working set. Mirrors the Python
    // bridge so both behave identically.
    const defaultAllow = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch",
                          "Task", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "NotebookEdit"];
    const allow = (Array.isArray(allow_tools) && allow_tools.length &&
                   allow_tools.every(x => typeof x === "string")) ? allow_tools : defaultAllow;
    const settings = JSON.stringify({
      permissions: {
        defaultMode: "acceptEdits",
        allow,
        deny: ["AskUserQuestion"],
      }
    });
    const promptArg = useTempFile ? `@${tmpFile}` : finalPrompt;
    const args = ["-p", promptArg, "--output-format", "json",
      "--settings", settings, "--permission-mode", "acceptEdits",
      "--append-system-prompt", ATOMIC_TURN_PROMPT];
    let resumeCwd = null;
    if (session_id) {
      const existing = scanSessionFiles().find(s => s.id === session_id);
      if (existing) {
        args.push("--resume", session_id);
        // Fork: replay this session's history into a BRAND-NEW session id instead
        // of appending to the original. claude returns the new id in the result,
        // which the client adopts (leaving the original untouched). --fork-session
        // only works alongside --resume.
        if (fork) args.push("--fork-session");
        // Scan JSONL for the first event with a cwd field
        try {
          const lines = fs.readFileSync(existing.filePath, "utf8").split("\n");
          for (const line of lines) {
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.cwd) { resumeCwd = parsed.cwd; break; }
            } catch {}
          }
        } catch {}
      } else {
        args.push("--session-id", session_id);
      }
    }
    if (plan_mode) args.push("--plan");
    // Optional model override from the extension's model picker (alias or id).
    if (model && String(model).trim()) args.push("--model", String(model).trim());

    // Effective cwd is only final here (resumeCwd comes from the session JSONL),
    // and local-scope MCP servers are keyed BY directory — so grant MCP against
    // the real run cwd, patching the already-built --settings in place.
    const effCwd = cwd || resumeCwd || config.cwd;
    try {
      const mcpAllow = withMcpAllow(allow, effCwd);
      if (mcpAllow.length !== allow.length) {
        const si = args.indexOf("--settings");
        if (si !== -1) {
          const s = JSON.parse(args[si + 1]);
          s.permissions.allow = mcpAllow;
          args[si + 1] = JSON.stringify(s);
        }
      }
    } catch {}

    const bin = isCmdShim ? process.env.COMSPEC || "cmd.exe" : config.claudeBin;
    const fullArgs = isCmdShim ? ["/c", config.claudeBin, ...args] : args;

    const proc = spawn(bin, fullArgs, {
      cwd: effCwd,
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
      // tmpFile is intentionally KEPT — history rendering reads it back (see promptsDir note).
      if (session_id) running.delete(session_id);
      try {
        const result = JSON.parse(stdout);
        const sid = result.session_id || session_id || crypto.randomUUID();
        // Persist genuine completion so it survives a bridge restart. This is
        // the ONLY place a clean end-of-turn is recorded — the error/partial
        // branch below deliberately writes no marker, so an interrupted turn
        // stays distinguishable.
        const finalText = result.result || result.assistantMessage || "";
        writeCompletionMarker(sid, finalText);
        if (session_id && session_id !== sid) writeCompletionMarker(session_id, finalText);
        if (images && images.length && session_id === "pending" && sid !== "pending") {
          const oldDir = path.join(dataDir(), "images", "pending");
          const newDir = path.join(dataDir(), "images", sid);
          try { fs.renameSync(oldDir, newDir); } catch {}
        }
        // Surface tool-permission denials so the extension can show an "Allow
        // <tool>" button (then resend with allow_tools including it). Without
        // this, a tool that needs approval — notably any MCP tool, which isn't
        // in the default allow list — silently fails with no way to grant it in
        // headless -p mode. Mirrors the Python bridge's shape.
        const rawDenials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
        const permission_denials = rawDenials
          .filter(x => x && typeof x === "object")
          .map(x => ({ tool_name: x.tool_name || "?", tool_input: x.tool_input || {} }));
        resolve({
          response: result.result || result.assistantMessage || stdout.slice(0, 5000),
          session_id: sid,
          cost_usd: result.cost_usd || null,
          duration_ms: result.duration_ms || null,
          context: result.context || null,
          permission_denials,
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
      // tmpFile is intentionally KEPT — history rendering reads it back (see promptsDir note).
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
        if (body.key && body.mark) {
          sess[body.key] = { ...(sess[body.key] || {}), ...body.mark };
        } else {
          for (const [k, v] of Object.entries(body)) {
            sess[k] = { ...(sess[k] || {}), ...v };
          }
        }
        allMarks[m[1]] = sess;
        writeJson(marksFile, allMarks);
        send(200, { ok: true });
        return;
      }
    }

    // AutoMode cross-device state + single-runner lease (per session, like marks)
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/automode$/);
    if (m) {
      const amFile = path.join(dd, "automode-state.json");
      const allAm = readJson(amFile, {});
      if (req.method === "GET") {
        send(200, { automode: allAm[m[1]] || {} });
        return;
      }
      if (req.method === "PATCH" || req.method === "POST") {
        const body = await readBody(req);
        const allowed = ["to_claude", "to_gpt", "gpt_ready", "claude_ready", "active_client", "active_ts"];
        const cur = allAm[m[1]] || {};
        for (const k of allowed) if (k in body) cur[k] = body[k];
        allAm[m[1]] = cur;
        writeJson(amFile, allAm);
        send(200, { automode: cur });
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

    // Session files — list (GET) / upload (POST)
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/files$/);
    if (m) {
      if (req.method === "GET") {
        try { send(200, { files: listSessionFiles(m[1]) }); } catch (e) { send(400, { error: String(e.message || e) }); }
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        try { send(200, saveSessionFile(m[1], body.name, body.data_base64 || body.data)); }
        catch (e) { send(400, { error: String(e.message || e) }); }
        return;
      }
    }
    // Session files — download one (GET) / remove one (DELETE)
    m = url.pathname.match(/^\/sessions\/([A-Za-z0-9._-]+)\/files\/(.+)$/);
    if (m && req.method === "GET") {
      try { send(200, readSessionFile(m[1], decodeURIComponent(m[2]))); }
      catch (e) { send(e.notFound ? 404 : 400, { error: String(e.message || e) }); }
      return;
    }
    if (m && req.method === "DELETE") {
      try { send(200, deleteSessionFile(m[1], decodeURIComponent(m[2]))); }
      catch (e) { send(e.notFound ? 404 : 400, { error: String(e.message || e) }); }
      return;
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

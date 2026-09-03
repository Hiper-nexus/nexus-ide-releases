#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const GLOBAL_DROP_DIR = path.join(os.homedir(), '.bridgespace', 'agent-hooks', 'global');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readStdinSync() {
  if (process.stdin.isTTY) return '';
  // On Windows we still need the fstat gate — fs.readFileSync(0) can block
  // forever if the parent doesn't close stdin. On macOS/Linux the underlying
  // pipe always EOFs, so a plain read is safe and works regardless of whether
  // stdin is a FIFO, socket, or character device (Claude Code uses one of
  // these depending on host).
  if (process.platform === 'win32') {
    try {
      const st = fs.fstatSync(0);
      if (!st || (!st.isFIFO() && !st.isFile())) return '';
      if (typeof st.size === 'number' && st.size === 0 && st.isFile()) return '';
    } catch {
      return '';
    }
  }
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return typeof buf === 'string' ? buf : '';
  } catch {
    return '';
  }
}

function pickSessionIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
  if (typeof payload.sessionId === 'string' && payload.sessionId) return payload.sessionId;
  if (typeof payload['session-id'] === 'string' && payload['session-id']) return payload['session-id'];
  if (payload.session && typeof payload.session === 'object') {
    if (typeof payload.session.id === 'string' && payload.session.id) return payload.session.id;
  }
  return null;
}

function pickCodexThreadIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const keys = ['thread-id', 'thread_id', 'threadId', 'id'];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v) return v;
  }
  const thread = payload.thread;
  if (thread && typeof thread === 'object') {
    if (typeof thread.id === 'string' && thread.id) return thread.id;
    if (typeof thread.thread_id === 'string' && thread.thread_id) return thread.thread_id;
    if (typeof thread.threadId === 'string' && thread.threadId) return thread.threadId;
  }
  const session = payload.session;
  if (session && typeof session === 'object') {
    if (typeof session.thread_id === 'string' && session.thread_id) return session.thread_id;
    if (typeof session.threadId === 'string' && session.threadId) return session.threadId;
  }
  return null;
}

function pickBodyFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['last_assistant_message', 'lastAssistantMessage', 'last-assistant-message', 'message', 'body', 'text'];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function pickUserPromptFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['input_messages', 'input-messages', 'inputMessages'];
  for (const k of keys) {
    const v = payload[k];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
  }
  return '';
}

function hasOwnTruthy(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) && !!obj[key];
}

function hasOwnFalse(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] === false;
}

function sourceIndicatesCodexNonPrimary(source) {
  if (!source) return false;
  if (typeof source === 'string') {
    const value = source.toLowerCase();
    return (
      value === 'subagent' ||
      value === 'sub_agent' ||
      value.startsWith('subagent_') ||
      value.startsWith('sub_agent_') ||
      value === 'internal' ||
      value === 'memory_consolidation'
    );
  }
  if (typeof source !== 'object') return false;

  if (
    Object.prototype.hasOwnProperty.call(source, 'subagent') ||
    Object.prototype.hasOwnProperty.call(source, 'sub_agent') ||
    Object.prototype.hasOwnProperty.call(source, 'internal')
  ) {
    return true;
  }

  const sourceType = typeof source.type === 'string' ? source.type.toLowerCase() : '';
  if (
    sourceType === 'subagent' ||
    sourceType === 'sub_agent' ||
    sourceType === 'internal' ||
    sourceType === 'memory_consolidation'
  ) {
    return true;
  }

  return (
    sourceIndicatesCodexNonPrimary(source.source) ||
    sourceIndicatesCodexNonPrimary(source.session_source) ||
    sourceIndicatesCodexNonPrimary(source.sessionSource)
  );
}

function hasCodexParentThreadMarker(obj) {
  return (
    hasOwnTruthy(obj, 'parent_thread_id') ||
    hasOwnTruthy(obj, 'parentThreadId') ||
    hasOwnTruthy(obj, 'parent-thread-id') ||
    hasOwnTruthy(obj, 'subagent_parent_thread_id') ||
    hasOwnTruthy(obj, 'subagentParentThreadId') ||
    hasOwnTruthy(obj, 'subagent-parent-thread-id')
  );
}

function hasCodexSubAgentIdentityMarker(obj) {
  return (
    hasOwnTruthy(obj, 'agent_id') ||
    hasOwnTruthy(obj, 'agentId') ||
    hasOwnTruthy(obj, 'agent-id') ||
    hasOwnTruthy(obj, 'agent_path') ||
    hasOwnTruthy(obj, 'agentPath') ||
    hasOwnTruthy(obj, 'agent-path') ||
    hasOwnTruthy(obj, 'agent_nickname') ||
    hasOwnTruthy(obj, 'agentNickname') ||
    hasOwnTruthy(obj, 'agent-nickname') ||
    hasOwnTruthy(obj, 'agent_role') ||
    hasOwnTruthy(obj, 'agentRole') ||
    hasOwnTruthy(obj, 'agent-role')
  );
}

function isCodexNonPrimaryPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (
    hasOwnTruthy(payload, 'is_subagent') ||
    hasOwnTruthy(payload, 'isSubagent') ||
    hasOwnTruthy(payload, 'is_sub_agent') ||
    hasOwnTruthy(payload, 'isSubAgent') ||
    hasOwnFalse(payload, 'is_main_thread') ||
    hasOwnFalse(payload, 'isMainThread') ||
    hasOwnFalse(payload, 'is_root_thread') ||
    hasOwnFalse(payload, 'isRootThread') ||
    hasCodexSubAgentIdentityMarker(payload)
  ) {
    return true;
  }

  // Codex persists spawned agent threads with source.subagent metadata.
  // Newer thread-aware payloads can also expose a parent thread id directly.
  if (
    sourceIndicatesCodexNonPrimary(payload.source) ||
    sourceIndicatesCodexNonPrimary(payload.session_source) ||
    sourceIndicatesCodexNonPrimary(payload.sessionSource)
  ) {
    return true;
  }

  if (hasCodexParentThreadMarker(payload)) {
    return true;
  }

  const thread = payload.thread;
  if (thread && typeof thread === 'object') {
    if (hasCodexParentThreadMarker(thread) || hasCodexSubAgentIdentityMarker(thread)) return true;
    if (sourceIndicatesCodexNonPrimary(thread.source)) return true;
  }

  const session = payload.session;
  if (session && typeof session === 'object') {
    if (hasCodexParentThreadMarker(session) || hasCodexSubAgentIdentityMarker(session)) return true;
    if (
      sourceIndicatesCodexNonPrimary(session.source) ||
      sourceIndicatesCodexNonPrimary(session.session_source) ||
      sourceIndicatesCodexNonPrimary(session.sessionSource)
    ) {
      return true;
    }
  }

  return false;
}

function isSafeCodexThreadId(threadId) {
  return typeof threadId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(threadId);
}

function getCodexHome() {
  const envHome = process.env.CODEX_HOME;
  if (typeof envHome === 'string' && envHome && path.isAbsolute(envHome)) return envHome;
  return path.join(os.homedir(), '.codex');
}

function recentCodexSessionDirs(sessionsDir) {
  const dirs = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const year = String(d.getFullYear()).padStart(4, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dirs.push(path.join(sessionsDir, year, month, day));
  }
  return dirs;
}

function scanForCodexRollout(dir, threadId, maxDepth, state) {
  if (!dir || state.visitedDirs >= state.maxDirs || state.visitedFiles >= state.maxFiles) return null;
  state.visitedDirs++;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  entries.sort((a, b) => b.name.localeCompare(a.name));

  for (const entry of entries) {
    if (state.visitedFiles >= state.maxFiles) return null;
    if (!entry.isFile()) continue;
    state.visitedFiles++;
    const name = entry.name;
    if (name.startsWith('rollout-') && name.endsWith('.jsonl') && name.includes(threadId)) {
      return path.join(dir, name);
    }
  }

  if (maxDepth <= 0) return null;

  for (const entry of entries) {
    if (state.visitedDirs >= state.maxDirs) return null;
    if (!entry.isDirectory()) continue;
    const found = scanForCodexRollout(path.join(dir, entry.name), threadId, maxDepth - 1, state);
    if (found) return found;
  }

  return null;
}

function findCodexRolloutPath(threadId) {
  if (!isSafeCodexThreadId(threadId)) return null;
  const sessionsDir = path.join(getCodexHome(), 'sessions');
  const seen = new Set();
  const state = { visitedDirs: 0, visitedFiles: 0, maxDirs: 5000, maxFiles: 20000 };

  for (const dir of recentCodexSessionDirs(sessionsDir)) {
    seen.add(dir);
    const found = scanForCodexRollout(dir, threadId, 0, state);
    if (found) return found;
  }

  // Resumed Codex sessions can append to older rollout files. Fall back to a
  // bounded date-tree scan so old primary sessions still work without letting
  // one hook invocation walk an unbounded filesystem.
  if (!seen.has(sessionsDir)) {
    return scanForCodexRollout(sessionsDir, threadId, 4, state);
  }
  return null;
}

function readCodexSessionMeta(rolloutPath) {
  let fd;
  try {
    fd = fs.openSync(rolloutPath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, read);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let item;
      try { item = JSON.parse(trimmed); } catch { continue; }
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'session_meta') return item.payload || item;
      if (item.type === 'SessionMeta') return item.payload?.meta || item.payload || item;
      if (item.meta && typeof item.meta === 'object') return item.meta;
      if (item.source !== undefined && (item.id || item.thread_id || item.threadId)) return item;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function codexSessionMetaIndicatesNonPrimary(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return (
    sourceIndicatesCodexNonPrimary(meta.source) ||
    sourceIndicatesCodexNonPrimary(meta.session_source) ||
    sourceIndicatesCodexNonPrimary(meta.sessionSource) ||
    hasCodexParentThreadMarker(meta) ||
    hasCodexSubAgentIdentityMarker(meta)
  );
}

function isCodexNonPrimaryThreadFromRollout(threadId) {
  const rolloutPath = findCodexRolloutPath(threadId);
  if (!rolloutPath) return false;
  return codexSessionMetaIndicatesNonPrimary(readCodexSessionMeta(rolloutPath));
}

function slug(input, max) {
  const max2 = typeof max === 'number' ? max : 32;
  return String(input || '').replace(/[^a-z0-9-]/gi, '').slice(0, max2) || 'unknown';
}

function truncate(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max) : s;
}

const args = parseArgs(process.argv.slice(2));
const agent = (args.agent || '').toLowerCase().trim() || 'unknown';
const event = (args.event || '').toLowerCase().trim() || 'stop';
let title = typeof args.title === 'string' ? args.title : '';
let body = typeof args.body === 'string' ? args.body : '';

// Prompt-submit hooks were only used for the removed remote-title flow.
// Ignore stale managed hooks until the installer strips them from user config.
if (event === 'prompt-submit' || event === 'before-agent' || event === 'user-prompt-submit') {
  process.exit(0);
}

const stdinRaw = readStdinSync();
let payload = null;
if (Array.isArray(args._)) {
  for (let i = args._.length - 1; i >= 0; i--) {
    payload = parseJsonMaybe(args._[i]);
    if (payload) break;
  }
}
if (!payload && stdinRaw) {
  payload = parseJsonMaybe(stdinRaw);
}

// The agent CLI's own conversation/thread id (different namespace from
// BRIDGESPACE_SESSION_ID). This is the durable identity used to build a
// `<agent> resume <id>` command for the Warp-style recovery flow.
let nativeSessionId = '';

if (agent === 'codex') {
  const codexThreadId = pickCodexThreadIdFromPayload(payload);
  if (isCodexNonPrimaryPayload(payload) || isCodexNonPrimaryThreadFromRollout(codexThreadId)) {
    process.exit(0);
  }
  nativeSessionId = codexThreadId || '';
}

// Only surface notifications for agents running inside a BridgeSpace pane.
// The hook configs we install (~/.cursor/hooks.json, ~/.codex/config.toml,
// etc.) are global, so an agent CLI invoked from another IDE — e.g. Cursor's
// own agent mode shelling out to cursor-agent — would otherwise fire a
// notification that has no associated pane (the "Jump to pane" button would
// dead-end). The BRIDGESPACE_SESSION_ID env var is injected by the PTY
// spawn in src-tauri/src/main.rs, so its presence is a reliable signal that
// this invocation is one we own. Honour --session-id as an explicit override
// for tests / future hosts that pass it deliberately.
if (
  !process.env.BRIDGESPACE_SESSION_ID &&
  !(typeof args['session-id'] === 'string' && args['session-id'])
) {
  process.exit(0);
}

// BridgeSpace terminal session ID — primary correlation key for pane mapping.
// Prefer the env var (set by PTY spawn) over the payload's session_id which
// is the agent CLI's own conversation ID (different namespace).
const sessionId =
  (typeof args['session-id'] === 'string' && args['session-id']) ||
  process.env.BRIDGESPACE_SESSION_ID ||
  pickSessionIdFromPayload(payload) ||
  '';

if (!body) body = pickBodyFromPayload(payload);

// For non-codex agents the payload's own session id IS the native
// conversation id we want for resume (codex was handled above via its
// thread id). Honour an explicit --native-session-id override for tests.
if (!nativeSessionId) {
  nativeSessionId =
    (typeof args['native-session-id'] === 'string' && args['native-session-id']) ||
    pickSessionIdFromPayload(payload) ||
    '';
}

// Map agent-specific events to the notification type MainApp understands.
let status;
if (event === 'stop' || event === 'agent-response' || event === 'after-agent') {
  status = 'idle';
  if (!title) title = 'Finished working';
} else if (event === 'notification' || event === 'needs-input') {
  status = 'needs-input';
  if (!title) title = 'Needs input';
} else if (event === 'error') {
  status = 'error';
  if (!title) title = 'Error';
} else if (event === 'session-start') {
  status = 'running';
  if (!title) title = 'Working';
} else if (event === 'session-end') {
  status = 'ended';
  if (!title) title = 'Session ended';
} else {
  status = 'idle';
  if (!title) title = 'Update';
}

try {
  fs.mkdirSync(GLOBAL_DROP_DIR, { recursive: true });
} catch {
  process.exit(0);
}

// The CLI config home this agent process runs under (AI account profiles).
// Conversation/thread ids are scoped to it, so a resume must execute under
// the SAME dir. Empty = the CLI's default home.
let configDir = '';
if (agent === 'codex') {
  configDir = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME : '';
} else if (agent === 'claude') {
  configDir = typeof process.env.CLAUDE_CONFIG_DIR === 'string' ? process.env.CLAUDE_CONFIG_DIR : '';
}

const timestamp = Date.now();
const dropPayload = {
  sessionId: sessionId || null,
  agentType: agent,
  status,
  title: truncate(title, 200),
  body: truncate(body, 1000),
  event,
  cwd: process.cwd(),
  pid: typeof process.pid === 'number' ? process.pid : null,
  timestamp,
  // Agent CLI's own conversation/thread id — powers `<agent> resume <id>`
  // in the Warp-style session recovery flow. Empty when unavailable.
  nativeSessionId: nativeSessionId ? truncate(nativeSessionId, 200) : '',
  configDir: configDir ? truncate(configDir, 512) : '',
  // The user prompt that started this turn (Codex notify carries it as
  // `input-messages`). Feeds agent-session history (lastPrompt) and the
  // prompt-derived pane title for agents with no native OSC titling — see
  // AGENTS_TITLED_FROM_PROMPT in agentConfig.ts. 4KB cap matches the Claude
  // hook script.
  userPrompt: truncate(pickUserPromptFromPayload(payload), 4000),
};

const sidPart = sessionId ? slug(sessionId, 48) : 'nosession-' + slug(String(process.pid), 12);
const filename = sidPart + '--' + timestamp + '-' + slug(agent, 16) + '-' + slug(event, 24) + '.json';
const filePath = path.join(GLOBAL_DROP_DIR, filename);
const tmpPath = filePath + '.tmp';

try {
  fs.writeFileSync(tmpPath, JSON.stringify(dropPayload));
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // On Windows, rename fails (EEXIST/EPERM) if the destination exists.
    const code = err && err.code;
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
      try { fs.unlinkSync(filePath); } catch {}
      try {
        fs.renameSync(tmpPath, filePath);
      } catch {
        try { fs.copyFileSync(tmpPath, filePath); } catch {}
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } else {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
} catch {
  // Silent — hooks must never fail the parent process.
}

process.exit(0);

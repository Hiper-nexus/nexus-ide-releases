#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const GLOBAL_STATUS_DIR = path.join(os.homedir(), '.bridgespace', 'claude-hooks', 'global');

// Read Claude's hook stdin payload up-front so we can derive the workspace
// root from it. Claude includes `cwd` (project root) on every hook event —
// using stdin avoids depending on the script's own location, which lets us
// install the dispatcher at a HOME-stable path even when the workspace path
// contains spaces.
function readStdinSync() {
  if (process.stdin.isTTY) return '';
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return typeof buf === 'string' ? buf : '';
  } catch {
    return '';
  }
}

const stdinRaw = readStdinSync();
let stdinPayload = null;
if (stdinRaw) {
  try { stdinPayload = JSON.parse(stdinRaw); } catch { stdinPayload = null; }
}

function deriveWorkspaceRoot() {
  // 1. stdin cwd from Claude's hook payload (canonical source).
  if (stdinPayload && typeof stdinPayload.cwd === 'string' && stdinPayload.cwd) {
    return stdinPayload.cwd;
  }
  // 2. Legacy install path: dispatcher used to live in
  //    `<workspace>/.bridgespace/bin/`, so __dirname's grandparent IS the
  //    workspace root. Detect by checking that SCRIPT_DIR's parent is named
  //    `.bridgespace` — if so, fall back to that for older installs that
  //    haven't been re-registered with the HOME-based dispatcher yet.
  const scriptParent = path.basename(path.dirname(SCRIPT_DIR));
  if (scriptParent === '.bridgespace') {
    return path.dirname(path.dirname(SCRIPT_DIR));
  }
  // 3. Last resort: process.cwd(). Claude generally invokes hooks with the
  //    project root as cwd, so this is correct in practice.
  return process.cwd();
}

const WORKSPACE_ROOT = deriveWorkspaceRoot();
const BS_ROOT = path.join(WORKSPACE_ROOT, '.bridgespace');
const REGISTRY_DIR = path.join(BS_ROOT, 'claude-hooks', 'scopes');

function listActiveScopes() {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  try {
    return fs.readdirSync(REGISTRY_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/i, ''));
  } catch {
    return [];
  }
}

function readMarker(markerPath) {
  try {
    const content = fs.readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Ignore malformed markers and treat them as missing.
  }
  return null;
}

function resolveScopeContext() {
  const envScopeId = process.env.BRIDGESPACE_SWARM_SCOPE_ID || '';
  if (envScopeId) {
    const markerPath = path.join(REGISTRY_DIR, envScopeId + '.json');
    if (fs.existsSync(markerPath)) {
      const marker = readMarker(markerPath);
      if (marker && typeof marker.binDir === 'string') {
        return marker;
      }
    }
  }

  const activeScopes = listActiveScopes();
  if (activeScopes.length === 1) {
    const markerPath = path.join(REGISTRY_DIR, activeScopes[0] + '.json');
    const marker = readMarker(markerPath);
    if (marker && typeof marker.binDir === 'string') {
      return marker;
    }
  }

  return null;
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  return typeof result.status === 'number' ? result.status : 0;
}

function dispatchMail(scope) {
  const mailScript = path.join(BS_ROOT, scope.binDir, 'bs-mail.cjs');
  if (!fs.existsSync(mailScript)) return 0;
  return runNodeScript(mailScript, ['check', '--inject']);
}

function dispatchStatus(scope, status, title, body) {
  const notifyScript = path.join(BS_ROOT, scope.binDir, 'bs-notify.cjs');
  if (!fs.existsSync(notifyScript)) return 0;
  return runNodeScript(notifyScript, [status, title, body]);
}

const event = (process.argv[2] || '').toLowerCase();
const status = process.argv[3] || '';
const title = process.argv[4] || '';
const body = process.argv[5] || '';
const scope = resolveScopeContext();

// stdin was already consumed at the top of the script to derive the workspace
// root. The payload also carries the user's prompt (UserPromptSubmit) which
// the renderer uses to seed terminal-title generation.
function pickUserPromptFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  // Claude Code uses 'prompt'; other agents may use 'user_prompt' or 'message'.
  const keys = ['prompt', 'user_prompt', 'userPrompt', 'message', 'text'];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const userPrompt = pickUserPromptFromPayload(stdinPayload);

// Claude Code includes its own conversation id on every hook payload as
// `session_id`. This is a DIFFERENT namespace from BRIDGESPACE_SESSION_ID
// (our PTY id) — it's the durable identity needed to build a
// `claude --resume <id>` command that survives an app crash / battery death.
function pickNativeSessionId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['session_id', 'sessionId', 'conversation_id', 'conversationId'];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const nativeSessionId = pickNativeSessionId(stdinPayload);

// Claude Code also reports the absolute path of the session's transcript
// JSONL (`transcript_path`). The renderer uses it for cross-account
// continuation: copy the transcript into another profile's config dir and
// `claude --resume` there when the user explicitly chooses to continue a
// limited conversation on another account they own.
function pickTranscriptPath(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['transcript_path', 'transcriptPath'];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const transcriptPath = pickTranscriptPath(stdinPayload);

// One-line debug breadcrumb when prompt extraction fails on a prompt-submit
// event. Helps diagnose host-specific stdin quirks without blowing up logs.
if (event === 'user-prompt-submit' && !userPrompt) {
  try {
    const debugDir = path.join(os.homedir(), '.bridgespace', 'logs');
    fs.mkdirSync(debugDir, { recursive: true });
    const stdinIsTTY = !!process.stdin.isTTY;
    let stdinKind = 'unknown';
    try {
      const st = fs.fstatSync(0);
      stdinKind = st.isFIFO() ? 'fifo' : st.isFile() ? 'file' : st.isCharacterDevice() ? 'char' : st.isSocket() ? 'socket' : 'other';
    } catch (e) {
      stdinKind = 'fstat-err:' + (e && e.code ? e.code : 'unknown');
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'user-prompt-submit',
      stdinIsTTY,
      stdinKind,
      stdinLen: stdinRaw.length,
      stdinHead: stdinRaw.slice(0, 200),
    }) + '\n';
    fs.appendFileSync(path.join(debugDir, 'claude-hook-stdin-debug.log'), line);
  } catch {
    // Debug logging is best-effort.
  }
}

function writeGlobalStatus(eventName, statusValue, titleValue, bodyValue) {
  const sessionId = process.env.BRIDGESPACE_SESSION_ID || '';
  if (!sessionId) return; // Nothing to correlate — bail silently.

  try {
    fs.mkdirSync(GLOBAL_STATUS_DIR, { recursive: true });
  } catch {
    return;
  }

  const timestamp = Date.now();

  const payload = {
    sessionId,
    status: statusValue || (eventName === 'notification' ? 'needs-input' : 'idle'),
    title: titleValue || (eventName === 'notification' ? 'Needs input' : 'Finished working'),
    body: bodyValue || '',
    event: eventName,
    cwd: process.cwd(),
    pid: typeof process.pid === 'number' ? process.pid : null,
    timestamp,
    // Carry the user's prompt through to the renderer so it can seed
    // terminal-title generation. Truncated to 4KB to keep drop files small.
    userPrompt: userPrompt ? userPrompt.slice(0, 4000) : '',
    // Claude's own conversation id — powers `claude --resume <id>` in the
    // Warp-style session recovery flow. Empty when the payload omits it.
    nativeSessionId: nativeSessionId || '',
    // Absolute path of Claude's session transcript JSONL — powers
    // cross-account continuation when the user opts to switch accounts.
    transcriptPath: transcriptPath || '',
    // The CLI config home this Claude process runs under (AI account
    // profiles). Conversation ids are scoped to it, so a resume must execute
    // under the SAME dir — running `claude --resume <id>` under another
    // profile fails with "No conversation found". Empty = default ~/.claude.
    configDir: process.env.CLAUDE_CONFIG_DIR || '',
    agentType: 'claude',
  };

  // One file per event so that back-to-back events (e.g., Stop followed by
  // Notification a few ms later) don't overwrite each other before the
  // renderer's fs.watch handler has a chance to read them.
  // Filename: <sessionId>--<timestamp>-<event>.json
  const eventSlug = String(eventName).replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'event';
  const filename = sessionId + '--' + timestamp + '-' + eventSlug + '.json';
  const filePath = path.join(GLOBAL_STATUS_DIR, filename);
  const tmpPath = filePath + '.tmp';
  try {
    // Atomic write: write to a tmp path, then rename so watchers never see
    // a truncated JSON file mid-write.
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Best effort — do not let hook failures propagate to Claude.
  }
}

if (scope) {
  switch (event) {
    case 'session-start':
      // Registers the session (native id + config dir) the moment the CLI
      // boots — including `claude --resume`, which makes a successful
      // resume observable to the renderer. The renderer treats
      // session-start as non-visible (no notification).
      writeGlobalStatus('session-start', 'running', '', '');
      break;
    case 'user-prompt-submit':
      dispatchMail(scope);
      // Also write a global status file so the renderer records the userPrompt
      // for the agent-session history / resume (lastPrompt). The swarm dispatch
      // above handles mail injection but doesn't carry the prompt back to the
      // renderer. (This no longer drives terminal titles — that feature was
      // removed; panes keep their seeded agent name.)
      if (userPrompt) writeGlobalStatus('user-prompt-submit', 'running', '', '');
      break;
    case 'stop':
      dispatchStatus(scope, status || 'idle', title || 'Finished working', body || '');
      break;
    case 'notification':
      dispatchStatus(scope, status || 'needs-input', title || 'Needs input', body || '');
      break;
    default:
      break;
  }
} else {
  // Fallback path for non-swarm Claude conversations: just record the status
  // write to the per-session global file. BridgeSpace's renderer watches this
  // directory and surfaces a notification.
  switch (event) {
    case 'session-start':
      writeGlobalStatus('session-start', 'running', '', '');
      break;
    case 'user-prompt-submit':
      // Record the prompt for agent-session history (lastPrompt / modal
      // titles). Not a visible notification — the renderer filters it.
      if (userPrompt) writeGlobalStatus('user-prompt-submit', 'running', '', '');
      break;
    case 'stop':
      writeGlobalStatus('stop', status, title, body);
      break;
    case 'notification':
      writeGlobalStatus('notification', status, title, body);
      break;
    default:
      break;
  }
}

process.exit(0);

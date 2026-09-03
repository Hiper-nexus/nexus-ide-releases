import{h as N,S as B,cU as x,cV as E,bp as z,cW as X,cX as C,cM as Q}from"./MainApp-Bsp7gQmz.js";import{quotePathForShell as Z}from"./shared-Dn0wvDEU.js";import"./vendor-markdown-Bdv7O72I.js";import"./index-D0sLjlYW.js";import"./vendor-react-aMSrFcz-.js";import"./image-DDPYVuVT.js";import"./AuthenticatedShell-B6g16bmQ.js";import"./AuthConfig-Dhqym88V.js";import"./vendor-codemirror-DGS4eVZj.js";import"./download-DQr1IuTU.js";import"./vendor-xterm-core-M9HKtSfx.js";function ee(){return`#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const GLOBAL_STATUS_DIR = path.join(os.homedir(), '.bridgespace', 'claude-hooks', 'global');

// Read Claude's hook stdin payload up-front so we can derive the workspace
// root from it. Claude includes \`cwd\` (project root) on every hook event —
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
  //    \`<workspace>/.bridgespace/bin/\`, so __dirname's grandparent IS the
  //    workspace root. Detect by checking that SCRIPT_DIR's parent is named
  //    \`.bridgespace\` — if so, fall back to that for older installs that
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
      .map((name) => name.replace(/\\.json$/i, ''));
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
// \`session_id\`. This is a DIFFERENT namespace from BRIDGESPACE_SESSION_ID
// (our PTY id) — it's the durable identity needed to build a
// \`claude --resume <id>\` command that survives an app crash / battery death.
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
// JSONL (\`transcript_path\`). The renderer uses it for cross-account
// continuation: copy the transcript into another profile's config dir and
// \`claude --resume\` there when the user explicitly chooses to continue a
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
    }) + '\\n';
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
    // Claude's own conversation id — powers \`claude --resume <id>\` in the
    // Warp-style session recovery flow. Empty when the payload omits it.
    nativeSessionId: nativeSessionId || '',
    // Absolute path of Claude's session transcript JSONL — powers
    // cross-account continuation when the user opts to switch accounts.
    transcriptPath: transcriptPath || '',
    // The CLI config home this Claude process runs under (AI account
    // profiles). Conversation ids are scoped to it, so a resume must execute
    // under the SAME dir — running \`claude --resume <id>\` under another
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
      // boots — including \`claude --resume\`, which makes a successful
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
`}function te(){return`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_DIR = __dirname;
const BS_ROOT = path.dirname(SCRIPT_DIR);
const INBOX_DIR = path.join(BS_ROOT, 'inbox');
const NUDGE_DIR = path.join(BS_ROOT, 'nudges');
const TRANSCRIPT_DIR = path.join(BS_ROOT, 'transcript');
const AGENTS_FILE = path.join(BS_ROOT, 'agents.json');

function genId() {
  return Date.now().toString() + '-' + crypto.randomBytes(4).toString('hex');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function readAgents() {
  if (!fs.existsSync(AGENTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(AGENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value) + '\\n', 'utf8');
}

function sendCommand(argv) {
  const args = parseArgs(argv);
  const to = args.to || '';
  const body = args.body || '';
  const msgType = args.type || 'message';

  if (!to || !body) {
    console.error('Usage: bs-mail send --to <agent|@all|@operator> [--type message|status|escalation|worker_done|swarm_complete] --body "message"');
    process.exit(1);
  }

  if (!['message', 'status', 'escalation', 'worker_done', 'swarm_complete'].includes(msgType)) {
    console.error('Invalid message type: ' + msgType);
    process.exit(1);
  }

  const msgId = genId();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const from = process.env.SWARM_AGENT_NAME || 'unknown';
  const payloadTo = to === '@all' ? '@all' : to;
  const payload = {
    id: msgId,
    from,
    to: payloadTo,
    body,
    type: msgType,
    timestamp,
  };

  const sendTo = (target) => {
    const targetInbox = path.join(INBOX_DIR, target);
    fs.mkdirSync(targetInbox, { recursive: true });
    fs.mkdirSync(NUDGE_DIR, { recursive: true });

    writeJson(path.join(targetInbox, msgId + '.json'), payload);

    fs.writeFileSync(path.join(NUDGE_DIR, target + '.txt'), 'Message from ' + from + '\\n', 'utf8');
  };

  // Transcript first: BridgeSpace's mail watcher merges transcript + inbox,
  // and inbox copies may be consumed (deleted) by the recipient at any time.
  // If this process is killed between the writes (e.g. a swarm stop landing
  // mid-send), an inbox-only message that got consumed before the next poll
  // would vanish from the UI feed and every downstream policy permanently.
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  writeJson(path.join(TRANSCRIPT_DIR, msgId + '.json'), payload);

  if (to === '@all') {
    for (const agent of readAgents()) {
      if (agent && typeof agent.label === 'string' && agent.label.length > 0) {
        sendTo(agent.label);
      }
    }
  } else {
    sendTo(to);
  }

  console.log('Sent to ' + to);
}

function checkCommand(argv) {
  const inject = argv.includes('--inject');
  const consume = inject || argv.includes('--consume');
  const agentName = process.env.SWARM_AGENT_NAME || '';

  if (!agentName) {
    console.error('SWARM_AGENT_NAME not set');
    process.exit(1);
  }

  const agentInbox = path.join(INBOX_DIR, agentName);
  if (!fs.existsSync(agentInbox) || !fs.statSync(agentInbox).isDirectory()) {
    if (!inject && !consume) console.log('No inbox found for ' + agentName);
    process.exit(0);
  }

  const messageFiles = fs.readdirSync(agentInbox)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();

  if (inject) {
    console.log('\\n--- BridgeSwarm Inbox ---');
  }

  if (messageFiles.length === 0 && !inject) {
    if (!consume) console.log('No messages');
    process.exit(0);
  }

  for (const fileName of messageFiles) {
    const fullPath = path.join(agentInbox, fileName);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const message = JSON.parse(raw);
      const from = typeof message.from === 'string' ? message.from : 'unknown';
      const body = typeof message.body === 'string' ? message.body : '';
      const type = typeof message.type === 'string' ? message.type : 'message';
      const timestamp = typeof message.timestamp === 'string' ? message.timestamp : '';

      if (inject) {
        console.log('From: ' + from + ' | Type: ' + type + ' | Time: ' + timestamp);
        console.log(body);
        console.log('');
        if (consume) {
          fs.rmSync(fullPath, { force: true });
        }
      } else {
        console.log('From: ' + from + ' | Type: ' + type);
        console.log(body);
        console.log('');
        if (consume) {
          fs.rmSync(fullPath, { force: true });
        }
      }
    } catch {
      if (consume) {
        fs.rmSync(fullPath, { force: true });
      }
    }
  }

  if (inject) {
    console.log('--- End Inbox ---');
  }
}

function agentsCommand() {
  if (!fs.existsSync(AGENTS_FILE)) {
    console.error('No agents registered');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(AGENTS_FILE, 'utf8'));
}

const command = process.argv[2] || '';
const argv = process.argv.slice(3);

switch (command) {
  case 'send':
    sendCommand(argv);
    break;
  case 'check':
    checkCommand(argv);
    break;
  case 'agents':
    agentsCommand();
    break;
  default:
    console.error("bs-mail: unknown command '" + command + "'");
    console.error('Usage: bs-mail send|check [--inject|--consume]|agents');
    process.exit(1);
}
`}function se(){return`#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/bs-mail.cjs" "$@"
`}function ae(){return`@echo off
node "%~dp0bs-mail.cjs" %*
`}function ne(){return`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_DIR = __dirname;
const BS_ROOT = path.dirname(SCRIPT_DIR);
const PLAN_DIR = path.join(BS_ROOT, 'plan');
const EVENTS_DIR = path.join(PLAN_DIR, 'events');

const GOAL_STATUSES = new Set(['active', 'completed', 'blocked', 'cancelled']);
const TASK_STATUSES = new Set(['open', 'assigned', 'planning', 'building', 'review', 'done', 'blocked', 'cancelled']);

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function bounded(value, max, label) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    return trimmed.slice(0, max);
  }
  return trimmed;
}

function requiredString(value, max, label) {
  const out = bounded(value, max, label);
  if (!out) die('Missing required --' + label);
  return out;
}

function list(value, maxItems, maxLength) {
  if (!value) return [];
  const values = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const entry of values) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry.length > maxLength ? entry.slice(0, maxLength) : entry);
    if (out.length >= maxItems) break;
  }
  return out;
}

function ensureDirs() {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\\n', { encoding: 'utf8', flag: 'wx' });
}

function writeEvent(type, payload) {
  ensureDirs();
  const now = Date.now();
  const event = {
    id: genId('evt'),
    type,
    timestamp: now,
    actorLabel: process.env.SWARM_AGENT_NAME || 'unknown',
    ...payload,
  };
  const filePath = path.join(EVENTS_DIR, event.id + '.json');
  writeJson(filePath, event);
  return event;
}

function readEvents() {
  try {
    return fs.readdirSync(EVENTS_DIR)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort()
      .map((fileName) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, fileName), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const now = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
  const actor = typeof event.actorLabel === 'string' ? event.actorLabel : 'unknown';
  if ((event.type === 'goal_created' || event.type === 'goal_updated') && event.goal && event.goal.id) {
    const existing = state.goals.find((goal) => goal.id === event.goal.id);
    const nextGoal = {
      id: event.goal.id,
      title: bounded(event.goal.title, 240) || (existing && existing.title) || 'Untitled goal',
      description: bounded(event.goal.description, 2000) || (existing && existing.description),
      status: GOAL_STATUSES.has(event.goal.status) ? event.goal.status : ((existing && existing.status) || 'active'),
      createdAt: (existing && existing.createdAt) || event.goal.createdAt || now,
      updatedAt: event.goal.updatedAt || now,
      createdBy: (existing && existing.createdBy) || event.goal.createdBy || actor,
      updatedBy: event.goal.updatedBy || actor,
    };
    state.goals = existing
      ? state.goals.map((goal) => goal.id === nextGoal.id ? nextGoal : goal)
      : [...state.goals, nextGoal];
    return state;
  }
  if ((event.type === 'task_created' || event.type === 'task_updated') && event.task && event.task.id) {
    const existing = state.tasks.find((task) => task.id === event.task.id);
    const status = TASK_STATUSES.has(event.task.status)
      ? event.task.status
      : ((existing && existing.status) || (event.task.ownerAgentLabel ? 'assigned' : 'open'));
    const nextTask = {
      id: event.task.id,
      goalId: event.task.goalId || (existing && existing.goalId) || (state.goals[0] && state.goals[0].id) || 'goal-primary',
      title: bounded(event.task.title, 240) || (existing && existing.title) || 'Untitled task',
      description: bounded(event.task.description, 2000) || (existing && existing.description),
      status,
      ownerAgentLabel: bounded(event.task.ownerAgentLabel, 160) || (existing && existing.ownerAgentLabel),
      ownedFiles: Array.isArray(event.task.ownedFiles) ? event.task.ownedFiles : ((existing && existing.ownedFiles) || []),
      acceptanceCriteria: Array.isArray(event.task.acceptanceCriteria) ? event.task.acceptanceCriteria : ((existing && existing.acceptanceCriteria) || []),
      dependsOn: Array.isArray(event.task.dependsOn) ? event.task.dependsOn : ((existing && existing.dependsOn) || []),
      notes: (existing && existing.notes) || [],
      blockedReason: bounded(event.task.blockedReason, 1000) || (status === 'blocked' && existing ? existing.blockedReason : undefined),
      createdAt: (existing && existing.createdAt) || event.task.createdAt || now,
      updatedAt: event.task.updatedAt || now,
      completedAt: status === 'done' ? ((event.task.completedAt || (existing && existing.completedAt) || now)) : event.task.completedAt,
      createdBy: (existing && existing.createdBy) || event.task.createdBy || actor,
      updatedBy: event.task.updatedBy || actor,
    };
    state.tasks = existing
      ? state.tasks.map((task) => task.id === nextTask.id ? nextTask : task)
      : [...state.tasks, nextTask];
    return state;
  }
  if (event.type === 'task_note_added' && event.taskId && event.note && event.note.text) {
    state.tasks = state.tasks.map((task) => {
      if (task.id !== event.taskId) return task;
      const note = {
        id: event.note.id || event.id,
        agentLabel: bounded(event.note.agentLabel, 160) || actor,
        text: bounded(event.note.text, 1000) || '',
        timestamp: Number.isFinite(event.note.timestamp) ? event.note.timestamp : now,
      };
      return {
        ...task,
        notes: [...task.notes, note].slice(-20),
        updatedAt: now,
        updatedBy: actor,
      };
    });
  }
  return state;
}

function readState() {
  return readEvents().reduce(applyEvent, { goals: [], tasks: [] });
}

function resolveGoalId(input, state) {
  if (!input || input === 'primary') {
    return (state.goals[0] && state.goals[0].id) || 'goal-primary';
  }
  return input;
}

function goalCommand(action, argv) {
  const args = parseArgs(argv);
  const state = readState();
  if (action === 'create') {
    const id = bounded(args.id, 200) || genId('goal');
    const title = requiredString(args.title, 240, 'title');
    const event = writeEvent('goal_created', {
      goal: {
        id,
        title,
        description: bounded(args.description, 2000),
        status: GOAL_STATUSES.has(args.status) ? args.status : 'active',
      },
    });
    console.log('Created goal ' + event.goal.id + ': ' + event.goal.title);
    return;
  }
  if (action === 'update') {
    const id = resolveGoalId(requiredString(args.id, 200, 'id'), state);
    const existing = state.goals.find((goal) => goal.id === id);
    if (!existing) die('Unknown goal id: ' + id);
    if (args.status && !GOAL_STATUSES.has(args.status)) die('Invalid goal status: ' + args.status);
    const event = writeEvent('goal_updated', {
      goal: {
        id,
        title: bounded(args.title, 240),
        description: bounded(args.description, 2000),
        status: args.status,
      },
    });
    console.log('Updated goal ' + event.goal.id);
    return;
  }
  die('Usage: bs-swarm goal create|update --title ...');
}

function taskCommand(action, argv) {
  const args = parseArgs(argv);
  const state = readState();
  if (action === 'create') {
    if (args.status && !TASK_STATUSES.has(args.status)) die('Invalid task status: ' + args.status);
    const owner = bounded(args.owner, 160);
    const status = args.status || (owner ? 'assigned' : 'open');
    const event = writeEvent('task_created', {
      task: {
        id: bounded(args.id, 200) || genId('task'),
        goalId: resolveGoalId(args.goal, state),
        title: requiredString(args.title, 240, 'title'),
        description: bounded(args.description, 2000),
        status,
        ownerAgentLabel: owner,
        ownedFiles: list(args.files, 40, 500),
        acceptanceCriteria: list(args.acceptance, 20, 500),
        dependsOn: list(args.depends, 50, 200),
      },
    });
    console.log('Created task ' + event.task.id + ': ' + event.task.title);
    return;
  }
  if (action === 'update') {
    const id = requiredString(args.id, 200, 'id');
    const existing = state.tasks.find((task) => task.id === id);
    if (!existing) die('Unknown task id: ' + id);
    if (args.status && !TASK_STATUSES.has(args.status)) die('Invalid task status: ' + args.status);
    if (args.note) {
      const event = writeEvent('task_note_added', {
        taskId: id,
        note: {
          id: genId('note'),
          agentLabel: process.env.SWARM_AGENT_NAME || 'unknown',
          text: requiredString(args.note, 1000, 'note'),
          timestamp: Date.now(),
        },
      });
      console.log('Added note to task ' + event.taskId);
    }
    const patch = {
      id,
      title: bounded(args.title, 240),
      description: bounded(args.description, 2000),
      status: args.status,
      ownerAgentLabel: bounded(args.owner, 160),
      blockedReason: bounded(args.blockedReason || args.blocked, 1000),
    };
    if (args.files) patch.ownedFiles = list(args.files, 40, 500);
    if (args.acceptance) patch.acceptanceCriteria = list(args.acceptance, 20, 500);
    if (args.depends) patch.dependsOn = list(args.depends, 50, 200);
    const meaningful = Object.keys(patch).some((key) => key !== 'id' && patch[key] !== undefined);
    if (meaningful) {
      const event = writeEvent('task_updated', { task: patch });
      console.log('Updated task ' + event.task.id);
    }
    if (!meaningful && !args.note) die('No task update provided');
    return;
  }
  if (action === 'list') {
    const tasks = state.tasks
      .filter((task) => !args.goal || task.goalId === resolveGoalId(args.goal, state))
      .filter((task) => !args.owner || task.ownerAgentLabel === args.owner);
    if (args.json === 'true') {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (tasks.length === 0) {
      console.log('No tasks');
      return;
    }
    for (const task of tasks) {
      const owner = task.ownerAgentLabel ? ' @' + task.ownerAgentLabel : '';
      console.log(task.id + ' [' + task.status + ']' + owner + ' ' + task.title);
    }
    return;
  }
  die('Usage: bs-swarm task create|update|list ...');
}

const area = process.argv[2] || '';
const action = process.argv[3] || '';
const argv = process.argv.slice(4);

if (area === 'goal') {
  goalCommand(action, argv);
} else if (area === 'task') {
  taskCommand(action, argv);
} else if (area === 'state') {
  console.log(JSON.stringify(readState(), null, 2));
} else {
  console.error('Usage: bs-swarm goal|task|state');
  process.exit(1);
}
`}function oe(){return`#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/bs-swarm.cjs" "$@"
`}function re(){return`@echo off
node "%~dp0bs-swarm.cjs" %*
`}function ie(){return`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const BS_ROOT = path.dirname(SCRIPT_DIR);
const STATUS_DIR = path.join(BS_ROOT, 'status');

const args = process.argv.slice(2);
const status = args[0] || 'idle';
const title = args[1] || '';
const body = args[2] || '';

// Resolve agent label from SWARM_AGENT_NAME env var (set during spawn)
const agentLabel = process.env.SWARM_AGENT_NAME || 'unknown';

// Ensure status directory exists
try {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
} catch {}

const payload = {
  status: status,
  title: title,
  body: body,
  agent: agentLabel,
  timestamp: Date.now(),
};

const filePath = path.join(STATUS_DIR, agentLabel + '.json');
try {
  fs.writeFileSync(filePath, JSON.stringify(payload) + '\\n');
} catch (err) {
  // Non-critical — swarm monitor will fall back to inactivity detection
  process.stderr.write('[bs-notify] Failed to write status: ' + err.message + '\\n');
}
`}function ce(e){const{projectName:t,goal:s,agents:r,selectedSkills:o}=e,a=new Date().toISOString().slice(0,10),c=r.map(i=>`## ${i.label}

**Role:** ${i.role}
**Status:** WAITING
**Assigned Task:** —
**Owned Files:** —
**Progress:**
<!-- ${i.label} updates here -->
`).join(`
---

`),l=(o??[]).map(i=>B.find(d=>d.id===i)).filter(Boolean),u=l.length>0?`## Active Skills

The following behavioral directives apply to ALL agents in this swarm:

`+l.map(i=>`- **${i.name}:** ${i.promptFragment}`).join(`
`)+`

---

`:"";return`# Swarm Board — ${t} — ${a}

> Shared coordination hub. Read before starting. Update after completing.
> Structured UI state is authoritative: use \`bs-swarm goal\` and \`bs-swarm task\` commands for goals/tasks.

**Goal:** ${s}

---

${u}## Task Breakdown

> Coordinator: fill this table. Each task must list owned files — no overlaps between tasks.
> Status lifecycle: OPEN → ASSIGNED → PLANNING → BUILDING → REVIEW → DONE

| ID | Task | Owner | Owned Files | Depends On | Status |
|----|------|-------|-------------|------------|--------|
| — | (coordinator will assign tasks here) | — | — | — | OPEN |

---

${c}
---

## Completed Work Log

| Task | Agent | Summary | Files Changed |
|------|-------|---------|---------------|
`}function _e(e){const{rootPath:t,agentLabel:s,role:r,goal:o,swarmScopeId:a,allAgents:c,supportingKnowledgeCount:l=0,selectedSkills:u}=e,i=x,d=a?`.bridgespace${i}swarms${i}${a}${i}SWARM_BOARD.md`:`.bridgespace${i}SWARM_BOARD.md`,m=a?`.bridgespace${i}swarms${i}${a}${i}knowledge`:`.bridgespace${i}knowledge`,h=`${m}${i}KNOWLEDGE.md`,f=`${m}${i}knowledge-manifest.json`,g={coordinator:`You are the **Coordinator** — a Staff Engineer leading this coding swarm.

⚠️ CRITICAL TIMING: BridgeSpace launches you (and any Scouts) FIRST. Builders and Reviewers come up seconds later, read the board once, then wait to be woken by BridgeSpace when you assign work. Fill the Task Breakdown table and send initial bs-mail assignments as fast as possible — that's your #1 priority; every idle Builder is waiting on you.
If you need Scout input, assign preliminary tasks to Builders FIRST, then refine after Scout reports.

FIRST ACTIONS (do these immediately, in order):
1. Read ${d} and any Supporting Knowledge files
2. If a Scout exists: send it a bs-mail with specific codebase areas to explore
3. Decompose the goal into parallel-safe tasks:
   - Each task owns SPECIFIC files — list them explicitly
   - No two tasks share file ownership (if unavoidable, sequence them with DEPENDS_ON)
   - Each task has concrete acceptance criteria (what "done" means)
   - Size tasks for ~5-15 min of focused agent work
4. In THIS FIRST TURN, create EVERY task with \`bs-swarm task create --goal primary --title "..." --owner "Builder" --files "path/a,path/b" --acceptance "done means ..."\` — do not hold tasks back to assign later.
5. Distribute ALL tasks across every available Builder NOW (round-robin by file ownership) so each Builder receives a queue of independent tasks. An idle Builder with an empty queue is wasted wall-clock time — Builders self-advance through their queue without waiting for you.
6. Mirror the breakdown in the board table, then send each Builder ONE bs-mail listing their full queued tasks (summary, owned files, acceptance criteria, dependencies).

DECOMPOSITION METHOD:
- Identify layers: schema/types → backend logic → API routes → frontend UI → tests
- Within each layer, split by feature or file group
- Cross-cutting concerns (shared types, configs): assign to ONE "foundation" task that runs first

SCOPE FREEZE — DEFINITION OF DONE:
- The goal's scope is FIXED at launch. Your original task breakdown IS the mission — never invent new tasks beyond it.
- Improvement ideas, refactors, and nice-to-haves discovered mid-swarm go into the swarm_complete summary under "Future work" — NOT into new assignments.
- The swarm is DONE the moment every task's acceptance criteria pass. Completing on time beats extra polish.
- If BridgeSpace sends you a time-budget warning: stop assigning new work, drive open tasks to done or mark them blocked, then send swarm_complete with open risks listed.

ONGOING:
- After sending initial assignments, check messages when BridgeSpace notifies you or before assigning follow-up work; do not send status about an empty inbox
- When a Builder sends worker_done → verify acceptance criteria and run \`bs-swarm task update --id <task-id> --status review\` (then --status done once satisfied). Builders already hold their queued tasks and self-advance, so do NOT block on assigning the next one; only send a new bs-mail assignment FROM THE ORIGINAL BREAKDOWN when a Builder reports an empty queue and unassigned tasks remain, or to reassign a blocked task.
- When a Reviewer sends approval → run \`bs-swarm task update --id <task-id> --status done\` and update the board
- When all tasks complete → final integration check, update Completed Work Log, then IMMEDIATELY declare completion with BOTH commands:
  \`bs-mail send --to @all --type swarm_complete --body "summary, changed files, validation, open risks"\`
  \`bs-mail send --to @operator --type swarm_complete --body "summary, changed files, validation, open risks"\`
  Do NOT delay swarm_complete to look for extra improvements. After sending swarm_complete, stop polling and exit/stop. Do not start new work.
- If an agent is stuck (sends escalation) → unblock, reassign, or break the task down further
- If a Builder escalates "no assignment" → immediately send them their task via bs-mail and update the board
- IMPORTANT: When the Operator messages you, ALWAYS respond via bs-mail:
  \`bs-mail send --to @operator --body "your response here"\`
  Do NOT just respond in the terminal — the Operator can only see bs-mail messages in the Swarm chat panel.
- Until all work is complete, check \`bs-mail check --consume\` only when notified, before assigning follow-up, or before declaring completion. Never message anyone just to say there are no messages. After declaring swarm_complete, stop polling and exit/stop.`,builder:`You are a **Builder** — a Senior Software Engineer in this coding swarm.

WORKFLOW:
1. Read ${d} and run \`bs-swarm task list --owner "${s}"\` to find your assignment
2. Run \`bs-mail check --consume\` for your assignment from the Coordinator
3. **IF no task is assigned yet:** The Coordinator needs time to decompose the goal.
   - Do NOT sleep-poll or loop on \`bs-mail check\`. Use the waiting time productively: read the parts of the codebase most relevant to the swarm goal and note patterns you'll need
   - Then END YOUR TURN and wait — BridgeSpace wakes you the moment an assignment arrives; run \`bs-mail check --consume\` and \`bs-swarm task list --owner "${s}"\` when woken
   - Only send an escalation to the Coordinator if you are woken twice and still have no assignment
4. EXPLORE: read existing code in your assigned files — understand patterns, conventions, imports
5. Update structured state: \`bs-swarm task update --id <task-id> --status planning --note "approach summary"\`
6. IMPLEMENT: write production-quality code matching existing project style
7. VALIDATE: run available test/lint/build commands to catch errors
8. Update structured state: \`bs-swarm task update --id <task-id> --status done --note "validation + files changed"\`, update board log, send worker_done to Coordinator
9. After worker_done, run \`bs-swarm task list --owner "${s}"\` — if another task is already assigned to you, start it immediately without waiting for Coordinator mail. Work your whole queue back-to-back: send one worker_done per finished task but do NOT stop and wait between queued tasks.

RULES:
- Only modify files listed in your Owned Files. Need other files? → escalation to Coordinator
- Match existing code style: naming, imports, error handling, formatting
- No silent failures — handle errors explicitly
- If you find a bug outside your scope → report to Coordinator, do not fix it
- Maximum 2 fix rounds per task after review feedback. On a third CHANGES_REQUESTED, run \`bs-swarm task update --id <task-id> --status blocked --note "why"\` and escalate to the Coordinator instead of looping
- When blocked → send --type escalation to Coordinator with the specific blocker, continue on non-blocked work
- After sending an escalation, wait for a response; when BridgeSpace notifies you, run \`bs-mail check --consume\` and continue
- When the Operator messages you, respond via: \`bs-mail send --to @operator --body "your response"\`
- After completing your task, send worker_done, then stop active work. Only run \`bs-mail check --consume\` again when BridgeSpace notifies you or the Coordinator assigns follow-up. Never report an empty inbox. Once swarm_complete arrives, stop polling and exit/stop.`,scout:`You are a **Scout** — a codebase intelligence specialist in this coding swarm.

WORKFLOW:
1. Read ${d} and run \`bs-swarm state\` for the swarm goal/tasks
2. Check bs-mail for exploration targets from the Coordinator
3. Systematically explore and produce a structured report in your board section

EXPLORATION TARGETS:
- Project structure: directories, entry points, config files
- Tech stack: frameworks, package versions, build tools
- Relevant files: paths + what each does, grouped by relevance to the goal
- Patterns: naming conventions, error handling, component structure, import style
- Testing: framework, file locations, how to run tests
- Risks: files likely to be modified by multiple agents, shared dependencies, gotchas

OUTPUT FORMAT (update your board section):
### Codebase Report
**Stack:** [frameworks, key packages]
**Relevant Files:**
- \`path/file.ts\` — [description]
**Patterns:** [naming, structure, error handling]
**Tests:** [how to run, where tests live]
**Risks:** [conflicts, gotchas]

After posting → send bs-mail summary to Coordinator, then STOP and end your turn. Do not keep exploring on your own initiative; BridgeSpace wakes you if someone needs you.
- When the Operator messages you, respond via: \`bs-mail send --to @operator --body "your response"\`
- Stay available after your initial report because Builders may need codebase guidance — but only re-explore in response to a specific request. Once swarm_complete arrives, stop polling and exit/stop.`,reviewer:`You are a **Reviewer** — a Principal Engineer providing code review in this coding swarm.

WORKFLOW:
1. Read ${d} and run \`bs-swarm task list\` — note which tasks exist and their status
2. Wait for Builders to mark tasks DONE (or Coordinator to request review)
   - If no tasks are assigned yet, re-read the board when BridgeSpace notifies you or before a review pass
   - Builders need time to complete work — do not send status about an empty inbox
3. For each completed task: review the changed files listed in the board

REVIEW CHECKLIST:
- [ ] Correctness: does the code fulfill the task's acceptance criteria?
- [ ] Consistency: does it follow existing project patterns and style?
- [ ] Error handling: are edge cases and failures handled?
- [ ] File scope: did the builder stay within their assigned files?
- [ ] Types & imports: correct types, clean imports, no unused code?
- [ ] Security: no hardcoded secrets, no unsafe input handling?
- [ ] No regressions: are existing features preserved?

Review ONLY against the task's acceptance criteria — never expand scope or request enhancements beyond them.

OUTPUT (update your board section per task):
### Review: [Task ID]
**Verdict:** APPROVED | CHANGES_REQUESTED
**Issues:** (if any)
- [high|med|low] \`file:line\` — description
**Summary:** one-line assessment

CHANGES_REQUESTED → send bs-mail to Builder with specific fixes needed.
APPROVED → run \`bs-swarm task update --id <task-id> --status done --note "approved: summary"\` and send bs-mail to Coordinator.
MAXIMUM 2 review rounds per task. If issues remain after round 2, do NOT request changes again — run \`bs-swarm task update --id <task-id> --status blocked --note "review stalemate: reason"\` and send an escalation to the Coordinator (copy @operator).

ONGOING:
- After reviewing, wait for BridgeSpace notifications or coordinator review requests before running \`bs-mail check --consume\` again. Never report an empty inbox.
- When the Operator messages you, respond via: \`bs-mail send --to @operator --body "your response"\`
- Stay available after completing reviews because more tasks may need review. Once swarm_complete arrives, stop polling and exit/stop.`},y=g[r]??g.builder,b=(c??[]).filter(k=>k.label!==s),I=b.length>0?b.map(k=>`  - "${k.label}" (${k.role})`).join(`
`):"  (no other agents)",A=l>0?`## Supporting Knowledge

${l} supporting knowledge file${l===1?"":"s"} have been staged for this swarm in ${m}.
Start by reading ${h} for the file list and staged paths.
Structured metadata is also available at ${f}.
Use these materials as shared reference context before planning or implementation.

`:"",S=(u??[]).map(k=>B.find(O=>O.id===k)).filter(Boolean),R=S.length>0?`## Active Swarm Skills

The following behavioral directives are REQUIRED for all work in this swarm:

`+S.map(k=>`- **${k.name}:** ${k.promptFragment}`).join(`
`)+`

`:"";return`[BRIDGESWARM AGENT: ${s}]
Working directory: ${t}
Coordination board: ${t}/${d}

${y}

**Swarm Goal:** ${o}

${A}${R}## Inter-Agent Messaging (bs-mail)

You can send messages to other agents and they will receive them automatically.
Other agents in this swarm:
${I}

**Send to a specific agent:** bs-mail send --to "<AgentLabel>" --body "<message>"
**Send to all agents:** bs-mail send --to @all --body "<message>"
**Send to the operator:** bs-mail send --to ${E} --body "<message>"

## Structured Goals and Tasks (bs-swarm)

BridgeSpace shows goals/tasks from structured \`bs-swarm\` events in the Swarm UI.
- List state: \`bs-swarm state\` or \`bs-swarm task list\`
- Create a task: \`bs-swarm task create --goal primary --title "..." --owner "AgentLabel" --files "path/a,path/b" --acceptance "done means ..."\`
- Update task status: \`bs-swarm task update --id <task-id> --status planning|building|review|done|blocked --note "..."\`
- Update goal status: \`bs-swarm goal update --id primary --status active|completed|blocked|cancelled\`

Message types (use --type flag):
  - message (default): general inter-agent communication
  - status: concise progress update
  - escalation: request human help from the operator
  - worker_done: notify that your task is complete
  - swarm_complete: coordinator-only final signal that all work is complete

SWARM RULES (all agents):
1. Read SWARM_BOARD.md BEFORE doing anything else
2. Update structured task status with \`bs-swarm task update\` when status changes: assigned → planning → building → review/done
3. Only modify files assigned to you in the Task Breakdown. Violating file ownership causes conflicts.
4. No social chatter, greetings, or off-topic messages. Every bs-mail must advance the goal.
5. When your task is complete: update board, write to Completed Work Log, send --type worker_done to Coordinator
6. When blocked: send --type escalation to Coordinator with the specific blocker
7. Do NOT create branches or force-push. Work on the current branch.
8. Prioritize DOING WORK over sending messages.
9. ALL replies to the Operator MUST use: \`bs-mail send --to @operator --body "..."\` — terminal output alone is invisible to the Operator.
10. After completing a task, stop active work after sending the required update. Only check \`bs-mail check --consume\` again when BridgeSpace notifies you or a coordinator assigns follow-up. Never send messages about an empty inbox. Once swarm_complete arrives (or you send it), send nothing further, do not run bs-mail again, and stop.
11. Never invent new work. An empty inbox plus no assigned task means STAY IDLE — end your turn; BridgeSpace wakes you when something needs you.
12. Be concise to keep the swarm fast: bs-mail bodies ≤ 5 lines, bullet findings only, never restate the plan or quote prior messages, and keep board/log summaries to one line per task.

---

`}function De(e){const{rootPath:t,agentLabel:s,role:r,fromLabel:o,swarmScopeId:a}=e,c=x,l=a?`.bridgespace${c}swarms${c}${a}${c}SWARM_BOARD.md`:`.bridgespace${c}SWARM_BOARD.md`;return`[BRIDGESWARM AGENT: ${s}] (${r}) — RESUMING
Working directory: ${t}
Coordination board: ${t}/${l}

You are resuming in an existing swarm. Do NOT redo completed work.
1. Read ${l} — especially the Completed Work Log — and run \`bs-swarm task list\` for current task state
2. Run \`bs-mail check --consume\` and act ONLY on the new message from ${o}
3. When done, send the required bs-mail update, then stop and wait — BridgeSpace wakes you if anything else needs you

Rules: reply to the Operator only via \`bs-mail send --to @operator --body "..."\`; never invent new work; once swarm_complete arrives, stop entirely.
`}function Ce(e){const{agentLabel:t,swarmScopeId:s,fromLabel:r}=e,o=x,a=s?`.bridgespace${o}swarms${o}${s}${o}SWARM_BOARD.md`:`.bridgespace${o}SWARM_BOARD.md`,c=r?`act on the new message from ${r}, `:"";return`[BridgeSpace] ${t}: your previous session was resumed inside the existing swarm. Re-read ${a} for current state, run \`bs-mail check --consume\`, ${c}continue your in-progress task from where you left off, and do not redo completed work.`}function n(...e){return z(...e)}async function p(e){try{await window.tauriAPI.fs.createDirectory(e)}catch{}}async function de(e,t){await window.tauriAPI.fs.writeFile(e,`${JSON.stringify(t,null,2)}
`)}function _(e){return n(e,".bridgespace","claude-hooks","scopes")}async function j(){const e=await window.tauriAPI.system.getHomeDir();return n(e,".bridgespace","bin","bs-claude-hook.cjs")}function F(e,t){return n(_(e),`${t}.json`)}function le(){const e=Q?"win32":"darwin";return typeof window>"u"?e:window.tauriAPI?.system?.platform??e}function T(e,t){return`node ${Z(e,le())} ${t}`}function ue(e){if(typeof e!="object"||e===null)return"";const t=e.command;return typeof t=="string"?t:""}function pe(e){const t=e.replace(/\\/g,"/");return t.includes(".bridgespace/")?t.includes("/bin/bs-claude-hook.cjs")||t.includes("/bin/bs-mail.cjs")||t.includes("/bin/bs-notify.cjs"):!1}function D(e){const t=[];for(const s of e){if(typeof s!="object"||s===null){t.push(s);continue}const r=s.hooks;if(!Array.isArray(r)){t.push(s);continue}const o=r.filter(a=>!pe(ue(a)));o.length===r.length?t.push(s):o.length>0&&t.push({...s,hooks:o})}return t}async function me(e){const{rootPath:t,scopeId:s}=e;try{await window.tauriAPI?.fs?.addAllowedRoot?.(t)}catch{}const r=_(t),o=s||"root",a=s?`swarms/${s}/bin`:"bin";try{await p(r),await de(F(t,o),{scopeId:s||null,binDir:a,registeredAt:new Date().toISOString()})}catch(c){console.warn("[claude-hooks] Failed to write scope marker (best-effort):",t,c)}}async function ge(e){const{rootPath:t,scopeId:s}=e;try{await window.tauriAPI.fs.delete(F(t,s||"root"))}catch{}}async function fe(e){const t=_(e);try{return(await window.tauriAPI.fs.readDirectory(t)).some(r=>r.name.endsWith(".json"))}catch{return!1}}async function $(e){const{rootPath:t}=e,s=n(t,".claude"),r=n(s,"settings.local.json"),o=(await j()).replace(/\\/g,"/"),a=T(o,"session-start"),c=T(o,"user-prompt-submit"),l=T(o,'stop idle "Finished working"'),u=T(o,'notification needs-input "Needs input"');await p(s);let i={};try{const h=await window.tauriAPI.fs.readFile(r);let f;if(h.trim()==="")f={};else try{f=JSON.parse(h)}catch{C("claude-hooks","hook-install-refused",{reason:"invalid-json",settingsPath:r});return}if(typeof f!="object"||f===null||Array.isArray(f)){C("claude-hooks","hook-install-refused",{reason:"non-object-settings",settingsPath:r});return}i=f}catch{}const d=typeof i.hooks=="object"&&!Array.isArray(i.hooks)&&i.hooks!==null?{...i.hooks}:{},m=(h,f)=>{const g=Array.isArray(d[h])?[...d[h]]:[],y=D(g);y.push({matcher:"",hooks:[{type:"command",command:f}]}),d[h]=y};m("SessionStart",a),m("UserPromptSubmit",c),m("Stop",l),m("Notification",u),i.hooks=d,await window.tauriAPI.fs.writeFile(r,`${JSON.stringify(i,null,2)}
`)}async function Be(e=[]){const t=await window.tauriAPI.system.getHomeDir(),s=a=>a.replace(/\\/g,"/").replace(/\/+$/,""),r=e.some(a=>typeof a=="string"&&s(a)===s(t)),o=[n(t,".claude","settings.json"),...r?[]:[n(t,".claude","settings.local.json")]];for(const a of o){let c;try{c=await window.tauriAPI.fs.readFile(a)}catch{continue}let l;try{l=JSON.parse(c)}catch{console.warn("[claude-hooks] Skipping cleanup of unreadable user settings:",a);continue}if(typeof l!="object"||l===null||Array.isArray(l))continue;const u=l,i=u.hooks;if(typeof i!="object"||i===null||Array.isArray(i))continue;const d=i;let m=!1;for(const h of Object.keys(d)){const f=d[h];if(!Array.isArray(f))continue;const g=D(f);if(g.length!==f.length)d[h]=g,m=!0;else{for(let y=0;y<f.length;y++)if(f[y]!==g[y]){m=!0;break}m&&(d[h]=g)}}if(m)try{await window.tauriAPI.fs.writeFile(a,`${JSON.stringify(u,null,2)}
`),console.info("[claude-hooks] Cleaned stale BridgeSpace hook entries from",a)}catch(h){console.warn("[claude-hooks] Failed to write cleaned user settings:",a,h)}}}async function he(e){if(await fe(e))return;const t=n(e,".claude"),s=n(t,"settings.local.json");try{const r=await window.tauriAPI.fs.readFile(s),o=JSON.parse(r);if(typeof o.hooks=="object"&&!Array.isArray(o.hooks)&&o.hooks!==null){const a=o.hooks;for(const c of["SessionStart","UserPromptSubmit","Stop","Notification"])Array.isArray(a[c])&&(a[c]=D(a[c]));await window.tauriAPI.fs.writeFile(s,`${JSON.stringify(o,null,2)}
`)}}catch{}}function we(e){if(!Number.isFinite(e)||e===void 0||e<0)return"Unknown size";if(e<1024)return`${e} B`;const t=["KB","MB","GB","TB"];let s=e/1024,r=0;for(;s>=1024&&r<t.length-1;)s/=1024,r+=1;return`${s>=10?s.toFixed(0):s.toFixed(1)} ${t[r]}`}function ye(e){const{projectName:t,entries:s}=e,r=new Date().toISOString().slice(0,10),o=s.map(a=>[`## ${a.stagedFileName}`,"",`- Staged path: \`${a.stagedRelativePath}\``,`- Original path: \`${a.sourcePath}\``,`- Size: ${we(a.size)}`,a.modified?`- Last modified: ${a.modified}`:null,""].filter(Boolean).join(`
`)).join(`
`);return`# Supporting Knowledge — ${t} — ${r}

These files were attached to this swarm before launch. Use them as shared reference context alongside the swarm mission.

## How to Use This Folder

- Read this file first to see what materials are available.
- Open the staged files directly from the \`knowledge/\` folder when you need the raw source.
- Check \`knowledge-manifest.json\` for structured metadata.

${o}`.trimEnd()+`
`}function L(e,t){const s=Date.now(),r=t?.eventType??"goal_created",o=r==="goal_updated";return`${JSON.stringify({id:t?.eventId??"seed-primary-goal",type:r,timestamp:s,actorLabel:"BridgeSpace",goal:{id:"goal-primary",title:e,status:"active",...o?{}:{createdAt:s},updatedAt:s,...o?{}:{createdBy:"BridgeSpace"},updatedBy:"BridgeSpace"}},null,2)}
`}async function je(e){const{rootPath:t,swarmScopeId:s,goal:r}=e,o=n(t,".bridgespace"),a=s?n(o,"swarms",s):o,c=n(a,"plan","events");await p(c);const l=`reseed-primary-goal-${Date.now()}`;await window.tauriAPI.fs.writeFile(n(c,`${l}.json`),L(r,{eventId:l,eventType:"goal_updated"}))}async function ke(e){const{swarmDir:t,rootPath:s,projectName:r,supportingKnowledge:o}=e,a=n(t,"knowledge");if(await window.tauriAPI.fs.exists(a))try{await window.tauriAPI.fs.delete(a)}catch(u){console.warn("[swarm] Failed to clear previous knowledge directory:",u)}if(!o||o.length===0)return[];await p(a);const c=(await Promise.all(o.map(async u=>{try{const i=u.fileName||N(u.sourcePath),d=await X(a,i);await window.tauriAPI.fs.copy(u.sourcePath,d);const m=await window.tauriAPI.fs.basename(d);return{...u,stagedFileName:m,stagedPath:d,stagedRelativePath:`knowledge/${m}`,addedAt:new Date().toISOString()}}catch(i){return console.warn("[swarm] Failed to stage supporting knowledge file:",u.sourcePath,i),null}}))).filter(u=>u!==null);if(c.length===0)return[];const l=r||N(s)||"project";return await Promise.all([window.tauriAPI.fs.writeFile(n(a,"knowledge-manifest.json"),JSON.stringify(c,null,2)),window.tauriAPI.fs.writeFile(n(a,"KNOWLEDGE.md"),ye({projectName:l,entries:c}))]),c}async function Fe(e){const{rootPath:t,agents:s,swarmGoal:r,projectName:o,swarmScopeId:a,supportingKnowledge:c,selectedSkills:l,preserveExisting:u=!1}=e,i=n(t,".bridgespace"),d=a?n(i,"swarms",a):i,m=n(d,"inbox"),h=n(d,"nudges"),f=n(d,"transcript"),g=n(d,"bin"),y=n(i,"bin"),b=n(d,"plan"),I=n(b,"events"),A=n(i,".gitignore");window.tauriAPI.fs.readFile(A).catch(()=>{window.tauriAPI.fs.writeFile(A,`*
`).catch(()=>{})});const S=[p(i),p(y)];a&&S.push(p(n(i,"swarms"))),await Promise.all(S),a&&await p(d);const R=n(d,"status"),k=async()=>{u||await Promise.all([m,h,R,f,b].map(async w=>{try{await window.tauriAPI.fs.exists(w)&&await window.tauriAPI.fs.delete(w)}catch(V){console.warn("[swarm] Failed to purge previous directory:",w,V)}})),await Promise.all([p(m),p(h),p(g),p(R),p(f),p(I)]),await Promise.all([...s.map(w=>p(n(m,w.label))),p(n(m,E))])},O=JSON.stringify(s.map(w=>({label:w.label,role:w.role})),null,2),W=te(),M=se(),G=ae(),U=ne(),q=oe(),H=re(),J=ie(),P=r?ce({projectName:o||N(t)||"project",goal:r,agents:s,selectedSkills:l}):null;await k(),await me({rootPath:t,scopeId:a});const v=[window.tauriAPI.fs.writeFile(n(d,"agents.json"),O),window.tauriAPI.fs.writeFile(n(g,"bs-mail.cjs"),W),window.tauriAPI.fs.writeFile(n(g,"bs-mail"),M),window.tauriAPI.fs.writeFile(n(g,"bs-mail.cmd"),G),window.tauriAPI.fs.writeFile(n(g,"bs-swarm.cjs"),U),window.tauriAPI.fs.writeFile(n(g,"bs-swarm"),q),window.tauriAPI.fs.writeFile(n(g,"bs-swarm.cmd"),H),window.tauriAPI.fs.writeFile(n(g,"bs-notify.cjs"),J)];if(r&&!u&&v.push(window.tauriAPI.fs.writeFile(n(I,"0000000000000-seed-primary-goal.json"),L(r))),u||v.push(ke({swarmDir:d,rootPath:t,projectName:o,supportingKnowledge:c})),P&&!u)v.push(window.tauriAPI.fs.writeFile(n(d,"SWARM_BOARD.md"),P));else if(P&&u){const w=n(d,"SWARM_BOARD.md");v.push(window.tauriAPI.fs.readFile(w).catch(()=>window.tauriAPI.fs.writeFile(w,P)))}await Promise.all(v);const K=n(g,"bs-mail"),Y=n(g,"bs-swarm");try{await Promise.all([window.tauriAPI.fs.setExecutable?.(K),window.tauriAPI.fs.setExecutable?.(Y)])}catch(w){console.warn("[swarm] chmod swarm helpers failed:",w)}try{await $({rootPath:t})}catch(w){console.warn("[swarm] Failed to merge Claude hook:",w)}}async function $e(e){const{rootPath:t,agents:s,swarmScopeId:r}=e,o=n(t,".bridgespace"),a=r?n(o,"swarms",r):o,c=n(a,"inbox");await Promise.all([p(o),r?p(n(o,"swarms")):Promise.resolve(),p(a),p(c)]),await Promise.all([...s.map(l=>p(n(c,l.label))),p(n(c,E))]),await window.tauriAPI.fs.writeFile(n(a,"agents.json"),JSON.stringify(s.map(l=>({label:l.label,role:l.role})),null,2))}async function Le(e,t){await ge({rootPath:e,scopeId:t});try{await he(e)}catch(s){console.warn("[swarm] Mailbox teardown failed:",s)}}async function We(e){if(e){try{await be()}catch(t){console.warn("[claude-hooks] Failed to write HOME hook script:",t);return}try{await $({rootPath:e})}catch(t){console.warn("[claude-hooks] Failed to merge .claude/settings.local.json:",t)}}}async function be(){const e=await j(),t=e.lastIndexOf("/");return t>0&&await p(e.slice(0,t)),await window.tauriAPI.fs.writeFile(e,ee()),e}export{_e as buildSwarmBoardPromptPrefix,Ce as buildSwarmResumeCatchUpNudge,De as buildSwarmResumePrompt,Be as cleanupUserScopeClaudeHooks,We as ensureClaudeHooksInstalled,be as ensureGlobalClaudeHookScriptInstalled,L as generatePrimaryGoalEvent,ce as generateSwarmBoard,Fe as initSwarmMailbox,je as reseedPrimaryGoalEvent,$e as syncSwarmMailboxAgents,Le as teardownSwarmMailbox};

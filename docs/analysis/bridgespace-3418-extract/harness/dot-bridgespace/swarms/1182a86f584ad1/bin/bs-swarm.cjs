#!/usr/bin/env node
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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
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

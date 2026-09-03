#!/usr/bin/env node
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
  fs.writeFileSync(filePath, JSON.stringify(value) + '\n', 'utf8');
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

    fs.writeFileSync(path.join(NUDGE_DIR, target + '.txt'), 'Message from ' + from + '\n', 'utf8');
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
    console.log('\n--- BridgeSwarm Inbox ---');
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

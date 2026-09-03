#!/usr/bin/env node
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
  fs.writeFileSync(filePath, JSON.stringify(payload) + '\n');
} catch (err) {
  // Non-critical — swarm monitor will fall back to inactivity detection
  process.stderr.write('[bs-notify] Failed to write status: ' + err.message + '\n');
}

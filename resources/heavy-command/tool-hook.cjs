// Per-session PreToolUse transformer. No permission decision is changed:
// only known-heavy Bash input receives a same-shell physical admission first.
const path = require('node:path');
const { commandKind } = require('./catalog.cjs');
const output = (value) => process.stdout.write(JSON.stringify(value));
let raw = '';
process.stdin.on('data', (part) => { raw += part; if (raw.length > 131072) process.exit(2); });
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(raw); } catch { process.exit(2); }
  const input = event.tool_input || event.toolInput;
  if (!input || typeof input.command !== 'string') { output({}); return; }
  const kind = commandKind(input.command);
  if (!kind) { output({}); return; }
  let url;
  try { url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL); } catch {}
  const directory = process.env.NEXUS_HEAVY_DIR;
  const node = process.env.NEXUS_HEAVY_NODE;
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hook/heavy-command' || url.username || url.password || url.search || url.hash || !url.port || !process.env.NEXUS_GATE_TOKEN || !directory || !path.isAbsolute(directory) || !node || !path.isAbsolute(node)) {
    output({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Nexus heavy-command admission is not configured for this session.' } }); return;
  }
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  // F-1229 follow-up: the queue refusal names WHICH command holds the slot.
  // First two plain words only; anything quoted or substituted is dropped by
  // the same pattern Main applies (no secrets travel through the label).
  const label = input.command.trim().split(/\s+/).slice(0, 2).filter((word) => /^[\w.:/-]{1,40}$/.test(word)).join(' ').slice(0, 80);
  const labelEnv = label ? `NEXUS_HEAVY_LABEL=${quote(label)} ` : '';
  if (process.env.NEXUS_HEAVY_JOB_BASE) {
    const wrapped = `NODE_OPTIONS= ${labelEnv}NEXUS_HEAVY_HELPER=1 ${quote(node)} ${quote(path.join(directory, 'job-launch.cjs'))} ${quote(kind)} "\${BASH:-\${SHELL:-/bin/bash}}" -c ${quote(input.command)}`;
    output({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: wrapped } } }); return;
  }
  const prefix = label ? `${labelEnv}export NEXUS_HEAVY_LABEL\n` : '';
  output({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: prefix + `NEXUS_HEAVY_LEASE="$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 ${quote(node)} ${quote(path.join(directory, 'request.cjs'))} "$$" ${quote(kind)})" || exit 78\nexport NEXUS_HEAVY_LEASE\n` + input.command } } });
});

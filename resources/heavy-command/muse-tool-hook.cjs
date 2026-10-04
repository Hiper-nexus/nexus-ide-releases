// Pure Main-installed pre-exec transformer. Muse clears the hook env while
// retaining Main's env in the managed shell tool. Admission happens there.
const fs = require('node:fs');
const path = require('node:path');
const { commandKind } = require('./catalog.cjs');
const directory = path.dirname(fs.realpathSync(__filename));
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Physical CPU/RAM admission cannot prepare this shell command.' } };
let raw = '', bytes = 0, finished = false;
const output = (value) => { if (finished) return; finished = true; process.stdout.write(JSON.stringify(value)); };
process.stdin.on('data', (part) => {
  bytes += part.length;
  if (bytes > 131072) { output(deny); return; }
  if (!finished) raw += part;
});
process.stdin.on('end', () => {
  if (finished) return;
  let event;
  try { event = JSON.parse(raw); } catch { output(deny); return; }
  const input = event.tool_input || event.toolInput;
  if (!input || typeof input.command !== 'string') { output(deny); return; }
  const kind = commandKind(input.command);
  if (!kind) { output({}); return; }
  const wrapped = `NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 ${quote(process.execPath)} ${quote(path.join(directory, 'job-launch.cjs'))} ${quote(kind)} "\${BASH:-\${SHELL:-/bin/sh}}" -c ${quote(input.command)}`;
  output({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: wrapped } } });
});

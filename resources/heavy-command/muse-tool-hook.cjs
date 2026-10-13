// Pure Main-installed pre-exec transformer. Muse clears the hook env while
// retaining Main's env in the managed shell tool. Admission happens there.
const fs = require('node:fs');
const path = require('node:path');
const { commandKind } = require('./catalog.cjs');
const directory = path.dirname(fs.realpathSync(__filename));
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Nexus heavy-command admission cannot prepare this shell command.' } };
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
  if (input.command.startsWith('# Nexus heavy command wrapper v1\n')) { output({}); return; }
  // Muse clears hook env. Test the original tool env at execution time instead;
  // external/operator CLIs execute their original command without admission. The
  // fallback evals the quoted text in this same shell (cd/export persist) so a
  // trailing backslash or an unterminated heredoc cannot swallow the closing fi.
  const wrapped = `# Nexus heavy command wrapper v1\nif [ -n "\${NEXUS_GATE_TOKEN:-}" ] && [ -n "\${NEXUS_HEAVY_COMMAND_URL:-}" ]; then\nNODE_OPTIONS= NEXUS_HEAVY_HELPER=1 ${quote(process.execPath)} ${quote(path.join(directory, 'job-launch.cjs'))} ${quote(kind)} "\${BASH:-\${SHELL:-/bin/sh}}" -c ${quote(input.command)}\nelse\neval ${quote(input.command)}\nfi`;
  output({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: wrapped } } });
});

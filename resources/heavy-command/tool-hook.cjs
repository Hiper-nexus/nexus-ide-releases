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
    output({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Physical CPU/RAM admission is unavailable for this native heavy command.' } }); return;
  }
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const prefix = `NEXUS_HEAVY_LEASE="$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 ${quote(node)} ${quote(path.join(directory, 'request.cjs'))} "$$" ${quote(kind)})" || exit 78\nexport NEXUS_HEAVY_LEASE\n`;
  output({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: prefix + input.command } } });
});

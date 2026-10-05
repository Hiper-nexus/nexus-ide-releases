// AGY shallow-merges overwrite into toolCall.args. Never bypass its policy.
const fs = require('node:fs');
const path = require('node:path');
const ask = { decision: 'ask' };
const deny = { decision: 'deny', reason: 'Physical CPU/RAM admission is unavailable for this Nexus command.' };
let raw = '', bytes = 0, finished = false;
const output = (value) => { if (!finished) { finished = true; process.stdout.write(JSON.stringify(value)); } };
process.stdin.on('data', (part) => { bytes += part.length; if (bytes > 131072) output(process.env.NEXUS_GATE_TOKEN ? deny : ask); else if (!finished) raw += part; });
process.stdin.on('end', () => {
  if (finished) return;
  if (!process.env.NEXUS_GATE_TOKEN) { output(ask); return; }
  let event;
  try { event = JSON.parse(raw); } catch { output(deny); return; }
  const input = event.toolCall?.args;
  if (event.toolCall?.name !== 'run_command' || typeof input?.CommandLine !== 'string') { output(ask); return; }
  let kind;
  try { kind = require('./catalog.cjs').commandKind(input.CommandLine); } catch { output(deny); return; }
  if (!kind) { output(ask); return; }
  const directory = process.env.NEXUS_HEAVY_DIR, node = process.env.NEXUS_HEAVY_NODE;
  let url, base;
  try { url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL); base = JSON.parse(process.env.NEXUS_HEAVY_JOB_BASE); } catch {}
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hook/heavy-command' || url.username || url.password || url.search || url.hash || !url.port ||
      !directory || !path.isAbsolute(directory) || !node || !path.isAbsolute(node) ||
      !base || base.file !== '/usr/bin/perl' || !Array.isArray(base.args) || !base.args.every(arg => typeof arg === 'string') || base.args.at(-1) !== 'heavy-job' ||
      !process.env.NEXUS_HEAVY_CHANNEL_DIR || !path.isAbsolute(process.env.NEXUS_HEAVY_CHANNEL_DIR) || !/^[a-f0-9]{64}$/.test(process.env.NEXUS_HEAVY_CHANNEL_KEY || '') ||
      !process.env.NEXUS_HEAVY_CHANNEL_EPOCH || !process.env.NEXUS_HEAVY_CHANNEL_PUBLIC_KEY) { output(deny); return; }
  try {
    if (fs.realpathSync(directory) !== directory || fs.realpathSync(node) !== node || !fs.statSync(node).isFile() ||
        !['job-launch.cjs', 'request.cjs'].every(name => fs.lstatSync(path.join(directory,name)).isFile() && !fs.lstatSync(path.join(directory,name)).isSymbolicLink())) throw new Error('unavailable');
  } catch { output(deny); return; }
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const wrapped = `NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 ${quote(node)} ${quote(path.join(directory, 'job-launch.cjs'))} ${quote(kind)} "\${BASH:-\${SHELL:-/bin/sh}}" -c ${quote(input.CommandLine)}`;
  output({ decision: 'ask', overwrite: { CommandLine: wrapped } });
});

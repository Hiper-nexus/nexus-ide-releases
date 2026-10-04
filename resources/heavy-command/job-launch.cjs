// Runs only in the caller's inherited sandbox. Main constructs the fixed
// Apple stage-zero command; this bridge preserves cwd/env/stdio and exit.
const cp = require('node:child_process');
const kind = process.argv[2], file = process.argv[3], args = process.argv.slice(4);
let base;
try { base = JSON.parse(process.env.NEXUS_HEAVY_JOB_BASE); } catch { process.exit(78); }
if (!['typescript', 'tests', 'build', 'install'].includes(kind) || !file || !file.startsWith('/') || !base || base.file !== '/usr/bin/perl' || !Array.isArray(base.args) || !base.args.every((arg) => typeof arg === 'string') || base.args.at(-1) !== 'heavy-job') process.exit(78);
const env = { ...process.env }; delete env.NEXUS_HEAVY_HELPER;
let target = base.file, targetArgs = [...base.args, kind, '--', file, ...args];
if (env.NEXUS_HEAVY_LEASE) {
  try {
    const lease = cp.execFileSync(process.execPath, [require('node:path').join(__dirname, 'request.cjs'), String(process.pid), kind], {
      env: { ...env, NODE_OPTIONS: '', NEXUS_HEAVY_HELPER: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 370_000,
    }).trim();
    if (lease !== env.NEXUS_HEAVY_LEASE) throw new Error('unproved inherited lease');
    target = file; targetArgs = args;
  } catch { process.exit(78); }
}
// Bash observes FD3 before Node starts: do not mistake Node's internal pipe
// for a caller channel. Preserve only that existing pipe/socket in this
// subtree; no new file or IPC capability is opened.
const stdio = ['inherit', 'inherit', 'inherit'];
if (env.NEXUS_HEAVY_INHERITED_FD3 === '1') {
  try { const fd = require('node:fs').fstatSync(3); if (!fd.isFIFO() && !fd.isSocket()) process.exit(78); stdio.push(3); } catch { process.exit(78); }
}
delete env.NEXUS_HEAVY_INHERITED_FD3;
const job = cp.spawn(target, targetArgs, { env, stdio });
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => { try { job.kill(signal); } catch {} });
job.once('error', () => process.exit(127));
job.once('close', (code, signal) => { if (signal) { try { process.kill(process.pid, signal); } catch { process.exit(1); } } else process.exit(code ?? 1); });

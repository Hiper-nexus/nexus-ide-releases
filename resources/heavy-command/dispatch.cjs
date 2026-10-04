// A scoped Node agent's child boundary. Original executable/argv/shell and
// stdio reach the target unchanged, after this physical parent is admitted.
const path = require('node:path');
const cp = require('node:child_process');
const kind = process.argv[2], file = process.argv[3];
let args, shell;
try { args = JSON.parse(process.argv[4]); shell = JSON.parse(process.argv[5]); } catch { process.exit(78); }
if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string') || typeof file !== 'string' || !['typescript', 'tests', 'build', 'install'].includes(kind)) process.exit(78);
try {
  const lease = cp.execFileSync(process.execPath, [path.join(__dirname, 'request.cjs'), String(process.pid), kind], {
    env: { NEXUS_HEAVY_COMMAND_URL: process.env.NEXUS_HEAVY_COMMAND_URL, NEXUS_GATE_TOKEN: process.env.NEXUS_GATE_TOKEN, NEXUS_HEAVY_CURL: process.env.NEXUS_HEAVY_CURL,
      ...(process.env.NEXUS_HEAVY_LEASE ? { NEXUS_HEAVY_LEASE: process.env.NEXUS_HEAVY_LEASE } : {}) }, encoding: 'utf8', timeout: 370_000,
  }).trim();
  if (!lease || lease.length > 128) throw new Error('missing lease');
  process.env.NEXUS_HEAVY_LEASE = lease;
} catch {
  process.stderr.write('[Nexus] Heavy command not started: physical CPU/RAM admission unavailable.\n'); process.exit(78);
}
// This process is itself a descendant covered by the physical lease. Prevent
// its preload from recursively wrapping the already-admitted target a second time.
const child = cp.spawn(file, args, { env: process.env, shell, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.on('error', () => process.exit(127));
child.on('close', (code, signal) => { if (signal) { try { process.kill(process.pid, signal); } catch { process.exit(1); } } else process.exit(code ?? 1); });

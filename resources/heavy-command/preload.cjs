// Scoped mission-only admission before the physical Node TypeScript compiler
// loads its main module. Worker threads share the compiler PID and its lease.
const { isMainThread } = require('node:worker_threads');
if (isMainThread && process.env.NEXUS_HEAVY_COMMAND_URL && process.env.NEXUS_GATE_TOKEN && process.env.NEXUS_MISSION_ID && process.env.NEXUS_HEAVY_HELPER !== '1') {
  const path = require('node:path');
  const entry = process.argv[1] || '';
  const name = path.basename(entry).toLowerCase();
  const typescript = name === 'tsc' || ((name === 'tsc.js' || name === '_tsc.js') && /[\\/]typescript[\\/]/i.test(entry));
  if (typescript) {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, [path.join(__dirname, 'request.cjs'), String(process.pid)], {
        env: { ...process.env, NEXUS_HEAVY_HELPER: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 370_000,
      });
    } catch {
      process.stderr.write('[Nexus] TypeScript check not started: scoped CPU/RAM admission or process ownership could not be proved.\n');
      process.exit(78);
    }
  }
}

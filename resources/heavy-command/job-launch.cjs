// Runs only in the caller's inherited sandbox. Main constructs the fixed
// Apple stage-zero command; this bridge preserves cwd/env/stdio and exit.
const cp = require('node:child_process');
const transport = require('./grok-transport.cjs');
const kind = process.argv[2], file = process.argv[3], args = process.argv.slice(4);
async function main() {
  const relay = transport.signalRelay();
  try {
    const base = JSON.parse(process.env.NEXUS_HEAVY_JOB_BASE);
    if (!['typescript', 'tests', 'build', 'install'].includes(kind) || !file || !file.startsWith('/') ||
        !base || base.file !== '/usr/bin/perl' || !Array.isArray(base.args) ||
        !base.args.every(arg => typeof arg === 'string') || base.args.at(-1) !== 'heavy-job') throw new Error('invalid job');
    const env = { ...process.env }; delete env.NEXUS_HEAVY_HELPER;
    let target = base.file, targetArgs = [...base.args, kind, '--', file, ...args];
    if (env.NEXUS_HEAVY_LEASE) {
      const lease = await new Promise(resolve => {
        const validator = cp.spawn(process.execPath, [require('node:path').join(__dirname, 'request.cjs'), String(process.pid), kind], {
          env: { ...env, NODE_OPTIONS: '', NEXUS_HEAVY_HELPER: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
        });
        relay.bind(validator);
        let output = '', failed = false;
        const stop = () => { failed = true; try { validator.kill('SIGTERM'); } catch {} };
        const timer = setTimeout(stop, 370_000);
        validator.stdout.on('data', data => { output += data; if (output.length > 128) stop(); });
        validator.once('error', () => { failed = true; });
        validator.once('close', (code, signal) => {
          clearTimeout(timer); relay.bind(null);
          resolve(!failed && code === 0 && signal === null ? output.trim() : null);
        });
      });
      if (relay.signal.aborted || lease !== env.NEXUS_HEAVY_LEASE) throw new Error('unproved inherited lease');
      target = file; targetArgs = args;
    }
    // Bash observes FD3 before Node starts. Forward no accidental Node pipes.
    const stdio = ['inherit', 'inherit', 'inherit'];
    if (env.NEXUS_HEAVY_INHERITED_FD3 === '1') {
      const fd = require('node:fs').fstatSync(3);
      if (!fd.isFIFO() && !fd.isSocket()) throw new Error('invalid channel');
      stdio.push(3);
    }
    if (env.NEXUS_HEAVY_GROK_CHANNELS !== undefined) {
      if (env.NEXUS_HEAVY_GROK_CHANNELS !== '3,5' || stdio.length !== 4 || !transport.supported(file, args)) throw new Error('unknown transport');
      const fd = require('node:fs').fstatSync(5);
      if (!fd.isFIFO() && !fd.isSocket()) throw new Error('invalid channel');
      stdio.push('ignore', 5);
      transport.originalOptions(env); delete env.NEXUS_HEAVY_GROK_CHANNELS;
    }
    delete env.NEXUS_HEAVY_INHERITED_FD3;
    if (relay.signal.aborted) throw new Error('job cancelled');
    const job = cp.spawn(target, targetArgs, { env, stdio });
    relay.bind(job);
    let failed = false;
    job.once('error', () => { failed = true; });
    job.once('close', (code, signal) => relay.finish(failed ? 127 : code, signal));
  } catch { relay.finish(78, null); }
}
void main();

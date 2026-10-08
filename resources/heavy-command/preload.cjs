// Installed in Main-owned CLI env only; external shells have no scoped endpoint.
const { isMainThread } = require('node:worker_threads');
// NEXUS_HEAVY_HELPER=1 alone never exempts: any launcher can set it. It only
// exempts an EXACT trusted entrypoint, proved by the script's real path — this
// directory's own helpers, or a byte-identical copy of the bundled mission-shim
// client — and only when nothing else is preloaded into that process. Any other
// process (including a child that inherited the flag) stays admitted.
function trustedHelperEntry() {
  if (process.env.NEXUS_HEAVY_HELPER !== '1') return false;
  const fs = require('node:fs');
  const path = require('node:path');
  const real = (file) => { try { return fs.realpathSync(file); } catch { return null; } };
  const entry = typeof process.argv[1] === 'string' ? real(process.argv[1]) : null;
  const self = real(__filename);
  if (!entry || !self || process.execArgv.length > 0) return false;
  const options = process.env.NODE_OPTIONS || '';
  if (/(?:^|\s)(?:--import|--loader|--experimental-loader)(?:[=\s]|$)/.test(options)) return false;
  for (const match of options.matchAll(/(?:^|\s)(?:-r|--require)(?:=|\s+)("(?:[^"\\]|\\.)*"|\S+)/g)) {
    let required = match[1];
    try { if (required.startsWith('"')) required = JSON.parse(required); } catch { return false; }
    if (real(required) !== self) return false;
  }
  const directory = path.dirname(self);
  if (['request.cjs', 'classify.cjs', 'tool-hook.cjs', 'job-launch.cjs'].some((name) => entry === path.join(directory, name))) return true;
  const client = real(path.join(directory, '..', 'mission-shims', 'nx-shim.cjs'));
  if (!client || path.basename(entry) !== 'nx-shim.cjs') return false;
  if (entry === client) return true;
  try {
    const stat = fs.lstatSync(entry);
    return stat.isFile() && stat.size <= 1024 * 1024 && fs.readFileSync(entry).equals(fs.readFileSync(client));
  } catch { return false; }
}
if (isMainThread && process.env.NEXUS_HEAVY_COMMAND_URL && process.env.NEXUS_GATE_TOKEN && !trustedHelperEntry()) {
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const catalog = require('./catalog.cjs');
  const fs = require('node:fs');
  const real = (file) => { try { return fs.realpathSync(file); } catch { return file; } };
  const agentRoot = process.env.NEXUS_HEAVY_AGENT_ENTRY && real(process.argv[1]) === real(process.env.NEXUS_HEAVY_AGENT_ENTRY);
  const persistent = catalog.isPersistent(process.argv);
  // An exempt dispatcher marks only its direct Node target: without the Darwin
  // job base (Linux/Windows) an unknown target is still finite work to meter.
  const dispatched = process.env.NEXUS_HEAVY_DISPATCHED === '1';
  delete process.env.NEXUS_HEAVY_DISPATCHED;
  if (catalog.isDispatcher(process.argv)) process.env.NEXUS_HEAVY_DISPATCHED = '1';
  let admitted = persistent;
  function admit(kind) {
    if (!kind || admitted) return;
    try {
      if (process.env.NEXUS_HEAVY_JOB_BASE && !process.env.NEXUS_HEAVY_LEASE) {
        if (process.channel) throw new Error('unwrapped native IPC entry');
        const base = JSON.parse(process.env.NEXUS_HEAVY_JOB_BASE);
        if (base.file !== '/usr/bin/perl' || !Array.isArray(base.args) || base.args.at(-1) !== 'heavy-job') throw new Error('invalid native job base');
        try { execFileSync(base.file, [...base.args, kind, '--', process.execPath, ...process.execArgv, ...process.argv.slice(1)], { env: process.env, stdio: 'inherit' }); process.exit(0); }
        catch (error) { if (typeof error.status === 'number') process.exit(error.status); throw error; }
      }
      const requestEnv = { NEXUS_HEAVY_COMMAND_URL: process.env.NEXUS_HEAVY_COMMAND_URL, NEXUS_GATE_TOKEN: process.env.NEXUS_GATE_TOKEN, NEXUS_HEAVY_CURL: process.env.NEXUS_HEAVY_CURL,
        ...(process.env.NEXUS_HEAVY_LEASE ? { NEXUS_HEAVY_LEASE: process.env.NEXUS_HEAVY_LEASE } : {}) };
      for (const key of ['NEXUS_HEAVY_CHANNEL_DIR', 'NEXUS_HEAVY_CHANNEL_KEY', 'NEXUS_HEAVY_CHANNEL_EPOCH', 'NEXUS_HEAVY_CHANNEL_PUBLIC_KEY']) {
        if (process.env[key]) requestEnv[key] = process.env[key];
      }
      const lease = execFileSync(process.execPath, [path.join(__dirname, 'request.cjs'), String(process.pid), kind], {
        env: requestEnv,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 370_000,
      }).trim();
      if (!lease || lease.length > 128) throw new Error('missing physical lease');
      process.env.NEXUS_HEAVY_LEASE = lease;
      admitted = true;
    } catch {
      process.stderr.write('[Nexus] Heavy command not started: scoped CPU/RAM admission or process ownership could not be proved.\n');
      process.exit(78);
    }
  }
  if (!agentRoot) admit(catalog.entryKind(process.argv) || ((process.env.NEXUS_HEAVY_JOB_BASE || dispatched) && !persistent ? 'build' : null));
  // Require/eval and renamed package entry points still cross the module boundary.
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    let resolved; try { resolved = Module._resolveFilename(request, parent, isMain); } catch {}
    if (!agentRoot && !admitted) admit(catalog.moduleKind(resolved));
    return load.apply(this, arguments);
  };
  // The helper dispatch uses a captured primitive rather than another wrapper.
  if (process.argv[1] !== path.join(__dirname, 'dispatch.cjs')) require('./child-process.cjs')({ agentRoot: Boolean(agentRoot) });
  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!agentRoot && !admitted && result.url.startsWith('file:')) admit(catalog.moduleKind(require('node:url').fileURLToPath(result.url)));
      return result;
    } });
  }
}

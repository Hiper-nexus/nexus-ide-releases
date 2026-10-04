// Installed in Main-owned CLI env only; external shells have no scoped endpoint.
const { isMainThread } = require('node:worker_threads');
if (isMainThread && process.env.NEXUS_HEAVY_COMMAND_URL && process.env.NEXUS_GATE_TOKEN && process.env.NEXUS_HEAVY_HELPER !== '1') {
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const catalog = require('./catalog.cjs');
  const fs = require('node:fs');
  const real = (file) => { try { return fs.realpathSync(file); } catch { return file; } };
  const agentRoot = process.env.NEXUS_HEAVY_AGENT_ENTRY && real(process.argv[1]) === real(process.env.NEXUS_HEAVY_AGENT_ENTRY);
  const persistent = catalog.isPersistent(process.argv);
  let admitted = persistent;
  function admit(kind) {
    if (!kind || admitted) return;
    try {
      const lease = execFileSync(process.execPath, [path.join(__dirname, 'request.cjs'), String(process.pid), kind], {
        env: { NEXUS_HEAVY_COMMAND_URL: process.env.NEXUS_HEAVY_COMMAND_URL, NEXUS_GATE_TOKEN: process.env.NEXUS_GATE_TOKEN, NEXUS_HEAVY_CURL: process.env.NEXUS_HEAVY_CURL,
          ...(process.env.NEXUS_HEAVY_LEASE ? { NEXUS_HEAVY_LEASE: process.env.NEXUS_HEAVY_LEASE } : {}) },
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
  if (!agentRoot) admit(catalog.entryKind(process.argv));
  // Require/eval and renamed package entry points still cross the module boundary.
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    let resolved; try { resolved = Module._resolveFilename(request, parent, isMain); } catch {}
    if (!agentRoot && !admitted) admit(catalog.moduleKind(resolved));
    return load.apply(this, arguments);
  };
  // The helper dispatch uses a captured primitive rather than another wrapper.
  if (process.argv[1] !== path.join(__dirname, 'dispatch.cjs')) require('./child-process.cjs')();
  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!agentRoot && !admitted && result.url.startsWith('file:')) admit(catalog.moduleKind(require('node:url').fileURLToPath(result.url)));
      return result;
    } });
  }
}

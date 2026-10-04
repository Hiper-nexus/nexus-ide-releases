const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const catalog = require('./catalog.cjs');
const preload = path.join(__dirname, 'preload.cjs');
const dispatch = path.join(__dirname, 'dispatch.cjs');
module.exports = function install() {
  const originals = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'].map((key) => [key, cp[key]]));
  function plan(file, args, options = {}) {
    const env = { ...(options.env || process.env) };
    for (const key of ['NEXUS_HEAVY_CURL', 'NEXUS_HEAVY_AGENT_ENTRY', 'NEXUS_GATE_TOKEN', 'NEXUS_HEAVY_COMMAND_URL', 'NEXUS_HEAVY_DIR', 'NEXUS_HEAVY_NODE', 'NEXUS_HEAVY_BASH_ENV', 'NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_ORIG_BASH_ENV', 'NEXUS_HEAVY_ORIG_ZDOTDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]; else delete env[key];
    }
    delete env.NEXUS_HEAVY_HELPER;
    if (!(env.NODE_OPTIONS || '').includes(preload)) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim();
    if (process.env.NEXUS_HEAVY_BASH_ENV) env.BASH_ENV = process.env.NEXUS_HEAVY_BASH_ENV;
    if (process.env.NEXUS_HEAVY_DIR) env.ZDOTDIR = process.env.NEXUS_HEAVY_DIR;
    const node = file === process.execPath || /^node(?:\.exe)?$/i.test(path.basename(file));
    const kind = node ? catalog.entryKind([process.execPath, ...args]) : catalog.commandKind([file, ...args].join(' '));
    if (node || !kind || file === process.execPath && args[0] === dispatch) return { file, args, options: { ...options, env } };
    return { file: process.execPath, args: [dispatch, kind, file, JSON.stringify(args), JSON.stringify(options.shell || false)], options: { ...options, env, shell: false } };
  }
  cp.spawn = function(file, args, options) { if (!Array.isArray(args)) { options = args; args = []; } const p = plan(file, args, options); return originals.spawn(p.file, p.args, p.options); };
  cp.spawnSync = function(file, args, options) { if (!Array.isArray(args)) { options = args; args = []; } const p = plan(file, args, options); return originals.spawnSync(p.file, p.args, p.options); };
  cp.execFile = function(file, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    const p = plan(file, args, options); return originals.execFile(p.file, p.args, p.options, callback);
  };
  cp.execFileSync = function(file, args, options) { if (!Array.isArray(args)) { options = args; args = []; } const p = plan(file, args, options); return originals.execFileSync(p.file, p.args, p.options); };
  cp.exec = function(command, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    const shell = options.shell || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh');
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    return cp.execFile(shell, args, { ...options, shell: false }, callback);
  };
  cp.execSync = function(command, options = {}) {
    const shell = options.shell || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh');
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    return cp.execFileSync(shell, args, { ...options, shell: false });
  };
  for (const key of ['exec', 'execFile']) cp[key][promisify.custom] = function(...args) {
    return new Promise((resolve, reject) => cp[key](...args, (error, stdout, stderr) => { if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr }); }));
  };
  require('node:module').syncBuiltinESMExports();
  return originals;
};

const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const catalog = require('./catalog.cjs');
const preload = path.join(__dirname, 'preload.cjs');
const dispatch = path.join(__dirname, 'dispatch.cjs');
module.exports = function install() {
  const originals = Object.fromEntries(['fork', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'].map((key) => [key, cp[key]]));
  function plan(file, args, options = {}) {
    const env = { ...(options.env || process.env) };
    for (const key of ['NEXUS_HEAVY_JOB_BASE', 'NEXUS_HEAVY_CURL', 'NEXUS_HEAVY_AGENT_ENTRY', 'NEXUS_GATE_TOKEN', 'NEXUS_HEAVY_COMMAND_URL', 'NEXUS_HEAVY_DIR', 'NEXUS_HEAVY_NODE', 'NEXUS_HEAVY_BASH_ENV', 'NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_ORIG_BASH_ENV', 'NEXUS_HEAVY_ORIG_ZDOTDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]; else delete env[key];
    }
    const helperEntry = typeof args[0] === 'string' && ['request.cjs', 'classify.cjs', 'tool-hook.cjs', 'job-launch.cjs'].some((name) => args[0] === path.join(__dirname, name));
    if (helperEntry && (file === process.execPath || /^node(?:\.exe)?$/i.test(path.basename(file)))) return { file, args, options: { ...options, env: { ...env, NODE_OPTIONS: '', NEXUS_HEAVY_HELPER: '1' } } };
    delete env.NEXUS_HEAVY_HELPER;
    if (!(env.NODE_OPTIONS || '').includes(preload)) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim();
    if (process.env.NEXUS_HEAVY_BASH_ENV) env.BASH_ENV = process.env.NEXUS_HEAVY_BASH_ENV;
    if (process.env.NEXUS_HEAVY_DIR) env.ZDOTDIR = process.env.NEXUS_HEAVY_DIR;
    const node = file === process.execPath || /^node(?:\.exe)?$/i.test(path.basename(file));
    const kind = node ? catalog.entryKind([process.execPath, ...args]) || (process.env.NEXUS_HEAVY_JOB_BASE && !catalog.isPersistent([process.execPath, ...args]) ? 'build' : null) : catalog.commandKind([file, ...args].join(' '));
    if (kind && env.NEXUS_HEAVY_JOB_BASE && !env.NEXUS_HEAVY_LEASE) {
      const fs = require('node:fs');
      const resolve = (value) => { if (path.isAbsolute(value)) return value; return (env.PATH || '').split(path.delimiter).map((part) => path.join(part, value)).find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } }); };
      const base = JSON.parse(env.NEXUS_HEAVY_JOB_BASE);
      let target = resolve(file), targetArgs = args;
      if (options.shell) { target = typeof options.shell === 'string' ? options.shell : '/bin/sh'; targetArgs = ['-c', [file, ...args].join(' ')]; }
      if (!target || base.file !== '/usr/bin/perl' || !Array.isArray(base.args) || base.args.at(-1) !== 'heavy-job') throw new Error('native_heavy_job_authority_unavailable');
      return { file: base.file, args: [...base.args, kind, '--', target, ...targetArgs], options: { ...options, env, shell: false } };
    }
    if (node || !kind || file === process.execPath && args[0] === dispatch) return { file, args, options: { ...options, env } };
    return { file: process.execPath, args: [dispatch, kind, file, JSON.stringify(args), JSON.stringify(options.shell || false)], options: { ...options, env, shell: false } };
  }
  cp.fork = function(modulePath, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    options = options || {};
    const node = options.execPath || process.execPath, execArgs = options.execArgv || process.execArgv;
    const p = plan(node, [modulePath, ...args], options);
    if (p.file === node) return originals.fork(modulePath, args, p.options);
    const prefix = p.args.slice(0, -args.length || undefined);
    return originals.fork(modulePath, args, { ...p.options, execPath: p.file, execArgv: [...prefix.slice(0, -1), ...execArgs], shell: false });
  };
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
    let child;
    const pending = new Promise((resolve, reject) => { child = cp[key](...args, (error, stdout, stderr) => { if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr }); }); });
    pending.child = child;
    return pending;
  };
  require('node:module').syncBuiltinESMExports();
  return originals;
};

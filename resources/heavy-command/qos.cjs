// Darwin background QoS for an already-admitted heavy job. taskpolicy -b
// is setpriority(PRIO_DARWIN_BG); the man page says children inherit it.
// Visible as getpriority(PRIO_DARWIN_PROCESS=4) === 1, not as nice.
// Fail-open: non-darwin, NEXUS_HEAVY_QOS=0, or no taskpolicy keeps a direct spawn.
const fs = require('node:fs');
const TASKPOLICY = '/usr/sbin/taskpolicy';

function spawnBackground(cp, file, args, options) {
  if (process.platform !== 'darwin' || process.env.NEXUS_HEAVY_QOS === '0' || file === TASKPOLICY) {
    return cp.spawn(file, args, options);
  }
  try { fs.accessSync(TASKPOLICY, fs.constants.X_OK); } catch { return cp.spawn(file, args, options); }
  // Node's unix shell mode is `[file, ...args].join(' ')` under /bin/sh -c.
  // taskpolicy must exec that shell; shell:true would wrap taskpolicy itself.
  const shell = options && options.shell;
  if (shell) {
    const bin = typeof shell === 'string' ? shell : '/bin/sh';
    return cp.spawn(TASKPOLICY, ['-b', bin, '-c', [file, ...args].join(' ')], { ...options, shell: false });
  }
  return cp.spawn(TASKPOLICY, ['-b', file, ...args], options);
}

module.exports = { spawnBackground };

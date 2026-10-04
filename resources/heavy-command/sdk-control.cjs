// Measured MiniMax 0.5.5 parent-death guardian. This fixed IPC service performs
// no project work; the separately spawned target still crosses admission.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const GUARDIAN = 'cf98a766ebc1b65f6947b4136f47843ca8d4966b55e4329b79b6354679c2dd00';
module.exports = function providerControl(file, args, options, entry) {
  if (!entry || !path.isAbsolute(entry) || args.length !== 6 || args[0] !== '--input-type=module' || args[1] !== '--eval' || typeof args[2] !== 'string' ||
      file !== process.execPath || options.shell !== undefined && options.shell !== false ||
      Object.keys(options).some(key => !['detached', 'stdio', 'env', 'shell', 'windowsHide'].includes(key)) ||
      options.windowsHide !== undefined && options.windowsHide !== true ||
      !options.env || Object.getPrototypeOf(options.env) !== Object.prototype && Object.getPrototypeOf(options.env) !== null ||
      Object.keys(options.env).some(key => !['SystemRoot', 'windir', 'ELECTRON_RUN_AS_NODE'].includes(key) ||
        typeof options.env[key] !== 'string' || (key === 'ELECTRON_RUN_AS_NODE'
          ? !process.versions.electron || options.env[key] !== '1' : options.env[key] !== process.env[key])) ||
      options.detached !== true || JSON.stringify(options.stdio) !== JSON.stringify(['ignore', 'ignore', 'ignore', 'ipc']) ||
      !/^\d+$/.test(args[3]) || Number(args[3]) <= 0 || !/^\d+$/.test(args[4]) || !args[5] || args[5].length > 128 ||
      createHash('sha256').update(args[2]).digest('hex') !== GUARDIAN) return false;
  try {
    if (!fs.statSync(file).isFile() || fs.realpathSync(file) !== fs.realpathSync(process.execPath)) return false;
    const real = fs.realpathSync(entry); if (path.basename(real) !== 'cli.js') return false;
    const packageFile = path.join(path.dirname(real), 'package.json'); if (fs.statSync(packageFile).size > 16384) return false;
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    return metadata.name === '@minimax-ai/code' && metadata.version === '0.5.5';
  } catch { return false; }
};

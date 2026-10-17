import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  UPSTREAM_CONOUT_CONNECTION_SHA256,
  UPSTREAM_WORKER_SHA256,
  WIN32_SHARED_WORKER_MARKER,
  patchConoutConnectionSource,
  patchNodePtyWin32,
  sharedConoutWorkerSource,
} from './patch-node-pty-win32.mjs';

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const UPSTREAM_CONNECTION = [
  'var ConoutConnection = /** @class */ (function () {',
  '    function ConoutConnection(_conoutPipeName, _useConptyDll) {',
  '        var _this = this;',
  '        this._conoutPipeName = _conoutPipeName;',
  '        this._useConptyDll = _useConptyDll;',
  '        this._isDisposed = false;',
  '        this._onReady = new eventEmitter2_1.EventEmitter2();',
  '        var workerData = {',
  '            conoutPipeName: _conoutPipeName',
  '        };',
  "        var scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  "        this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData: workerData });",
  "        this._worker.on('message', function (message) {",
  '            switch (message) {',
  '                case 1 /* READY */:',
  '                    _this._onReady.fire();',
  '                    return;',
  '                default:',
  "                    console.warn('Unexpected ConoutWorkerMessage', message);",
  '            }',
  '        });',
  '    }',
  '    ConoutConnection.prototype._destroySocket = function () {',
  '        return __awaiter(this, void 0, void 0, function () {',
  '            return __generator(this, function (_a) {',
  '                switch (_a.label) {',
  '                    case 0: return [4 /*yield*/, this._worker.terminate()];',
  '                    case 1:',
  '                        _a.sent();',
  '                        return [2 /*return*/];',
  '                }',
  '            });',
  '        });',
  '    };',
  '    return ConoutConnection;',
  '}());',
  'exports.ConoutConnection = ConoutConnection;',
].join('\n');

function fixture({ connection = UPSTREAM_CONNECTION, worker = 'upstream worker' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pty-win32-patch-'));
  tempDirs.push(root);
  const packageRoot = path.join(root, 'node_modules', '@lydell', 'node-pty-win32-x64');
  const connectionPath = path.join(packageRoot, 'lib', 'windowsConoutConnection.js');
  const workerPath = path.join(packageRoot, 'lib', 'worker', 'conoutSocketWorker.js');
  fs.mkdirSync(path.dirname(workerPath), { recursive: true });
  fs.writeFileSync(connectionPath, connection);
  fs.writeFileSync(workerPath, worker);
  return { root, connectionPath, workerPath };
}

describe('patchConoutConnectionSource', () => {
  it('rewrites per-session worker fork to the shared relay worker', () => {
    const patched = patchConoutConnectionSource(UPSTREAM_CONNECTION);
    expect(patched).not.toBeNull();
    expect(patched).toContain(WIN32_SHARED_WORKER_MARKER);
    expect(patched).toContain('sharedConoutWorker(scriptPath)');
    expect(patched).toContain('{ attach: _conoutPipeName }');
    expect(patched).toContain('{ detach: this._conoutPipeName }');
    expect(patched).not.toContain('workerData');
    expect(patched).not.toContain('this._worker.terminate()');
  });

  it('is idempotent', () => {
    const patched = patchConoutConnectionSource(UPSTREAM_CONNECTION);
    expect(patchConoutConnectionSource(patched)).toBe(patched);
  });

  it('fails closed on an unexpected upstream revision', () => {
    expect(patchConoutConnectionSource('var somethingElse = 1;')).toBeNull();
  });
});

describe('patchNodePtyWin32', () => {
  it.skipIf(process.platform !== 'win32')('patches both files and re-runs cleanly', () => {
    // Fixture contents are placeholders, so this path exercises the marker
    // branch: pre-patched content must be left untouched.
    const { root, connectionPath, workerPath } = fixture({
      connection: `// ${WIN32_SHARED_WORKER_MARKER}\n${UPSTREAM_CONNECTION}`,
      worker: `// ${WIN32_SHARED_WORKER_MARKER}\nupstream worker`,
    });
    expect(patchNodePtyWin32(root)).toBe('already-patched');
    expect(fs.readFileSync(connectionPath, 'utf8')).toContain(WIN32_SHARED_WORKER_MARKER);
    expect(fs.readFileSync(workerPath, 'utf8')).toContain(WIN32_SHARED_WORKER_MARKER);
  });

  it.skipIf(process.platform !== 'win32')('refuses an unrecognized vendored revision', () => {
    const { root } = fixture({ connection: 'var unexpected = true;' });
    expect(() => patchNodePtyWin32(root)).toThrow(/unexpected @lydell\/node-pty-win32-x64/);
  });

  it('worker source declares the multiplexed relay protocol', () => {
    const source = sharedConoutWorkerSource();
    expect(source).toContain(WIN32_SHARED_WORKER_MARKER);
    expect(source).toContain('message.attach');
    expect(source).toContain('message.detach');
    expect(source).toContain('getWorkerPipeName(conoutPipeName)');
    expect(source).toContain('postMessage(1 /* READY */)');
  });
});

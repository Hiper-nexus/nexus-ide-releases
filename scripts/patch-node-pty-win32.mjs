/**
 * Patches the vendored @lydell/node-pty-win32-x64 ConoutConnection so every PTY
 * session shares ONE relay Worker instead of forking a V8 isolate per session.
 *
 * Upstream creates a worker_threads.Worker per session solely to drain that
 * session's conout named pipe off the host thread (ClosePseudoConsole
 * deadlock avoidance). Each Worker is a V8 isolate — measured ~11 MB private
 * per pane at 16 panes on this package. The patched worker hosts every
 * session's relay in one thread; the per-session drain semantics are
 * unchanged because each conout pipe is still drained off the main thread.
 *
 * Protocol (worker <-> host):
 *   host   -> worker  { attach: conoutPipeName } / { detach: conoutPipeName }
 *   worker -> host    1 (startup READY) / { ready: conoutPipeName } per attach
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_PTY_WIN32_PACKAGE = '@lydell/node-pty-win32-x64';
export const UPSTREAM_CONOUT_CONNECTION_SHA256 =
  '1440f70908fb1f55911ac8e936a1230f68a9c00c03096fcef6788eac6aad9d62';
export const UPSTREAM_WORKER_SHA256 =
  '3e4bac095ac3870c3248a7302f5d10217de625f30c32b7000fe48a34788e47ac';
export const WIN32_SHARED_WORKER_MARKER = 'NEXUS_WIN32_SHARED_CONOUT_WORKER';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Full replacement for lib/worker/conoutSocketWorker.js. */
export function sharedConoutWorkerSource() {
  return `"use strict";
/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 *
 * ${WIN32_SHARED_WORKER_MARKER}
 * Upstream forked one Worker per PTY session solely to drain that session's
 * conout pipe off the host thread. This worker hosts every session's relay
 * instead: the host posts {attach: conoutPipeName} / {detach: conoutPipeName};
 * each attached pipe gets its own conout socket and per-session relay server
 * on getWorkerPipeName(conoutPipeName), which the terminal's out socket
 * connects to exactly as before.
 */
var worker_threads_1 = require("worker_threads");
var net_1 = require("net");
var conout_1 = require("../shared/conout");
var relays = new Map();
if (!worker_threads_1.parentPort) {
    throw new Error('worker_threads parentPort is null');
}
var parentPort = worker_threads_1.parentPort;
function attach(conoutPipeName) {
    if (relays.has(conoutPipeName)) {
        parentPort.postMessage({ ready: conoutPipeName });
        return;
    }
    var relay = { conoutSocket: null, server: null };
    relays.set(conoutPipeName, relay);
    var conoutSocket = new net_1.Socket();
    conoutSocket.setEncoding('utf8');
    relay.conoutSocket = conoutSocket;
    conoutSocket.on('error', function () {
        // Surface the pending spawn anyway; the host's connection timeout
        // fallback otherwise waits the full 5s per broken pipe.
        parentPort.postMessage({ ready: conoutPipeName });
    });
    conoutSocket.connect(conoutPipeName, function () {
        var server = net_1.createServer(function (workerSocket) {
            conoutSocket.pipe(workerSocket);
        });
        server.on('error', function () { });
        relay.server = server;
        server.listen(conout_1.getWorkerPipeName(conoutPipeName));
        parentPort.postMessage({ ready: conoutPipeName });
    });
}
function detach(conoutPipeName) {
    var relay = relays.get(conoutPipeName);
    if (!relay) {
        return;
    }
    relays.delete(conoutPipeName);
    try {
        if (relay.conoutSocket) relay.conoutSocket.destroy();
    } catch (_a) { }
    try {
        if (relay.server) relay.server.close();
    } catch (_b) { }
}
parentPort.on('message', function (message) {
    if (message && message.attach) {
        attach(message.attach);
    } else if (message && message.detach) {
        detach(message.detach);
    }
});
parentPort.postMessage(1 /* READY */);
`;
}

const CONSTRUCTOR_BEFORE = [
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
].join('\n');

const CONSTRUCTOR_AFTER = [
  "        var scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  '        var worker = sharedConoutWorker(scriptPath);',
  '        this._worker = worker;',
  '        var onWorkerMessage = function (message) {',
  '            if (message && message.ready === _conoutPipeName) {',
  "                worker.off('message', onWorkerMessage);",
  '                _this._onReady.fire();',
  '            }',
  '        };',
  '        this._onWorkerMessage = onWorkerMessage;',
  "        worker.on('message', onWorkerMessage);",
  '        sharedConoutWorkerReady(scriptPath).then(function () {',
  '            var live = sharedConoutWorker(scriptPath);',
  '            if (live !== _this._worker) {',
  '                _this._worker = live;',
  "                live.on('message', _this._onWorkerMessage);",
  '            }',
  '            if (!_this._isDisposed) {',
  '                _this._worker.postMessage({ attach: _conoutPipeName });',
  '            }',
  '        });',
].join('\n');

const DESTROY_BEFORE = [
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
].join('\n');

const DESTROY_AFTER = [
  '    ConoutConnection.prototype._destroySocket = function () {',
  '        return __awaiter(this, void 0, void 0, function () {',
  '            return __generator(this, function (_a) {',
  '                if (this._onWorkerMessage) {',
  "                    this._worker.off('message', this._onWorkerMessage);",
  '                    this._onWorkerMessage = undefined;',
  '                }',
  '                // Nexus: the shared relay outlives the session - detach only.',
  '                this._worker.postMessage({ detach: this._conoutPipeName });',
  '                return [2 /*return*/];',
  '            });',
  '        });',
  '    };',
].join('\n');

const SHARED_HELPERS = `
// [${WIN32_SHARED_WORKER_MARKER}]
/**
 * Nexus: one relay Worker drains every session's conout pipe. Upstream forked
 * a Worker per PTY session (a V8 isolate each; measured ~11 MB private per
 * pane at 16 panes). The per-session drain that avoids the
 * ClosePseudoConsole deadlock still runs off the host thread, inside this
 * shared worker. If the worker exits, the next connection re-creates it.
 */
var _sharedConoutWorker = null;
var _sharedConoutWorkerReady = null;
function sharedConoutWorker(scriptPath) {
    if (_sharedConoutWorker === null) {
        (function () {
            var worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'));
            // One 'message' listener per connection pending its READY is by
            // design; >10 panes would trip the default listener cap.
            worker.setMaxListeners(0);
            _sharedConoutWorker = worker;
            _sharedConoutWorkerReady = new Promise(function (resolve) {
                var onReady = function (message) {
                    if (message === 1 /* READY */) {
                        worker.off('message', onReady);
                        resolve();
                    }
                };
                worker.on('message', onReady);
            });
            worker.once('exit', function () {
                if (_sharedConoutWorker === worker) {
                    _sharedConoutWorker = null;
                    _sharedConoutWorkerReady = null;
                }
            });
        })();
    }
    return _sharedConoutWorker;
}
function sharedConoutWorkerReady(scriptPath) {
    sharedConoutWorker(scriptPath);
    return _sharedConoutWorkerReady;
}
`;

/**
 * Returns the patched source, or null when the file is already patched or is
 * not the expected upstream revision (caller decides how to handle).
 */
export function patchConoutConnectionSource(source) {
  if (source.includes(WIN32_SHARED_WORKER_MARKER)) return source;
  if (!source.includes(CONSTRUCTOR_BEFORE) || !source.includes(DESTROY_BEFORE)) {
    return null;
  }
  return (
    source
      .replace(CONSTRUCTOR_BEFORE, CONSTRUCTOR_AFTER)
      .replace(DESTROY_BEFORE, DESTROY_AFTER) + SHARED_HELPERS
  );
}

/**
 * Patches the vendored win32 node-pty package under `repoRoot/node_modules`.
 * Non-win32 hosts return 'skipped' without touching anything.
 */
export function patchNodePtyWin32(repoRoot) {
  if (process.platform !== 'win32') return 'skipped';
  const packageRoot = path.join(
    repoRoot,
    'node_modules',
    '@lydell',
    'node-pty-win32-x64',
  );
  const connectionPath = path.join(packageRoot, 'lib', 'windowsConoutConnection.js');
  const workerPath = path.join(packageRoot, 'lib', 'worker', 'conoutSocketWorker.js');
  if (!fs.existsSync(connectionPath) || !fs.existsSync(workerPath)) {
    return 'absent';
  }

  const connection = fs.readFileSync(connectionPath, 'utf8');
  const worker = fs.readFileSync(workerPath, 'utf8');
  const connectionPatched = connection.includes(WIN32_SHARED_WORKER_MARKER);
  const workerPatched = worker.includes(WIN32_SHARED_WORKER_MARKER);

  if (!connectionPatched && sha256(connection) !== UPSTREAM_CONOUT_CONNECTION_SHA256) {
    throw new Error(
      'unexpected @lydell/node-pty-win32-x64 windowsConoutConnection.js revision; ' +
        'refusing to patch (update UPSTREAM_CONOUT_CONNECTION_SHA256 after review)',
    );
  }
  if (!workerPatched && sha256(worker) !== UPSTREAM_WORKER_SHA256) {
    throw new Error(
      'unexpected @lydell/node-pty-win32-x64 conoutSocketWorker.js revision; ' +
        'refusing to patch (update UPSTREAM_WORKER_SHA256 after review)',
    );
  }

  let changed = false;
  if (!workerPatched) {
    fs.writeFileSync(workerPath, sharedConoutWorkerSource());
    changed = true;
  }
  if (!connectionPatched) {
    const patched = patchConoutConnectionSource(connection);
    if (patched === null) throw new Error('conout connection anchors not found');
    fs.writeFileSync(connectionPath, patched);
    changed = true;
  }
  return changed ? 'patched' : 'already-patched';
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const status = patchNodePtyWin32(repoRoot);
  if (status !== 'skipped' && status !== 'absent') {
    console.log(`[patch-node-pty-win32] ${status}`);
  }
}

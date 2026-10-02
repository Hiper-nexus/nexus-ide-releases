import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const API_AVAILABLE = `Boolean(window.nexus &&
  typeof window.nexus.settings?.uiGet === 'function' &&
  typeof window.nexus.settings?.uiSet === 'function' &&
  typeof window.nexus.ops?.releaseReadiness === 'function')`;
const VERSION = `(async () => {
  const value = await window.nexus.ops.releaseReadiness();
  return {appVersion: value?.appVersion, packaged: value?.packaged};
})()`;
const GET_PIXEL_MODE = `(async () => (await window.nexus.settings.uiGet())?.pixelMode)()`;
const SET_PIXEL_MODE = `(async () => { await window.nexus.settings.uiSet({pixelMode:true}); return true; })()`;

function endpoint(raw, port, kind) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid CDP endpoint'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port ||
      url.username || url.password || url.hash || url.search ||
      !new RegExp(`^/devtools/${kind}/[A-Za-z0-9_-]+$`).test(url.pathname)) {
    throw new Error('invalid CDP endpoint');
  }
  return url.href;
}

/** The caller owns the isolated profile and the real child process lifecycle. */
export async function probeRestartPreferences(child, {
  userData, phase, expectedVersion, timeoutMs = 30_000, signal: callerSignal,
}) {
  if (phase !== 'write' && phase !== 'read') throw new Error('invalid restart probe phase');
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error('invalid expected version');
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('invalid restart probe profile');
  if (!Number.isSafeInteger(child?.pid) || child.pid < 1 || typeof child.once !== 'function' || typeof child.removeListener !== 'function') throw new Error('invalid restart probe child');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('invalid restart probe timeout');
  if (callerSignal !== undefined && (typeof callerSignal.addEventListener !== 'function' || typeof callerSignal.removeEventListener !== 'function')) throw new Error('invalid restart probe signal');
  const controller = new AbortController();
  const signal = controller.signal;
  const resources = new Set();
  const navigationIncompleteErrors = new WeakSet();
  const abort = message => { if (!signal.aborted) controller.abort(new Error(message)); };
  const onCallerAbort = () => abort('restart probe cancelled');
  const onExit = () => abort('restart probe child exited');
  const onError = () => abort('restart probe child failed');
  child.once('exit', onExit);
  child.once('close', onExit);
  child.once('error', onError);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => abort('restart probe timed out'), timeoutMs);
  if (callerSignal?.aborted) onCallerAbort();
  if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) onExit();
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  async function pause() {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(delay); reject(signal.reason); };
      const delay = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 50);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function targets(port) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', signal, agent: false }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('CDP discovery failed')); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; if (body.length > 1_048_576) req.destroy(new Error('CDP discovery response too large')); });
        res.on('error', () => reject(new Error('CDP discovery failed')));
        res.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (!Array.isArray(value) || value.length > 64) throw new Error();
            resolve(value);
          } catch { reject(new Error('invalid CDP discovery response')); }
        });
      });
      const destroy = () => req.destroy();
      resources.add(destroy);
      req.on('close', () => resources.delete(destroy));
      req.on('error', () => reject(signal.aborted ? signal.reason : new Error('CDP discovery failed')));
    });
  }
  async function connect(url) {
    signal.throwIfAborted();
    const socket = new WebSocket(url, { followRedirects: false, maxPayload: 1_048_576, handshakeTimeout: timeoutMs });
    const pending = new Map();
    let nextId = 0;
    const dispose = () => {
      resources.delete(dispose);
      socket.terminate();
    };
    resources.add(dispose);
    let rejectReady;
    const ready = new Promise((resolve, reject) => { rejectReady = reject; socket.once('open', resolve); });
    const rejectPending = () => {
      const error = signal.aborted ? signal.reason : new Error('CDP connection closed');
      rejectReady(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    socket.on('error', rejectPending);
    socket.on('close', () => { resources.delete(dispose); rejectPending(); });
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { rejectPending(); dispose(); return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        const code = Number.isSafeInteger(message.error.code) ? message.error.code : 'unavailable';
        const error = new Error(`CDP command failed: method=${request.method} stage=${request.stage} code=${code}`);
        if (request.method === 'Runtime.evaluate' && request.stage === 'api-availability' &&
            code === -32000 && message.error.message === 'Inspected target navigated or closed') {
          navigationIncompleteErrors.add(error);
        }
        request.reject(error);
      }
      else request.resolve(message.result);
    });
    await Promise.race([ready, aborted]);
    const send = (method, params = {}, stage) => {
      signal.throwIfAborted();
      const id = ++nextId;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method, stage });
        socket.send(JSON.stringify({ id, method, params }), error => {
          if (error) { pending.delete(id); reject(new Error(`CDP command failed: method=${method} stage=${stage} code=unavailable`)); }
        });
      });
      return Promise.race([response, aborted]);
    };
    return {
      send, dispose,
      async evaluate(expression, stage) {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, stage);
        if (result?.exceptionDetails || !result?.result) throw new Error('restart probe browser validation failed');
        return result.result.value;
      },
    };
  }
  async function run() {
    const discoveryStarted = performance.now();
    let transientRounds = 0;
    let port, browserPath;
    for (;;) {
      signal.throwIfAborted();
      try {
        const active = await fs.readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
        const lines = active.trim().split(/\r?\n/);
        if (lines.length !== 2 || !/^[1-9]\d{0,4}$/.test(lines[0]) || Number(lines[0]) > 65535) throw new Error('invalid CDP endpoint');
        [port, browserPath] = [Number(lines[0]), lines[1]];
        endpoint(`ws://127.0.0.1:${port}${browserPath}`, port, 'browser');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await pause();
      }
    }
    // A stale profile file must never redirect the proof to an earlier launch.
    const browser = await connect(endpoint(`ws://127.0.0.1:${port}${browserPath}`, port, 'browser'));
    const processes = await browser.send('SystemInfo.getProcessInfo', {}, 'browser-process-identity');
    const browserProcesses = processes?.processInfo?.filter(entry => entry.type === 'browser');
    if (!Array.isArray(browserProcesses) || browserProcesses.length !== 1 || Number(browserProcesses[0].id) !== child.pid) throw new Error('CDP process identity mismatch');
    browser.dispose();
    let selected;
    for (;;) {
      signal.throwIfAborted();
      const listing = await targets(port);
      const matches = [];
      let incomplete = false;
      for (const target of listing.filter(entry => entry?.type === 'page')) {
        const page = await connect(endpoint(target.webSocketDebuggerUrl, port, 'page'));
        try {
          if (await page.evaluate(API_AVAILABLE, 'api-availability') === true) matches.push(page);
          else page.dispose();
        } catch (error) {
          page.dispose();
          if (!navigationIncompleteErrors.has(error)) throw error;
          incomplete = true;
          break;
        }
      }
      if (incomplete) {
        for (const page of matches) page.dispose();
        transientRounds += 1;
        process.stdout.write(`[smoke] restart-discovery ${JSON.stringify({
          phase, transientRounds, elapsedMs: Math.round(performance.now() - discoveryStarted),
          classification: 'target-navigated-or-closed',
        })}\n`);
        await pause();
        continue;
      }
      if (matches.length > 1) throw new Error('ambiguous Nexus CDP page');
      if (matches.length === 1) { [selected] = matches; break; }
      await pause();
    }
    const version = await selected.evaluate(VERSION, 'app-version');
    if (version?.packaged !== true) throw new Error('restart probe target is not packaged');
    if (version.appVersion !== expectedVersion) throw new Error('restart probe version mismatch');
    const initial = await selected.evaluate(GET_PIXEL_MODE, 'preference-read');
    if (phase === 'write') {
      if (initial !== false) throw new Error('restart probe initial preference mismatch');
      await selected.evaluate(SET_PIXEL_MODE, 'preference-write');
      if (await selected.evaluate(GET_PIXEL_MODE, 'preference-read') !== true) throw new Error('restart probe persisted preference mismatch');
    } else if (initial !== true) throw new Error('restart probe persisted preference mismatch');
    signal.throwIfAborted();
    return { phase, pid: child.pid, appVersion: version.appVersion, packaged: true, pixelMode: true };
  }
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    child.removeListener('exit', onExit);
    child.removeListener('close', onExit);
    child.removeListener('error', onError);
    abort('restart probe closed');
    for (const dispose of [...resources]) dispose();
  }
}

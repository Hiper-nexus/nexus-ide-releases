import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeRestartPreferences } from './smoke-packaged-restart-probe.mjs';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
async function fixture(options = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-restart-probe-'));
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null });
  let pixelMode = options.initial ?? false;
  const operations = [];
  const peers = new Set();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (options.httpStall) return;
    const targets = options.targets?.(port) ?? [{ id: 'page-a', type: 'page', url: 'file:///fixture.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-a` }];
    res.writeHead(options.httpStatus ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(targets));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const ws = new WebSocketServer({ server });
  ws.on('connection', (peer, req) => {
    peers.add(peer); peer.on('close', () => peers.delete(peer));
    peer.on('message', async bytes => {
      const message = JSON.parse(String(bytes));
      if (options.rpcStall) return;
      if (options.rpcErrorWhen?.(message, req)) {
        peer.send(JSON.stringify({ id: message.id, error: options.rpcError }));
        return;
      }
      if (message.method === 'SystemInfo.getProcessInfo') {
        peer.send(JSON.stringify({ id: message.id, result: { processInfo: [{ type: 'browser', id: options.browserPid ?? child.pid, cpuTime: 0 }] } }));
        return;
      }
      if (message.method !== 'Runtime.evaluate') throw new Error('unexpected CDP command');
      const nexus = {
        settings: {
          uiGet: async () => { operations.push('get'); return { pixelMode }; },
          uiSet: async patch => { operations.push('set'); if (options.forbidSet) throw new Error('read phase must never set'); if (!options.dropWrite) pixelMode = patch.pixelMode; return { pixelMode }; },
        },
        ops: { releaseReadiness: async () => {
          operations.push('version');
          if ((options.versionFailures ?? 0) >= operations.filter(op => op === 'version').length) {
            throw new Error('No handler registered for ops:releaseReadiness');
          }
          return { appVersion: options.version ?? '0.76.166', packaged: options.packaged ?? true, privateField: 'must not appear in proof' };
        } },
      };
      try {
        const value = await vm.runInNewContext(message.params.expression, { window: options.noApi ? {} : { nexus } });
        peer.send(JSON.stringify({ id: message.id, result: { result: { type: typeof value, value } } }));
      } catch {
        peer.send(JSON.stringify({ id: message.id, result: { exceptionDetails: { text: 'fixture exception' } } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await fs.writeFile(path.join(userData, 'DevToolsActivePort'), `${port}\n/devtools/browser/browser-a\n`);
  cleanup.push(async () => {
    for (const peer of peers) peer.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await fs.rm(userData, { recursive: true, force: true });
  });
  return { child, userData, port, operations, peers, get pixelMode() { return pixelMode; } };
}
const run = (f, options = {}) => probeRestartPreferences(f.child, { userData: f.userData, phase: 'write', expectedVersion: '0.76.166', timeoutMs: 500, ...options });

describe('packaged restart preference proof', () => {
  it('re-enumerates a navigation-incomplete discovery and records only safe local progress', async () => {
    let attempts = 0;
    const f = await fixture({
      rpcErrorWhen: message => message.params?.expression?.startsWith('Boolean(') && ++attempts === 1,
      rpcError: { code: -32000, message: 'Inspected target navigated or closed', data: { token: 'PRIVATE_REMOTE_VALUE' } },
    });
    const writes = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    try {
      expect(await run(f)).toEqual({ phase: 'write', pid: 4321, appVersion: '0.76.166', packaged: true, pixelMode: true });
    } finally { stdout.mockRestore(); }
    expect(attempts).toBe(2);
    expect(f.operations).toEqual(['version', 'get', 'set', 'get']);
    const records = writes.join('').trim().split('\n').map(line => JSON.parse(line.replace('[smoke] restart-discovery ', '')));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: 'write', transientRounds: 1, classification: 'target-navigated-or-closed' });
    expect(Number.isSafeInteger(records[0].elapsedMs)).toBe(true);
    expect(records[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(records[0]).sort()).toEqual(['classification', 'elapsedMs', 'phase', 'transientRounds']);
    expect(writes.join('')).not.toContain('PRIVATE_REMOTE');
  });
  it('discards the entire incomplete round before proving a unique Nexus target', async () => {
    let attempts = 0;
    const f = await fixture({
      targets: port => ['a', 'b'].map(id => ({ id, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` })),
      rpcErrorWhen: (message, req) => req.url.endsWith('/b') && message.params?.expression?.startsWith('Boolean(') && ++attempts === 1,
      rpcError: { code: -32000, message: 'Inspected target navigated or closed' },
    });
    await expect(run(f)).rejects.toThrow('ambiguous Nexus CDP page');
    expect(attempts).toBe(2);
    expect(f.operations).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.peers.size).toBe(0);
    expect(f.child.eventNames()).toEqual([]);
  });
  it.each([
    message => message.method === 'SystemInfo.getProcessInfo',
    message => message.params?.expression?.includes('releaseReadiness();'),
    message => message.params?.expression?.includes('uiGet()'),
    message => message.params?.expression?.includes('uiSet('),
  ])('never retries the same navigation response outside read-only availability discovery', async matches => {
    let attempts = 0;
    const f = await fixture({ rpcErrorWhen: message => matches(message) && ++attempts > 0, rpcError: { code: -32000, message: 'Inspected target navigated or closed' } });
    await expect(run(f)).rejects.toThrow('CDP command failed:');
    expect(attempts).toBe(1);
    expect(f.operations).not.toContain('set');
  });
  it('does not accept the same navigation message under a different protocol code', async () => {
    let attempts = 0;
    const f = await fixture({ rpcErrorWhen: message => message.params?.expression?.startsWith('Boolean(') && ++attempts > 0, rpcError: { code: -32601, message: 'Inspected target navigated or closed' } });
    await expect(run(f)).rejects.toThrow('stage=api-availability code=-32601');
    expect(attempts).toBe(1);
    expect(f.operations).toEqual([]);
  });
  it('keeps the original deadline when every discovery round remains incomplete', async () => {
    let attempts = 0;
    const f = await fixture({ rpcErrorWhen: message => message.params?.expression?.startsWith('Boolean(') && ++attempts > 0, rpcError: { code: -32000, message: 'Inspected target navigated or closed' } });
    await expect(run(f, { timeoutMs: 100 })).rejects.toThrow('restart probe timed out');
    expect(attempts).toBeGreaterThan(0);
    expect(f.operations).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.peers.size).toBe(0);
    expect(f.child.eventNames()).toEqual([]);
  });
  it.each([
    ['SystemInfo.getProcessInfo', 'browser-process-identity', -32601, message => message.method === 'SystemInfo.getProcessInfo'],
    ['Runtime.evaluate', 'api-availability', -32000, message => message.params?.expression?.startsWith('Boolean(')],
    ['Runtime.evaluate', 'app-version', -32000, message => message.params?.expression?.includes('releaseReadiness();')],
    ['Runtime.evaluate', 'preference-read', -32000, message => message.params?.expression?.includes('uiGet()')],
    ['Runtime.evaluate', 'preference-write', -32000, message => message.params?.expression?.includes('uiSet(')],
  ])('identifies %s during %s without disclosing remote values', async (method, stage, code, rpcErrorWhen) => {
    const f = await fixture({ rpcErrorWhen, rpcError: { code, message: 'PRIVATE_REMOTE_MESSAGE', data: { token: 'PRIVATE_REMOTE_VALUE' } } });
    let failure;
    try { await run(f); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(`CDP command failed: method=${method} stage=${stage} code=${code}`);
    expect(failure.message).not.toContain('PRIVATE_REMOTE');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.peers.size).toBe(0);
    expect(f.child.eventNames()).toEqual([]);
  });
  it('does not disclose a nonnumeric remote error code', async () => {
    const f = await fixture({ rpcErrorWhen: () => true, rpcError: { code: 'PRIVATE_REMOTE_CODE', message: 'PRIVATE_REMOTE_MESSAGE' } });
    await expect(run(f)).rejects.toThrow('CDP command failed: method=SystemInfo.getProcessInfo stage=browser-process-identity code=unavailable');
    expect(f.operations).toEqual([]);
  });
  it('waits when releaseReadiness rejects before IPC is registered', async () => {
    const f = await fixture({ versionFailures: 1 });
    const writes = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    try {
      expect(await run(f)).toEqual({ phase: 'write', pid: 4321, appVersion: '0.76.166', packaged: true, pixelMode: true });
    } finally { stdout.mockRestore(); }
    expect(f.operations).toEqual(['version', 'version', 'get', 'set', 'get']);
    const records = writes.join('').trim().split('\n').map(line => JSON.parse(line.replace('[smoke] restart-discovery ', '')));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: 'write', transientRounds: 1, classification: 'ipc-not-ready' });
    expect(writes.join('')).not.toContain('No handler');
  });
  it('writes through real CDP transport after checking version and the initial preference', async () => {
    const f = await fixture();
    expect(await run(f)).toEqual({ phase: 'write', pid: 4321, appVersion: '0.76.166', packaged: true, pixelMode: true });
    expect(f.pixelMode).toBe(true);
    expect(f.operations).toEqual(['version', 'get', 'set', 'get']);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.peers.size).toBe(0);
    expect(f.child.eventNames()).toEqual([]);
  });
  it('reads the restarted preference without writing it again', async () => {
    const f = await fixture({ initial: true, forbidSet: true });
    expect(await run(f, { phase: 'read' })).toEqual({ phase: 'read', pid: 4321, appVersion: '0.76.166', packaged: true, pixelMode: true });
    expect(f.operations).toEqual(['version', 'get']);
  });
  it.each([
    [{ version: '0.76.165' }, /version/],
    [{ packaged: false }, /packaged/],
    [{ initial: true }, /initial preference/],
    [{ dropWrite: true }, /persisted preference/],
  ])('fails closed on invalid runtime or preference %j', async (options, message) => {
    const f = await fixture(options);
    await expect(run(f)).rejects.toThrow(message);
    if (options.version || options.packaged === false || options.initial) expect(f.operations).not.toContain('set');
  });
  it('rejects a missing restart value instead of manufacturing it with a setter', async () => {
    const f = await fixture({ initial: false, forbidSet: true });
    await expect(run(f, { phase: 'read' })).rejects.toThrow(/persisted preference/);
    expect(f.operations).toEqual(['version', 'get']);
  });
  it.each(['other', '', null])('rejects invalid phase %j before connecting', async phase => {
    const f = await fixture();
    await expect(run(f, { phase })).rejects.toThrow(/phase/);
    expect(f.operations).toEqual([]);
  });
  it.each([
    port => `ws://localhost:${port}/devtools/page/page-a`,
    port => `ws://127.0.0.1:${port + 1}/devtools/page/page-a`,
    port => `ws://user:pass@127.0.0.1:${port}/devtools/page/page-a`,
    port => `ws://127.0.0.1:${port}/devtools/page/page-a#fragment`,
    port => `wss://127.0.0.1:${port}/devtools/page/page-a`,
  ])('rejects unsafe or mismatched websocket endpoints', async webSocketDebuggerUrl => {
    const f = await fixture({ targets: port => [{ id: 'page-a', type: 'page', webSocketDebuggerUrl: webSocketDebuggerUrl(port) }] });
    await expect(run(f)).rejects.toThrow(/CDP endpoint/);
    expect(f.operations).toEqual([]);
  });
  it('rejects two pages exposing the Nexus API without mutating either', async () => {
    const f = await fixture({ targets: port => ['a', 'b'].map(id => ({ id, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` })) });
    await expect(run(f)).rejects.toThrow(/ambiguous/);
    expect(f.operations).toEqual([]);
  });
  it('rejects a stale endpoint belonging to a different browser process', async () => {
    const f = await fixture({ browserPid: 9999 });
    await expect(run(f)).rejects.toThrow(/process identity/);
    expect(f.operations).toEqual([]);
  });
  it.each([{ rpcStall: true }, { httpStall: true }, { noApi: true }])('bounds stalled discovery and closes resources %j', async options => {
    const f = await fixture(options);
    await expect(run(f, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.peers.size).toBe(0);
    expect(f.child.eventNames()).toEqual([]);
  });
  it('honors caller cancellation while CDP is stalled and removes listeners', async () => {
    const f = await fixture({ rpcStall: true });
    const controller = new AbortController();
    const result = run(f, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(result).rejects.toThrow(/cancelled/);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.peers.size).toBe(0);
    expect(f.child.eventNames()).toEqual([]);
  });
  it('stops probing when the owned child closes before readiness', async () => {
    const f = await fixture({ rpcStall: true });
    const result = run(f);
    setTimeout(() => f.child.emit('close', 1), 30);
    await expect(result).rejects.toThrow(/child exited/);
    expect(f.child.eventNames()).toEqual([]);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

// The bridge pulls orchestration/pty modules that transitively need electron;
// stub them so this stays a pure network test.
vi.mock('../orch/mission-store', () => ({ listMissions: () => [] }));
vi.mock('../orch/pane-registry', () => ({
  findPane: () => null,
  listPaneSnapshots: () => [],
  readSessionOutput: () => '',
  requestPaneClose: () => true,
}));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: () => true,
  orchResizeSession: () => true,
}));

type Bridge = typeof import('./remote-bridge');
let bridge: Bridge;
let home: string;
let url: string;

async function rpc(
  socket: WebSocket,
  payload: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), 4000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.send(JSON.stringify(payload));
  });
}

function connect(): Promise<WebSocket> {
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  bridge = await import('./remote-bridge');
  const info = await bridge.startRemoteBridge({ host: '127.0.0.1' });
  url = `wss://127.0.0.1:${info.port}`;
});

afterAll(() => {
  bridge.stopRemoteBridge();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('remote bridge', () => {
  it('starts and reports running with a port and pairing code', () => {
    const info = bridge.getRemoteBridgeInfo();
    expect(info.running).toBe(true);
    expect(info.port).toBeGreaterThan(0);
    expect(info.pairingCode).toHaveLength(8);
  });

  it('answers ping without auth', async () => {
    const socket = await connect();
    const res = await rpc(socket, { id: '1', type: 'ping' });
    expect(res.ok).toBe(true);
    socket.close();
  });

  it('rejects authed commands before authentication', async () => {
    const socket = await connect();
    const res = await rpc(socket, { id: '2', type: 'panes.list' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('auth required');
    socket.close();
  });

  it('rotates the pairing code after too many failures', async () => {
    const before = bridge.getRemoteBridgeInfo().pairingCode;
    const socket = await connect();
    for (let i = 0; i < 8; i += 1) {
      const res = await rpc(socket, { id: `f${i}`, type: 'pair', code: 'AAAAAAAA' });
      expect(res.ok).toBe(false);
    }
    socket.close();
    expect(bridge.getRemoteBridgeInfo().pairingCode).not.toBe(before);
  });

  it('issues a token on correct pairing and accepts it on a fresh socket', async () => {
    const code = bridge.getRemoteBridgeInfo().pairingCode;
    const pairSocket = await connect();
    const paired = await rpc(pairSocket, { id: 'p', type: 'pair', code });
    expect(paired.ok).toBe(true);
    const token = (paired.result as { token?: string }).token;
    expect(typeof token).toBe('string');
    pairSocket.close();

    const authSocket = await connect();
    const authed = await rpc(authSocket, { id: 'a', type: 'auth', token });
    expect(authed.ok).toBe(true);
    const listed = await rpc(authSocket, { id: 'l', type: 'panes.list' });
    expect(listed.ok).toBe(true);
    authSocket.close();
  });

  it('rejects a bogus token', async () => {
    const socket = await connect();
    const res = await rpc(socket, { id: 'b', type: 'auth', token: 'nope' });
    expect(res.ok).toBe(false);
    socket.close();
  });

  it('drops oversized frames via maxPayload', async () => {
    const socket = await connect();
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.once('error', () => resolve());
    });
    socket.send(JSON.stringify({ id: 'big', type: 'ping', pad: 'x'.repeat(70 * 1024) }));
    await closed;
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const ptyMocks = vi.hoisted(() => ({
  orchWriteSession: vi.fn(() => true),
}));

// The bridge pulls orchestration/pty modules that transitively need electron;
// stub them so this stays a pure network test.
vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ missions: { list: () => [] } }),
}));
vi.mock('../orch/pane-registry', () => ({
  getPaneAuthzInfo: (paneId: string) =>
    paneId === 'pane-stream'
      ? {
          paneId: 'pane-stream',
          sessionId: 'session-stream-1',
          projectId: 'project-a',
          checkoutId: 'checkout-a',
        }
      : null,
  listVisiblePaneSnapshots: () => [],
  readSessionOutput: (sessionId: string) =>
    sessionId === 'session-stream-1' ? 'stream-output-line\n' : '',
  requestPaneClose: () => true,
}));
vi.mock('../orch/pane-authz', () => ({
  authorizePaneAccess: () => ({ allow: true }),
}));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: ptyMocks.orchWriteSession,
  orchResizeSession: () => true,
}));

type Bridge = typeof import('./remote-bridge');
let bridge: Bridge;
let home: string;
let url: string;
let previousTokenTtl: string | undefined;
const projectScope = {
  version: 1 as const,
  installationId: 'install-test',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
};

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

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function issueToken(): Promise<string> {
  const code = bridge.getRemoteBridgeInfo().pairingCode;
  const socket = await connect();
  const paired = await rpc(socket, { id: 'pair-token', type: 'pair', code });
  socket.close();
  const token = (paired.result as { token?: unknown }).token;
  if (typeof token !== 'string') throw new Error('bridge did not issue a token');
  return token;
}

async function authenticate(token: string): Promise<WebSocket> {
  const socket = await connect();
  const response = await rpc(socket, { id: 'auth-token', type: 'auth', token });
  if (response.ok !== true) throw new Error('bridge did not authenticate the token');
  return socket;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  process.env.HOME = home;
  previousTokenTtl = process.env.NEXUS_REMOTE_TOKEN_TTL_MS;
  process.env.NEXUS_REMOTE_TOKEN_TTL_MS = '500';
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  bridge = await import('./remote-bridge');
  const info = await bridge.startRemoteBridge(
    { host: '127.0.0.1' },
    projectScope,
  );
  url = `wss://127.0.0.1:${info.port}`;
});

afterAll(() => {
  bridge.stopRemoteBridge();
  if (previousTokenTtl === undefined) delete process.env.NEXUS_REMOTE_TOKEN_TTL_MS;
  else process.env.NEXUS_REMOTE_TOKEN_TTL_MS = previousTokenTtl;
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

  it('closes already authenticated sockets when tokens are revoked', async () => {
    const token = await issueToken();
    const firstSocket = await authenticate(token);
    const secondSocket = await authenticate(token);
    const firstClosed = waitForClose(firstSocket);
    const secondClosed = waitForClose(secondSocket);

    bridge.revokeRemoteTokens();

    await expect(Promise.all([firstClosed, secondClosed])).resolves.toEqual([
      { code: 1008, reason: 'tokens revoked' },
      { code: 1008, reason: 'tokens revoked' },
    ]);
    const retry = await connect();
    await expect(rpc(retry, { id: 'revoked', type: 'auth', token })).resolves.toMatchObject({
      ok: false,
      error: 'invalid token',
    });
    retry.close();
  });

  it('closes an authenticated socket when its token expires', async () => {
    const token = await issueToken();
    const socket = await authenticate(token);

    await expect(waitForClose(socket)).resolves.toEqual({
      code: 1008,
      reason: 'token expired',
    });
  });

  it('does not expose the pairing secret through an authenticated status command', async () => {
    const token = await issueToken();
    const socket = await authenticate(token);
    const response = await rpc(socket, { id: 'status', type: 'status' });

    expect(response.ok).toBe(true);
    expect(response.result).not.toHaveProperty('pairingCode');
    expect(response.result).not.toHaveProperty('pairingExpiresAt');
    socket.close();
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

  it('pane.read returns terminal-stream-protocol frame on production path', async () => {
    const token = await issueToken();
    const socket = await authenticate(token);
    const opened = await rpc(socket, {
      id: 'so',
      type: 'pane.stream.open',
      paneId: 'pane-stream',
    });
    expect(opened.ok).toBe(true);
    expect(opened.result).toMatchObject({
      streamId: expect.any(Number),
      subscribeFrameBase64: expect.any(String),
    });

    const read = await rpc(socket, {
      id: 'sr',
      type: 'pane.read',
      paneId: 'pane-stream',
      lines: 50,
    });
    expect(read.ok).toBe(true);
    const result = read.result as {
      output?: string;
      stream?: { frameBase64?: string; seq?: number; streamId?: number };
    };
    expect(result.output).toBe('stream-output-line\n');
    expect(result.stream?.frameBase64).toBeTruthy();
    expect(result.stream?.seq).toBeGreaterThan(0);
    expect(result.stream?.streamId).toBeGreaterThan(0);

    // Decode frame via real protocol (proves production encode path)
    const { decodeTerminalStreamFrame, TerminalStreamOpcode } = await import(
      '../../shared/terminal-stream-protocol'
    );
    const frame = decodeTerminalStreamFrame(
      new Uint8Array(Buffer.from(result.stream!.frameBase64!, 'base64')),
    );
    expect(frame?.opcode).toBe(TerminalStreamOpcode.Output);
    expect(new TextDecoder().decode(frame!.payload)).toBe('stream-output-line\n');
    socket.close();
  });

  it('writes a sequenced input frame only once when a client replays it', async () => {
    ptyMocks.orchWriteSession.mockClear();
    const token = await issueToken();
    const socket = await authenticate(token);
    const opened = await rpc(socket, {
      id: 'replay-open',
      type: 'pane.stream.open',
      paneId: 'pane-stream',
    });
    const streamId = (opened.result as { streamId: number }).streamId;
    const { encodeTerminalStreamFrame, TerminalStreamOpcode } = await import(
      '../../shared/terminal-stream-protocol'
    );
    const frameBase64 = Buffer.from(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        streamId,
        seq: 1,
        payload: new TextEncoder().encode('deploy\n'),
      }),
    ).toString('base64');

    const first = await rpc(socket, {
      id: 'replay-first',
      type: 'pane.stream.frame',
      paneId: 'pane-stream',
      frameBase64,
    });
    const duplicate = await rpc(socket, {
      id: 'replay-duplicate',
      type: 'pane.stream.frame',
      paneId: 'pane-stream',
      frameBase64,
    });

    expect(first.ok).toBe(true);
    expect(duplicate).toMatchObject({ ok: false, error: 'invalid stream frame' });
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledTimes(1);
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledWith(
      'session-stream-1',
      'deploy\n',
    );
    socket.close();
  });

});

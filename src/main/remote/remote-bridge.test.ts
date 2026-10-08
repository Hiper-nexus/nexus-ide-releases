import fs from 'node:fs';
import crypto, { type KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const ptyMocks = vi.hoisted(() => ({
  orchWriteSession: vi.fn(() => true),
  sessionDataTap: null as ((sessionId: string, data: string) => void) | null,
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
  tapSessionData: (cb: (sessionId: string, data: string) => void) => {
    ptyMocks.sessionDataTap = cb;
    return () => {
      if (ptyMocks.sessionDataTap === cb) ptyMocks.sessionDataTap = null;
    };
  },
}));

type Bridge = typeof import('./remote-bridge');
let bridge: Bridge;
let home: string;
let url: string;
let previousHome: string | undefined;
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
    // The full CI suite heavily contends for CPU; keep this above the token TTL
    // so a slow runner reports the protocol response instead of a false timeout.
    const timer = setTimeout(() => reject(new Error('rpc timeout')), 10_000);
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

function httpGet(pathname: string): Promise<{
  statusCode: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  const info = bridge.getRemoteBridgeInfo();
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: '127.0.0.1',
        port: info.port,
        path: pathname,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

interface DeviceCredential {
  token: string;
  deviceId: string;
  publicKey: {
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
  };
  privateKey: KeyObject;
}

function createDeviceIdentity(): Omit<DeviceCredential, 'token'> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    throw new Error('test device key export failed');
  }
  return {
    deviceId: crypto.randomBytes(24).toString('base64url'),
    publicKey: {
      kty: 'EC',
      crv: 'P-256',
      x: jwk.x,
      y: jwk.y,
    },
    privateKey,
  };
}

function signDeviceChallenge(privateKey: KeyObject, challenge: string): string {
  return crypto
    .sign('sha256', Buffer.from(challenge), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');
}

async function issueToken(): Promise<DeviceCredential> {
  const code = bridge.rotateRemotePairing().pairingCode;
  if (!code) throw new Error('bridge did not issue a pairing code');
  const device = createDeviceIdentity();
  const socket = await connect();
  const paired = await rpc(socket, {
    id: 'pair-token',
    type: 'pair',
    code,
    deviceId: device.deviceId,
    devicePublicKey: device.publicKey,
    deviceProof: signDeviceChallenge(
      device.privateKey,
      `nexus-remote-pair-v1:${code}`,
    ),
  });
  socket.close();
  const token = (paired.result as { token?: unknown }).token;
  if (typeof token !== 'string') throw new Error('bridge did not issue a token');
  return { ...device, token };
}

async function authenticate(device: DeviceCredential): Promise<WebSocket> {
  const socket = await connect();
  const requested = await rpc(socket, {
    id: 'auth-challenge',
    type: 'auth.challenge',
    token: device.token,
    deviceId: device.deviceId,
  });
  const challenge = requested.result as {
    challenge?: unknown;
    challengeId?: unknown;
  };
  if (
    typeof challenge.challenge !== 'string' ||
    typeof challenge.challengeId !== 'string'
  ) {
    throw new Error('bridge did not issue an auth challenge');
  }
  const response = await rpc(socket, {
    id: 'auth-token',
    type: 'auth',
    token: device.token,
    deviceId: device.deviceId,
    challengeId: challenge.challengeId,
    signature: signDeviceChallenge(device.privateKey, challenge.challenge),
  });
  if (response.ok !== true) throw new Error('bridge did not authenticate the token');
  return socket;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  previousHome = process.env.HOME;
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

afterAll(async () => {
  try {
    await bridge.stopRemoteBridge();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTokenTtl === undefined) {
      delete process.env.NEXUS_REMOTE_TOKEN_TTL_MS;
    } else {
      process.env.NEXUS_REMOTE_TOKEN_TTL_MS = previousTokenTtl;
    }
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('remote bridge', () => {
  it('starts and reports running with a port and pairing code', () => {
    const info = bridge.getRemoteBridgeInfo();
    expect(info.running).toBe(true);
    expect(info.port).toBeGreaterThan(0);
    expect(info.pairingCode).toHaveLength(8);
  });

  it('does not auto-mint another code when desktop-issued pairing expires', () => {
    const issued = bridge.rotateRemotePairing();
    const now = vi.spyOn(Date, 'now').mockReturnValue(
      (issued.pairingExpiresAt ?? 0) + 1,
    );
    expect(bridge.getRemoteBridgeInfo().pairingCode).toBeUndefined();
    now.mockRestore();
    expect(bridge.getRemoteBridgeInfo().pairingCode).toBeUndefined();
    expect(bridge.rotateRemotePairing().pairingCode).toHaveLength(8);
  });

  it('serves an installable same-origin PWA without exposing state over HTTP', async () => {
    const page = await httpGet('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.body).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(page.body).toContain("serviceWorker.register('/sw.js')");
    expect(page.body).toContain("send('auth.challenge'");
    expect(page.body).toContain("indexedDB.open(DEVICE_DB, 1)");
    expect(page.body).toContain("crypto.subtle.sign(");
    const embeddedScript = page.body.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(embeddedScript).toBeTruthy();
    expect(() => new vm.Script(embeddedScript!)).not.toThrow();

    const manifest = await httpGet('/manifest.webmanifest');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(JSON.parse(manifest.body)).toMatchObject({
      name: 'Nexus Remote',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });

    const serviceWorker = await httpGet('/sw.js');
    expect(serviceWorker.statusCode).toBe(200);
    expect(serviceWorker.headers['service-worker-allowed']).toBe('/');
    expect(serviceWorker.body).toContain("'/manifest.webmanifest'");
    expect(serviceWorker.body).not.toContain('localStorage');

    const icon = await httpGet('/icon.svg');
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toContain('image/svg+xml');

    const privateStateProbe = await httpGet('/tokens.json');
    expect(privateStateProbe.statusCode).toBe(404);
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

  it('issues a token on correct pairing and accepts it on a fresh socket', async () => {
    const code = bridge.getRemoteBridgeInfo().pairingCode;
    if (!code) throw new Error('missing pairing code');
    const device = createDeviceIdentity();
    const pairSocket = await connect();
    const paired = await rpc(pairSocket, {
      id: 'p',
      type: 'pair',
      code,
      deviceId: device.deviceId,
      devicePublicKey: device.publicKey,
      deviceProof: signDeviceChallenge(
        device.privateKey,
        `nexus-remote-pair-v1:${code}`,
      ),
    });
    expect(paired.ok).toBe(true);
    const token = (paired.result as { token?: string }).token;
    expect(typeof token).toBe('string');
    expect(bridge.getRemoteBridgeInfo().pairingCode).toBeUndefined();
    pairSocket.close();

    const authSocket = await authenticate({
      ...device,
      token: token!,
    });
    const listed = await rpc(authSocket, { id: 'l', type: 'panes.list' });
    expect(listed.ok).toBe(true);
    authSocket.close();

    const copiedDevice = createDeviceIdentity();
    const replaySocket = await connect();
    const replay = await rpc(replaySocket, {
      id: 'pair-replay',
      type: 'pair',
      code,
      deviceId: copiedDevice.deviceId,
      devicePublicKey: copiedDevice.publicKey,
      deviceProof: signDeviceChallenge(
        copiedDevice.privateKey,
        `nexus-remote-pair-v1:${code}`,
      ),
    });
    expect(replay).toMatchObject({ ok: false, error: 'invalid pairing code' });
    replaySocket.close();
  });

  it('requires a device public key before consuming a single-use pairing code', async () => {
    const code = bridge.rotateRemotePairing().pairingCode;
    const socket = await connect();
    const paired = await rpc(socket, {
      id: 'pair-without-device',
      type: 'pair',
      code,
    });

    expect(paired).toMatchObject({
      ok: false,
      error: 'device identity required',
    });
    expect(bridge.getRemoteBridgeInfo().pairingCode).toBe(code);
    socket.close();
  });

  it('binds a persisted token to proof from the paired device key', async () => {
    const paired = await issueToken();
    const impostor = createDeviceIdentity();
    const socket = await connect();
    const wrongDevice = await rpc(socket, {
      id: 'wrong-device',
      type: 'auth.challenge',
      token: paired.token,
      deviceId: impostor.deviceId,
    });
    expect(wrongDevice).toMatchObject({
      ok: false,
      error: 'invalid token or device',
    });

    const requested = await rpc(socket, {
      id: 'real-device-challenge',
      type: 'auth.challenge',
      token: paired.token,
      deviceId: paired.deviceId,
    });
    const challenge = requested.result as {
      challenge: string;
      challengeId: string;
    };
    const forged = await rpc(socket, {
      id: 'forged-device-proof',
      type: 'auth',
      token: paired.token,
      deviceId: paired.deviceId,
      challengeId: challenge.challengeId,
      signature: signDeviceChallenge(
        impostor.privateKey,
        challenge.challenge,
      ),
    });
    expect(forged).toMatchObject({
      ok: false,
      error: 'invalid device authentication',
    });
    const replayAfterFailure = await rpc(socket, {
      id: 'replayed-device-proof',
      type: 'auth',
      token: paired.token,
      deviceId: paired.deviceId,
      challengeId: challenge.challengeId,
      signature: signDeviceChallenge(
        paired.privateKey,
        challenge.challenge,
      ),
    });
    expect(replayAfterFailure).toMatchObject({
      ok: false,
      error: 'invalid device authentication',
    });
    socket.close();

    const tokenFile = JSON.parse(
      fs.readFileSync(path.join(home, '.nexus', 'remote-bridge', 'tokens.json'), 'utf8'),
    ) as { tokens: Array<Record<string, unknown>> };
    const record = tokenFile.tokens.find((entry) => entry.deviceId === paired.deviceId);
    expect(record).toMatchObject({
      deviceId: paired.deviceId,
      deviceKeyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      devicePublicKey: paired.publicKey,
    });
    expect(JSON.stringify(record)).not.toContain(paired.token);
  });

  it('closes already authenticated sockets when tokens are revoked', async () => {
    // Give each TLS handshake a freshly issued short-lived token. Reusing one
    // token made this race its 500 ms expiry on contended CI runners.
    const firstToken = await issueToken();
    const firstSocket = await authenticate(firstToken);
    const secondToken = await issueToken();
    const secondSocket = await authenticate(secondToken);
    const firstClosed = waitForClose(firstSocket);
    const secondClosed = waitForClose(secondSocket);

    bridge.revokeRemoteTokens();

    await expect(Promise.all([firstClosed, secondClosed])).resolves.toEqual([
      { code: 1008, reason: 'tokens revoked' },
      { code: 1008, reason: 'tokens revoked' },
    ]);
    const retry = await connect();
    await expect(rpc(retry, {
      id: 'revoked',
      type: 'auth.challenge',
      token: secondToken.token,
      deviceId: secondToken.deviceId,
    })).resolves.toMatchObject({
      ok: false,
      error: 'invalid token or device',
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

  it('nega mission.complete do mobile (regra inviolável do companion gate)', async () => {
    const token = await issueToken();
    const socket = await authenticate(token);
    const res = await rpc(socket, { id: 'mc', type: 'mission.complete' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('not authorized');
    socket.close();
  });

  it('nega escrita destrutiva do mobile sem confirmação do device', async () => {
    const token = await issueToken();
    const socket = await authenticate(token);
    const res = await rpc(socket, { id: 'gp', type: 'git.push' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('not authorized');
    socket.close();
  });

  it('mantém pane.input local de baixo risco fluido, mas bloqueia destrutivo sem desktop', async () => {
    ptyMocks.orchWriteSession.mockClear();
    const token = await issueToken();
    const socket = await authenticate(token);

    const routine = await rpc(socket, {
      id: 'routine-input',
      type: 'pane.input',
      paneId: 'pane-stream',
      data: 'npm test',
    });
    expect(routine.ok).toBe(true);
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledWith(
      'session-stream-1',
      'npm test\n',
    );

    const destructive = await rpc(socket, {
      id: 'destructive-input',
      type: 'pane.input',
      paneId: 'pane-stream',
      data: 'rm -rf /tmp/nexus-build',
    });
    expect(destructive).toMatchObject({
      ok: false,
      error: expect.stringContaining('desktop confirmation'),
    });
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledTimes(1);
    socket.close();
  });

  it('deduplica o reenvio do outbox mobile pelo messageId de pane.input', async () => {
    // Direto no dispatch autenticado (o mesmo do WS e do relay): o limite de
    // 60 mensagens/min por IP da suíte fica para os testes de socket.
    ptyMocks.orchWriteSession.mockClear();
    const send = (messageId: string) =>
      bridge.handleAuthedMessage(
        { type: 'pane.input', paneId: 'pane-stream', data: 'git status', messageId },
        projectScope,
      ) as Promise<Record<string, unknown>>;

    const first = await send('msg-outbox-a');
    expect(first).toMatchObject({ ok: true });
    expect(first).not.toHaveProperty('deduplicated');

    // Ack perdido → o outbox reenvia o MESMO messageId: nada é digitado de novo.
    await expect(send('msg-outbox-a')).resolves.toMatchObject({ ok: true, deduplicated: true });
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledTimes(1);
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledWith('session-stream-1', 'git status\n');

    // Outra mensagem com o mesmo texto é outra entrega.
    await send('msg-outbox-b');
    expect(ptyMocks.orchWriteSession).toHaveBeenCalledTimes(2);
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

  it('pushes real-time output frames only to clients subscribed via pane.stream.open', async () => {
    const token = await issueToken();
    const subscriber = await authenticate(token);
    const bystander = await authenticate(token);
    const opened = await rpc(subscriber, {
      id: 'push-open',
      type: 'pane.stream.open',
      paneId: 'pane-stream',
    });
    expect(opened.ok).toBe(true);
    const openedResult = opened.result as { streamId: number };

    const pushes: Array<{ streamId: number; seq: number; frameBase64: string }> = [];
    subscriber.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'pane.stream.data') {
        pushes.push(msg as unknown as (typeof pushes)[number]);
      }
    });
    const bystanderPushes: unknown[] = [];
    bystander.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'pane.stream.data') bystanderPushes.push(msg);
    });

    // Synthetic PTY output: first chunk, then a pane.read from ANOTHER client
    // (response-only encode — must not shift the push cursor), then a second
    // chunk, plus noise on an unrelated session that must never leak.
    ptyMocks.sessionDataTap?.('session-stream-1', 'hello ');
    await rpc(bystander, {
      id: 'read-mid',
      type: 'pane.read',
      paneId: 'pane-stream',
      lines: 10,
    });
    ptyMocks.sessionDataTap?.('session-stream-1', 'world');
    ptyMocks.sessionDataTap?.('session-unrelated', 'noise');

    // Fast poll: the suite runs with a 500 ms token TTL, so settle quickly.
    const deadline = Date.now() + 300;
    while (pushes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(pushes.length).toBe(2);
    expect(pushes[0]!.streamId).toBe(openedResult.streamId);
    // Dedicated push cursor: the interleaved pane.read encoded a response
    // frame, yet the push seq stays CONSECUTIVE — no false gap, no resync storm.
    expect(pushes[1]!.seq).toBe(pushes[0]!.seq + 1);
    const { decodeTerminalStreamFrame, TerminalStreamOpcode } = await import(
      '../../shared/terminal-stream-protocol'
    );
    const first = decodeTerminalStreamFrame(
      new Uint8Array(Buffer.from(pushes[0]!.frameBase64, 'base64')),
    );
    const second = decodeTerminalStreamFrame(
      new Uint8Array(Buffer.from(pushes[1]!.frameBase64, 'base64')),
    );
    expect(first?.opcode).toBe(TerminalStreamOpcode.Output);
    expect(new TextDecoder().decode(first!.payload)).toBe('hello ');
    expect(new TextDecoder().decode(second!.payload)).toBe('world');
    // The authenticated-but-unsubscribed client never receives pushes.
    expect(bystanderPushes.length).toBe(0);

    // pane.stream.close: the subscriber gives up its push and later PTY
    // output no longer reaches it.
    const closed = await rpc(subscriber, {
      id: 'push-close',
      type: 'pane.stream.close',
    });
    expect(closed.ok).toBe(true);
    ptyMocks.sessionDataTap?.('session-stream-1', 'after-close');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pushes.length).toBe(2);
    subscriber.close();
    bystander.close();
  });

  it('rejects raw input frames so commands cannot bypass pane.input authority', async () => {
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

    expect(first).toMatchObject({
      ok: false,
      error: 'not authorized: raw terminal input is disabled; use pane.input',
    });
    expect(duplicate).toMatchObject({ ok: false, error: 'invalid stream frame' });
    expect(ptyMocks.orchWriteSession).not.toHaveBeenCalled();
    socket.close();
  });

  // Kept LAST: it locks this IP out of pairing for a cooldown, which would
  // otherwise leak into other tests that pair from the same loopback address.
  it('locks out an IP after too many failures WITHOUT rotating the shared code (L16)', async () => {
    bridge.stopRemoteBridge();
    const restarted = await bridge.startRemoteBridge(
      { host: '127.0.0.1' },
      projectScope,
    );
    url = `wss://127.0.0.1:${restarted.port}`;
    const before = restarted.pairingCode;
    const device = createDeviceIdentity();
    const socket = await connect();
    for (let i = 0; i < 8; i += 1) {
      const res = await rpc(socket, {
        id: `f${i}`,
        type: 'pair',
        code: 'AAAAAAAA',
        deviceId: device.deviceId,
        devicePublicKey: device.publicKey,
        deviceProof: 'invalid',
      });
      expect(res.ok).toBe(false);
    }
    // Further attempts from this IP are locked out...
    const locked = await rpc(socket, {
      id: 'locked',
      type: 'pair',
      code: 'AAAAAAAA',
      deviceId: device.deviceId,
      devicePublicKey: device.publicKey,
      deviceProof: 'invalid',
    });
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/too many attempts/);
    socket.close();
    // ...but the honest user's code is untouched (no global rotation).
    expect(bridge.getRemoteBridgeInfo().pairingCode).toBe(before);
  });

});

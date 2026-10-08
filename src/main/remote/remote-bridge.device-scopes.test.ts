import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { RemoteDeviceScope } from '../../shared/remote-types';
// O cliente do APP EXPO, por caminho (TS puro), como em remote-bridge.mobile-app.test.ts.
import {
  NexusBridgeClient,
  type NexusBridgeSocketFactory,
} from '../../../mobile/src/transport/nexus-bridge-client';
import {
  createNexusBridgeDeviceKey,
  nexusBridgeDeviceIdentity,
} from '../../../mobile/src/transport/nexus-bridge-device-key';
import {
  NEXUS_SCOPE_REFUSED,
  createNexusBridgeRpcClient,
} from '../../../mobile/src/transport/nexus-bridge-rpc-adapter';

// MOB-12 (F-1022): escopos por aparelho contra a Remote Bridge REAL (WSS,
// pareamento, desafio assinado, broker de aprovação). Só o que precisaria do
// Electron (registro de panes, PTY) é simulado.
const h = vi.hoisted(() => ({
  writes: [] as Array<[string, string]>,
  resizes: [] as Array<[string, number, number]>,
  closes: [] as string[],
  tap: null as ((sessionId: string, data: string) => void) | null,
  confirm: vi.fn(async () => true),
}));

vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { list: () => [{ id: 'mis-1', title: 'Missão', status: 'running', updatedAt: 1 }] },
  }),
}));
vi.mock('../orch/pane-registry', () => {
  const pane = {
    paneId: 'pane-app',
    sessionId: 'sess-app',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    kind: 'cli-agent',
    scope: { rootRealPath: '/nao-existe' },
  };
  return {
    getPaneAuthzInfo: (ref: string) => (ref === pane.paneId || ref === pane.sessionId ? pane : null),
    listVisiblePaneSnapshots: () => [
      { paneId: 'pane-app', sessionId: 'sess-app', title: 'Claude', kind: 'cli-agent', state: 'busy' },
    ],
    readSessionOutput: () => 'saida do pane\n',
    requestPaneClose: (paneId: string) => {
      h.closes.push(paneId);
      return true;
    },
  };
});
vi.mock('../orch/pane-authz', () => ({
  authorizePaneAccess: (caller: { scope: { projectId: string } }, pane: { projectId: string }) =>
    caller.scope.projectId === pane.projectId ? { allow: true } : { allow: false, reason: 'scope' },
}));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: (sessionId: string, data: string) => {
    h.writes.push([sessionId, data]);
    return true;
  },
  orchResizeSession: (sessionId: string, cols: number, rows: number) => {
    h.resizes.push([sessionId, cols, rows]);
    return true;
  },
  tapSessionData: (cb: (sessionId: string, data: string) => void) => {
    h.tap = cb;
    return () => {
      if (h.tap === cb) h.tap = null;
    };
  },
}));
vi.mock('./remote-desktop-confirmation', () => ({
  requestRemoteDesktopConfirmation: h.confirm,
}));

type Bridge = typeof import('./remote-bridge');
type Broker = typeof import('../agent-hooks/approval-broker');
let bridge: Bridge;
let broker: Broker;
let home: string;
let url: string;
let previousHome: string | undefined;
const scope = {
  version: 1 as const,
  installationId: 'install-test',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
};

function newIdentity() {
  return nexusBridgeDeviceIdentity(
    createNexusBridgeDeviceKey((length) => new Uint8Array(crypto.randomBytes(length))),
  );
}
type Identity = ReturnType<typeof newIdentity>;

const socketFactory: NexusBridgeSocketFactory = (target, handlers) => {
  const socket = new WebSocket(target, { rejectUnauthorized: false });
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data) => handlers.onMessage(data.toString()));
  socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));
  socket.on('error', (error) => handlers.onError(error.message));
  return { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) };
};

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Pareia um aparelho com o código emitido para `scopes` (ausente = todos). */
async function pairDevice(scopes?: RemoteDeviceScope[]) {
  const info = bridge.rotateRemotePairing(scope, scopes);
  const identity = newIdentity();
  const pairing = new NexusBridgeClient({ url, identity: async () => identity, createSocket: socketFactory });
  const issued = await pairing.pair(info.pairingCode!);
  pairing.close();
  const grant = bridge
    .getRemoteBridgeInfo(scope)
    .devices!.find((device) => device.keyFingerprint === issued.deviceKeyFingerprint)!;
  return { identity, token: issued.token, grantId: grant.id };
}

type Reply = { id?: string; ok?: boolean; result?: unknown; error?: string; type?: string };

/** Cliente cru `{id, type, ...}` autenticado; guarda os pushes. */
async function rawClient(token: string, identity: Identity) {
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  const pushes: Reply[] = [];
  const pending = new Map<string, (reply: Reply) => void>();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Reply;
    const resolve = message.id ? pending.get(message.id) : undefined;
    if (resolve) {
      pending.delete(message.id!);
      resolve(message);
    } else if (message.type) {
      pushes.push(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  let seq = 0;
  const ask = (frame: Record<string, unknown>) =>
    new Promise<Reply>((resolve) => {
      const id = `q${(seq += 1)}`;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ ...frame, id }));
    });
  const challenge = (await ask({ type: 'auth.challenge', token, deviceId: identity.deviceId })).result as {
    challengeId: string;
    challenge: string;
  };
  const auth = await ask({
    type: 'auth',
    token,
    deviceId: identity.deviceId,
    challengeId: challenge.challengeId,
    signature: identity.sign(challenge.challenge),
  });
  expect(auth.ok).toBe(true);
  return { ask, pushes, close: () => socket.close() };
}

/** Só este socket conectado: sockets de testes anteriores já fecharam no servidor. */
function onlyOneClient(): Promise<void> {
  return waitFor(() => bridge.getRemoteBridgeInfo(scope).clientCount === 1, 'só um cliente conectado');
}

function openApproval() {
  return broker.approvalBroker.open({
    sessionId: 'sess-app',
    provider: 'claude',
    tool: 'Bash',
    summary: 'ls -la',
    options: [{ optionId: 'accept' }, { optionId: 'decline' }],
    waitMs: 60_000,
    fingerprint: broker.approvalFingerprint('Bash', { command: `ls -la ${crypto.randomUUID()}` }),
    highImpact: false,
  })!;
}

const LEGACY_TOKEN = 'legacy-token-paired-before-mob-12';
const legacyIdentity = newIdentity();

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-scopes-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  // Grant gravado ANTES do MOB-12: sem o campo `scopes`.
  const dir = path.join(home, '.nexus', 'remote-bridge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tokens.json'),
    JSON.stringify({
      tokens: [
        {
          id: 'legacy-grant',
          hash: crypto.createHash('sha256').update(LEGACY_TOKEN).digest('hex'),
          createdAt: Date.now(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          deviceId: legacyIdentity.deviceId,
          devicePublicKey: legacyIdentity.publicKey,
          deviceKeyFingerprint: 'f'.repeat(64),
        },
      ],
    }),
  );
  bridge = await import('./remote-bridge');
  broker = await import('../agent-hooks/approval-broker');
  const info = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope);
  url = `wss://127.0.0.1:${info.port}`;
});

afterAll(() => {
  try {
    bridge.stopRemoteBridge();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

beforeEach(() => {
  h.writes.length = 0;
  h.resizes.length = 0;
  h.closes.length = 0;
  h.confirm.mockClear();
});

describe('Remote Bridge: escopos por aparelho (MOB-12)', () => {
  it('a device paired without `input` cannot type or resize: nothing reaches the PTY, no desktop dialog', async () => {
    const device = await pairDevice(['read', 'approve', 'close']);
    expect(bridge.getRemoteBridgeInfo(scope).devices).toContainEqual(
      expect.objectContaining({ id: device.grantId, scopes: ['read', 'approve', 'close'] }),
    );
    const raw = await rawClient(device.token, device.identity);
    for (const data of ['git status', 'rm -rf build']) {
      await expect(raw.ask({ type: 'pane.input', paneId: 'pane-app', data, messageId: crypto.randomUUID() }))
        .resolves.toMatchObject({ ok: false, error: 'not authorized: scope-missing:input' });
    }
    await expect(raw.ask({ type: 'pane.resize', paneId: 'pane-app', cols: 100, rows: 30 })).resolves.toMatchObject({
      ok: false,
      error: 'not authorized: scope-missing:input',
    });
    // Ler continua valendo.
    await expect(raw.ask({ type: 'pane.read', paneId: 'pane-app' })).resolves.toMatchObject({ ok: true });
    expect(h.writes).toEqual([]);
    expect(h.resizes).toEqual([]);
    expect(h.confirm).not.toHaveBeenCalled();
    raw.close();

    // O app mostra a recusa por escopo em pt-BR, não como falha genérica.
    const app = createNexusBridgeRpcClient({
      url,
      token: device.token,
      identity: async () => device.identity,
      createSocket: socketFactory,
    });
    await waitFor(() => app.getState() === 'connected', 'app autenticado');
    await expect(
      app.sendRequest('terminal.send', { terminal: 'pane-app', text: 'git status', enter: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: NEXUS_SCOPE_REFUSED, message: expect.stringContaining('enviar comandos ao terminal') },
    });
    expect(h.writes).toEqual([]);
    app.close();
  });

  it('a device without `approve` cannot answer approvals and does not count as a respondent', async () => {
    const device = await pairDevice(['read', 'input']);
    const raw = await rawClient(device.token, device.identity);
    await onlyOneClient();
    const opened = openApproval();
    expect(broker.hasApprovalResponder('sess-app')).toBe(false);
    const snapshot = (await raw.ask({ type: 'ops.snapshot' })).result as { approvals: Array<{ requestId: string }> };
    expect(snapshot.approvals.map((approval) => approval.requestId)).toContain(opened.request.requestId);
    await expect(
      raw.ask({
        type: 'agentSession.respondToApproval',
        itemId: opened.request.requestId,
        expectedRevision: opened.request.revision,
        optionId: 'accept',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'not authorized: scope-missing:approve' });
    expect(broker.approvalBroker.list().map((request) => request.requestId)).toContain(opened.request.requestId);

    // O operador concede `approve`: vale já no próximo pedido, no mesmo socket.
    bridge.setRemoteDeviceScopes(scope, device.grantId, ['read', 'input', 'approve']);
    expect(broker.hasApprovalResponder('sess-app')).toBe(true);
    await expect(
      raw.ask({
        type: 'agentSession.respondToApproval',
        itemId: opened.request.requestId,
        expectedRevision: opened.request.revision,
        optionId: 'accept',
      }),
    ).resolves.toMatchObject({ ok: true, result: { status: 'accepted' } });
    await expect(opened.decision).resolves.toBe('accept');
    expect(h.writes).toEqual([]);
    raw.close();
  });

  it('a device without `read` gets no panes, missions or pane content; approve-only still sees the pending requests', async () => {
    const device = await pairDevice(['input']);
    const raw = await rawClient(device.token, device.identity);
    const opened = openApproval();
    const snapshot = await raw.ask({ type: 'ops.snapshot' });
    expect(snapshot).toMatchObject({
      ok: true,
      result: { panes: [], missions: [], approvals: [], summary: { panes: 0, missions: 0 } },
    });
    await expect(raw.ask({ type: 'panes.list' })).resolves.toMatchObject({ ok: true, result: [] });
    for (const frame of [
      { type: 'pane.read', paneId: 'pane-app' },
      { type: 'pane.stream.open', paneId: 'pane-app' },
      { type: 'mission.list' },
      { type: 'git.status', paneId: 'pane-app' },
      { type: 'git.diff', paneId: 'pane-app', path: 'README.md' },
      { type: 'files.list', paneId: 'pane-app' },
      { type: 'files.read', paneId: 'pane-app', path: 'README.md' },
    ]) {
      await expect(raw.ask(frame)).resolves.toMatchObject({
        ok: false,
        error: 'not authorized: scope-missing:read',
      });
    }
    // status é a sonda de vida do app: responde, sem a lista de aparelhos.
    const status = await raw.ask({ type: 'status' });
    expect(status).toMatchObject({ ok: true, result: { running: true } });
    expect(status.result).not.toHaveProperty('devices');
    expect(status.result).not.toHaveProperty('pairingScopes');
    raw.close();

    const approver = await pairDevice(['approve']);
    const approverRaw = await rawClient(approver.token, approver.identity);
    const approverSnapshot = (await approverRaw.ask({ type: 'ops.snapshot' })).result as {
      panes: unknown[];
      approvals: Array<{ requestId: string }>;
    };
    expect(approverSnapshot.panes).toEqual([]);
    expect(approverSnapshot.approvals.map((approval) => approval.requestId)).toContain(opened.request.requestId);
    await expect(
      approverRaw.ask({
        type: 'agentSession.respondToApproval',
        itemId: opened.request.requestId,
        expectedRevision: opened.request.revision,
        optionId: 'decline',
      }),
    ).resolves.toMatchObject({ ok: true });
    approverRaw.close();
  });

  it('a device paired before MOB-12 keeps every scope; the next write persists the migration', async () => {
    const raw = await rawClient(LEGACY_TOKEN, legacyIdentity);
    await onlyOneClient();
    const snapshot = (await raw.ask({ type: 'ops.snapshot' })).result as { panes: unknown[]; missions: unknown[] };
    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.missions).toHaveLength(1);
    await expect(
      raw.ask({ type: 'pane.input', paneId: 'pane-app', data: 'git status', messageId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: true });
    await expect(raw.ask({ type: 'pane.resize', paneId: 'pane-app', cols: 90, rows: 20 })).resolves.toMatchObject({
      ok: true,
    });
    const opened = openApproval();
    expect(broker.hasApprovalResponder('sess-app')).toBe(true);
    await expect(
      raw.ask({
        type: 'agentSession.respondToApproval',
        itemId: opened.request.requestId,
        expectedRevision: opened.request.revision,
        optionId: 'accept',
      }),
    ).resolves.toMatchObject({ ok: true, result: { status: 'accepted' } });
    await expect(raw.ask({ type: 'pane.close', paneId: 'pane-app' })).resolves.toMatchObject({ ok: true });
    expect(h.writes).toEqual([['sess-app', 'git status\n']]);
    expect(h.closes).toEqual(['pane-app']);
    expect(bridge.getRemoteBridgeInfo(scope).devices).toContainEqual(
      expect.objectContaining({ id: 'legacy-grant', scopes: ['read', 'input', 'approve', 'close'], connected: true }),
    );
    raw.close();
    const stored = JSON.parse(fs.readFileSync(path.join(home, '.nexus', 'remote-bridge', 'tokens.json'), 'utf8')) as {
      tokens: Array<{ id: string; scopes?: string[] }>;
    };
    expect(stored.tokens.find((token) => token.id === 'legacy-grant')?.scopes).toEqual([
      'read',
      'input',
      'approve',
      'close',
    ]);
  });

  it('a scope edit applies to the live connection: next request refused, stream push stops, restore works', async () => {
    const device = await pairDevice();
    const raw = await rawClient(device.token, device.identity);
    await expect(
      raw.ask({ type: 'pane.input', paneId: 'pane-app', data: 'git status', messageId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: true });
    await expect(raw.ask({ type: 'pane.stream.open', paneId: 'pane-app' })).resolves.toMatchObject({
      ok: true,
      result: { pushAvailable: true },
    });
    h.tap?.('sess-app', 'antes\r\n');
    await waitFor(() => raw.pushes.some((push) => push.type === 'pane.stream.data'), 'push com read');

    bridge.setRemoteDeviceScopes(scope, device.grantId, ['input']);
    const pushesBefore = raw.pushes.filter((push) => push.type === 'pane.stream.data').length;
    h.tap?.('sess-app', 'depois\r\n');
    await expect(raw.ask({ type: 'pane.read', paneId: 'pane-app' })).resolves.toMatchObject({
      ok: false,
      error: 'not authorized: scope-missing:read',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(raw.pushes.filter((push) => push.type === 'pane.stream.data')).toHaveLength(pushesBefore);

    bridge.setRemoteDeviceScopes(scope, device.grantId, ['read']);
    await expect(
      raw.ask({ type: 'pane.input', paneId: 'pane-app', data: 'ls', messageId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: false, error: 'not authorized: scope-missing:input' });
    await expect(raw.ask({ type: 'pane.close', paneId: 'pane-app' })).resolves.toMatchObject({
      ok: false,
      error: 'not authorized: scope-missing:close',
    });
    await expect(raw.ask({ type: 'pane.read', paneId: 'pane-app' })).resolves.toMatchObject({ ok: true });
    expect(h.writes).toEqual([['sess-app', 'git status\n']]);
    expect(h.closes).toEqual([]);
    expect(() => bridge.setRemoteDeviceScopes(scope, 'no-such-grant', ['read'])).toThrow('device not found');
    raw.close();
  });

  it('refuses unknown request types before any dialog, pane lookup or write (fail closed)', async () => {
    const device = await pairDevice();
    const raw = await rawClient(device.token, device.identity);
    for (const type of ['pane.kill', 'git.push', 'mission.complete', 'fs.write', '__proto__', 'constructor', 'toString']) {
      await expect(raw.ask({ type, paneId: 'pane-app', data: 'x' })).resolves.toMatchObject({
        ok: false,
        error: `unknown command: ${type}`,
      });
    }
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    raw.close();
  });
});

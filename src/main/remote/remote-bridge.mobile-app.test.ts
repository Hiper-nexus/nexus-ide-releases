import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
// F-968: o cliente de transporte do APP EXPO, importado por caminho (TS puro).
import {
  NexusBridgeClient,
  type NexusBridgeSocketFactory,
} from '../../../mobile/src/transport/nexus-bridge-client';
import {
  createNexusBridgeDeviceKey,
  nexusBridgeDeviceIdentity,
} from '../../../mobile/src/transport/nexus-bridge-device-key';
import {
  NEXUS_HOST_UNSUPPORTED,
  createNexusBridgeRpcClient,
  type NexusPaneOutput,
} from '../../../mobile/src/transport/nexus-bridge-rpc-adapter';

// Prova de compatibilidade de ponta a ponta: a Remote Bridge REAL (HTTPS/WSS,
// pareamento, desafio assinado, política mobile, broker de aprovação) em
// processo, e do outro lado o mesmo código que o app roda no celular. Só o
// que precisaria do Electron (registro de panes, PTY) é simulado.
const h = vi.hoisted(() => ({
  transcript: 'boot ok\n',
  writes: [] as Array<[string, string]>,
  resizes: [] as Array<[string, number, number]>,
  tap: null as ((sessionId: string, data: string) => void) | null,
  confirm: vi.fn(async () => false),
}));

vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      list: () => [{ id: 'mis-1', title: 'Portar transporte', status: 'running', updatedAt: 1 }],
    },
  }),
}));
vi.mock('../orch/pane-registry', () => {
  const pane = {
    paneId: 'pane-app',
    sessionId: 'sess-app',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
  };
  return {
    getPaneAuthzInfo: (ref: string) =>
      ref === pane.paneId || ref === pane.sessionId ? pane : null,
    listVisiblePaneSnapshots: () => [
      {
        paneId: 'pane-app',
        sessionId: 'sess-app',
        paneNumber: 4,
        title: 'Claude · x8',
        kind: 'cli-agent',
        state: 'busy',
      },
    ],
    readSessionOutput: (sessionId: string) => (sessionId === 'sess-app' ? h.transcript : ''),
    requestPaneClose: () => true,
  };
});
vi.mock('../orch/pane-authz', () => ({
  authorizePaneAccess: (caller: { scope: { projectId: string } }, pane: { projectId: string }) =>
    caller.scope.projectId === pane.projectId
      ? { allow: true }
      : { allow: false, reason: 'scope' },
}));
vi.mock('../pty/pty-manager', () => ({
  // O "shell": grava a linha e, como um PTY, devolve a saída pelo tap pouco depois.
  orchWriteSession: (sessionId: string, data: string) => {
    h.writes.push([sessionId, data]);
    h.transcript += `$ ${data}On branch main\n`;
    setTimeout(() => h.tap?.(sessionId, `$ ${data}On branch main\r\n`), 5);
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

/**
 * WebSocket do Node com o certificado autoassinado da bridge FIXADO pela
 * impressão digital que o desktop mostra (certFingerprint): o handshake TLS é
 * real e um certificado diferente derruba o socket antes do `open`.
 */
function pinnedSocketFactory(fingerprint256: string): NexusBridgeSocketFactory {
  return (target, handlers) => {
    const socket = new WebSocket(target, { rejectUnauthorized: false });
    socket.on('upgrade', (response) => {
      const peer = (response.socket as TLSSocket).getPeerCertificate();
      if (peer.fingerprint256 !== fingerprint256) socket.terminate();
    });
    socket.on('open', () => handlers.onOpen());
    socket.on('message', (data) => handlers.onMessage(data.toString()));
    socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));
    socket.on('error', (error) => handlers.onError(error.message));
    return {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };
  };
}

function newIdentity() {
  return nexusBridgeDeviceIdentity(
    createNexusBridgeDeviceKey((length) => new Uint8Array(crypto.randomBytes(length))),
  );
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-app-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
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

describe('app Expo ↔ Remote Bridge real (F-968)', () => {
  it('refuses a bridge whose certificate does not match the pinned fingerprint', async () => {
    const code = bridge.rotateRemotePairing(scope).pairingCode!;
    const wrongPin = new NexusBridgeClient({
      url,
      identity: async () => newIdentity(),
      createSocket: pinnedSocketFactory('00:11:22'),
    });
    await expect(wrongPin.pair(code)).rejects.toThrow(/conexão segura/);
    wrongPin.close();
    // O código não foi gasto: o socket nunca chegou a falar com a bridge.
    expect(bridge.getRemoteBridgeInfo(scope).pairingCode).toBe(code);
  });

  it('pairs, authenticates, lists panes, streams, sends a line and answers an approval', async () => {
    const info = bridge.rotateRemotePairing(scope);
    expect(info.certFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const pinned = pinnedSocketFactory(info.certFingerprint!);
    let socketsOpened = 0;
    const factory: NexusBridgeSocketFactory = (target, handlers) => {
      socketsOpened += 1;
      return pinned(target, handlers);
    };
    const identity = newIdentity();

    // 1) Pareamento — o que o leitor de QR faz com https://host/#code=XXXXXXXX.
    const pairing = new NexusBridgeClient({ url, identity: async () => identity, createSocket: factory });
    const issued = await pairing.pair(info.pairingCode!.toLowerCase());
    pairing.close();
    expect(issued.token).toMatch(/\S{20,}/);
    expect(issued.deviceKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Código de uso único: consumido pelo aparelho.
    expect(bridge.getRemoteBridgeInfo(scope).pairingCode).toBeUndefined();

    // 2) Host salvo → cliente do app com o token: auth.challenge + auth assinado.
    const logs: string[] = [];
    const client = createNexusBridgeRpcClient({
      url,
      token: issued.token,
      identity: async () => identity,
      createSocket: factory,
      onLog: (_level, message) => logs.push(message),
    });
    await waitFor(() => client.getState() === 'connected', 'autenticação com token salvo');

    // 3) status + listagem pelos métodos que o app já chama.
    const status = await client.sendRequest('status.get');
    expect(status).toMatchObject({ ok: true, result: { running: true, nexusBridge: true } });
    expect(JSON.stringify(status)).not.toContain('pairingCode');
    await expect(client.sendRequest('terminal.list')).resolves.toMatchObject({
      ok: true,
      result: { terminals: [{ handle: 'pane-app', title: 'Claude · x8', state: 'busy' }] },
    });
    await expect(client.sendRequest('mission.list')).resolves.toMatchObject({
      ok: true,
      result: [{ id: 'mis-1', status: 'running' }],
    });
    const snapshot = await client.nexus.snapshot();
    expect(snapshot.panes).toEqual([
      { paneId: 'pane-app', title: 'Claude · x8', state: 'busy', kind: 'cli-agent', paneNumber: 4 },
    ]);
    expect(snapshot.missions).toEqual([{ id: 'mis-1', title: 'Portar transporte', status: 'running' }]);
    expect(snapshot.approvals).toEqual([]);

    // 4) Terminal ao vivo: pane.stream.open + pane.read inicial.
    const outputs: NexusPaneOutput[] = [];
    const unsubscribe = client.subscribe('terminal.subscribe', { terminal: 'pane-app' }, (output) =>
      outputs.push(output as NexusPaneOutput),
    );
    await waitFor(
      () => outputs.some((output) => output.reset && output.text.includes('boot ok')),
      'leitura inicial do pane',
    );
    client.updateTerminalSubscriptionViewport('pane-app', { cols: 100, rows: 30 });
    await waitFor(() => h.resizes.length === 1, 'pane.resize');
    expect(h.resizes).toEqual([['sess-app', 100, 30]]);

    // 5) Uma linha completa vai ao PTY com Enter e a saída volta pelo push.
    const sent = await client.sendRequest('terminal.send', {
      terminal: 'pane-app',
      text: 'git status',
      enter: true,
      clientMessageId: 'msg-e2e-1',
    });
    expect(sent).toMatchObject({ ok: true });
    expect(h.writes).toEqual([['sess-app', 'git status\n']]);
    await waitFor(
      () => outputs.some((output) => !output.reset && output.text === '$ git status\nOn branch main\n'),
      'saída empurrada pelo pane.stream.data',
    );
    // Reenvio do outbox com o mesmo messageId: deduplicado no desktop, sem 2ª escrita.
    await client.sendRequest('terminal.send', {
      terminal: 'pane-app',
      text: 'git status',
      enter: true,
      clientMessageId: 'msg-e2e-1',
    });
    expect(h.writes).toHaveLength(1);
    // Teclas cruas: Ctrl-C (mesmo com Enter) e "1" sem Enter são recusados no app
    // com o aviso — não chegam nem à bridge (sem diálogo no desktop) nem ao PTY.
    await expect(
      client.sendRequest('terminal.send', { terminal: 'pane-app', text: '\u0003', enter: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: NEXUS_HOST_UNSUPPORTED } });
    await expect(
      client.sendRequest('terminal.send', { terminal: 'pane-app', text: '1', enter: false }),
    ).resolves.toMatchObject({ ok: false, error: { code: NEXUS_HOST_UNSUPPORTED } });
    expect(h.writes).toHaveLength(1);
    expect(h.confirm).not.toHaveBeenCalled();

    // 6) Aprovação estruturada: push approvals.changed → ops.snapshot → decisão.
    let changed = 0;
    const offApprovals = client.nexus.onApprovalsChanged(() => {
      changed += 1;
    });
    const opened = broker.approvalBroker.open({
      sessionId: 'sess-app',
      provider: 'claude',
      tool: 'Bash',
      summary: 'ls -la',
      options: [{ optionId: 'accept' }, { optionId: 'decline' }],
      waitMs: 60_000,
      fingerprint: broker.approvalFingerprint('Bash', { command: 'ls -la' }),
      highImpact: false,
    })!;
    await waitFor(() => changed > 0, 'push approvals.changed');
    const pending = (await client.nexus.snapshot()).approvals;
    expect(pending).toEqual([
      expect.objectContaining({
        requestId: opened.request.requestId,
        revision: 1,
        paneId: 'pane-app',
        tool: 'Bash',
        summary: 'ls -la',
        responseCapability: 'live',
      }),
    ]);
    const answer = await client.sendRequest('agentSession.respondToApproval', {
      itemId: pending[0]!.requestId,
      expectedRevision: pending[0]!.revision,
      optionId: 'accept',
    });
    expect(answer).toMatchObject({ ok: true, result: { status: 'accepted' } });
    await expect(opened.decision).resolves.toBe('accept');
    expect(h.writes).toHaveLength(1); // decisão para o broker, nunca tecla no PTY
    offApprovals();

    // 7) Área sem equivalente: recusa explícita, sem tocar na bridge.
    await expect(client.sendRequest('git.status')).resolves.toMatchObject({
      ok: false,
      error: { code: NEXUS_HOST_UNSUPPORTED, message: 'Git (git.status) não disponível em host Nexus' },
    });
    expect(logs).toContain('Git (git.status) não disponível em host Nexus');

    // 8) Revogação ao vivo no desktop: o app vai para "pareie de novo", sem loop.
    unsubscribe();
    const socketsBeforeRevoke = socketsOpened;
    bridge.revokeRemoteTokens(scope);
    await waitFor(() => client.getState() === 'auth-failed', 'revogação ao vivo');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(client.getState()).toBe('auth-failed');
    expect(socketsOpened).toBe(socketsBeforeRevoke);
    client.close();
  });
});

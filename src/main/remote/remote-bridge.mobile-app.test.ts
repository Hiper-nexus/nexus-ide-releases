import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
// F-994: o cliente de transporte do APP EXPO, importado por caminho (TS puro).
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
  type NexusBridgeRpcClient,
  type NexusPaneOutput,
} from '../../../mobile/src/transport/nexus-bridge-rpc-adapter';
import { nexusDiffLines } from '../../../mobile/src/transport/nexus-bridge-git-files';
import type { RemoteDeviceScope } from '../../shared/remote-types';

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
  // F-1014: checkouts reais em disco (preenchidos no beforeAll).
  repo: '',
  worktree: '',
  repoLink: '',
  // MOB-05 (F-1021): os sinais de atividade que o desktop já publica.
  stateTap: null as ((sessionId: string, state: string) => void) | null,
  exitTap: null as ((sessionId: string) => void) | null,
  semanticTap: null as ((entry: { sessionId: string; paneId: string; status: string }) => void) | null,
  orcaTap: null as ((sessionId: string, state: string) => void) | null,
}));

vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      list: () => [{ id: 'mis-1', title: 'Portar transporte', status: 'running', updatedAt: 1 }],
    },
  }),
}));
vi.mock('../orch/pane-registry', () => {
  // `scope`/`executionScope` são o que o Main registra para o pane; só
  // `rootRealPath` importa para o checkout (F-1014).
  const panes = () => [
    {
      paneId: 'pane-app',
      sessionId: 'sess-app',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      kind: 'cli-agent',
      scope: { rootRealPath: h.repo },
    },
    {
      paneId: 'pane-worker',
      sessionId: 'sess-worker',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      kind: 'cli-agent',
      scope: { rootRealPath: h.repo },
      executionScope: { rootRealPath: h.worktree },
    },
    {
      paneId: 'pane-moved',
      sessionId: 'sess-moved',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      kind: 'shell',
      scope: { rootRealPath: h.repoLink },
    },
    {
      paneId: 'pane-other',
      sessionId: 'sess-other',
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      kind: 'cli-agent',
      scope: { rootRealPath: h.repo },
    },
  ];
  return {
    getPaneAuthzInfo: (ref: string) =>
      panes().find((pane) => pane.paneId === ref || pane.sessionId === ref) ?? null,
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
  // MOB-05: estado do PTY (canal do toolbar) e saída da sessão.
  tapSessionState: (cb: (sessionId: string, state: string) => void) => {
    h.stateTap = cb;
    return () => {
      h.stateTap = null;
    };
  },
  tapSessionExit: (cb: (sessionId: string) => void) => {
    h.exitTap = cb;
    return () => {
      h.exitTap = null;
    };
  },
}));
// MOB-05: os dois planos de "pede você" da caixa ⌘J.
vi.mock('../orch/agent-status', () => ({
  tapAgentSemanticStatus: (cb: NonNullable<typeof h.semanticTap>) => {
    h.semanticTap = cb;
    return () => {
      h.semanticTap = null;
    };
  },
}));
vi.mock('../agent-hooks/hook-ingest', () => ({
  tapAgentHookStatus: (cb: NonNullable<typeof h.orcaTap>) => {
    h.orcaTap = cb;
    return () => {
      h.orcaTap = null;
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
function pinnedSocketFactory(
  fingerprint256: string,
  track?: (socket: WebSocket) => void,
): NexusBridgeSocketFactory {
  return (target, handlers) => {
    const socket = new WebSocket(target, { rejectUnauthorized: false });
    track?.(socket);
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

const OUTSIDE_SECRET = 'TOP-SECRET-OUTSIDE-THE-CHECKOUT';
const BIG_LINE = `${'x'.repeat(99)}\n`;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/**
 * F-1014: um checkout git real (alterado, preparado, novo, binário, grande,
 * segredo e links para fora), uma worktree de worker e um link para o
 * checkout (raiz que não é real).
 */
function createCheckouts(base: string): void {
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), `${OUTSIDE_SECRET}\n`);
  fs.writeFileSync(path.join(repo, 'README.md'), 'linha 1\nlinha 2\nlinha 3\n');
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  fs.writeFileSync(path.join(repo, 'big.txt'), BIG_LINE.replaceAll('x', 'a').repeat(3_000));
  fs.writeFileSync(path.join(repo, '.env'), 'API_TOKEN=old\n');
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'README.md'), 'linha 1\nlinha dois\nlinha 3\n');
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 2;\n');
  gitIn(repo, 'add', 'src/app.ts');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'nova nota\n');
  fs.writeFileSync(path.join(repo, 'image.bin'), Buffer.from([0, 9, 9, 9, 0, 255]));
  fs.writeFileSync(path.join(repo, 'big.txt'), BIG_LINE.replaceAll('x', 'b').repeat(3_000));
  fs.writeFileSync(path.join(repo, '.env'), 'API_TOKEN=new-secret\n');
  // Links que o celular nunca pode seguir: para fora do checkout e para o segredo.
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.txt'));
  fs.symlinkSync(outside, path.join(repo, 'leakdir'));
  fs.symlinkSync(path.join(repo, '.env'), path.join(repo, 'envlink'));
  const worktree = path.join(base, 'worker-wt');
  fs.mkdirSync(worktree);
  gitIn(worktree, 'init', '-q', '-b', 'worker');
  fs.writeFileSync(path.join(worktree, 'w.txt'), 'do worker\n');
  const repoLink = path.join(base, 'repo-link');
  fs.symlinkSync(repo, repoLink);
  h.repo = repo;
  h.worktree = worktree;
  h.repoLink = repoLink;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-app-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  createCheckouts(fs.realpathSync(home));
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

describe('app Expo ↔ Remote Bridge real (F-994)', () => {
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
    await expect(client.sendRequest('git.commit', { paneId: 'pane-app' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: NEXUS_HOST_UNSUPPORTED,
        message: 'Escrita no Git (git.commit) não disponível em host Nexus',
      },
    });
    expect(logs).toContain('Escrita no Git (git.commit) não disponível em host Nexus');

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

// ---------------------------------------------------------------------------
// F-1014: Git (status + diff) e arquivos (lista + leitura) do checkout de um
// pane, só leitura, pelos serviços do desktop — contra a bridge real.
// ---------------------------------------------------------------------------

async function connectApp(
  track?: (socket: WebSocket) => void,
  scopes?: readonly RemoteDeviceScope[], // MOB-05: aparelho com escopos estreitos (MOB-12)
) {
  const info = bridge.rotateRemotePairing(scope, scopes);
  const factory = pinnedSocketFactory(info.certFingerprint!, track);
  const identity = newIdentity();
  const pairing = new NexusBridgeClient({ url, identity: async () => identity, createSocket: factory });
  const issued = await pairing.pair(info.pairingCode!);
  pairing.close();
  const client: NexusBridgeRpcClient = createNexusBridgeRpcClient({
    url,
    token: issued.token,
    identity: async () => identity,
    createSocket: factory,
  });
  await waitFor(() => client.getState() === 'connected', 'autenticação do app');
  return { client, identity, token: issued.token };
}

type RawReply = { id?: string; ok: boolean; result?: unknown; error?: string };

/** Cliente cru (não o app): fala `{id, type, ...}` direto com a bridge. */
async function rawAuthedSocket(): Promise<{
  ask: (frame: Record<string, unknown>) => Promise<RawReply>;
  close: () => void;
}> {
  const { client, identity, token } = await connectApp();
  client.close();
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const ask = (frame: Record<string, unknown>) =>
    new Promise<RawReply>((resolve) => {
      const onMessage = (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as RawReply;
        if (reply.id !== frame.id) return;
        socket.off('message', onMessage);
        resolve(reply);
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify(frame));
    });
  const challenge = (await ask({ id: 'c', type: 'auth.challenge', token, deviceId: identity.deviceId }))
    .result as { challengeId: string; challenge: string };
  const auth = await ask({
    id: 'a',
    type: 'auth',
    token,
    deviceId: identity.deviceId,
    challengeId: challenge.challengeId,
    signature: identity.sign(challenge.challenge),
  });
  expect(auth.ok).toBe(true);
  return { ask, close: () => socket.close() };
}

describe('host Nexus no app: Git e arquivos do pane pela bridge real (F-1014)', () => {
  it('reads git status and per-file diffs of the pane checkout through the desktop Git service', async () => {
    const writesBefore = h.writes.length;
    const { client } = await connectApp();
    const status = await client.sendRequest('git.status', { paneId: 'pane-app' });
    expect(status.ok).toBe(true);
    const result = (status as { result: { entries: Array<Record<string, unknown>>; branch?: string } })
      .result;
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', area: 'unstaged', status: 'modified', restricted: false }),
        expect.objectContaining({ path: 'src/app.ts', area: 'staged', status: 'modified' }),
        expect.objectContaining({ path: 'notes.txt', area: 'untracked', status: 'untracked' }),
        expect.objectContaining({ path: 'image.bin', area: 'unstaged' }),
        // O segredo aparece na lista (o desktop mostra), mas marcado: o diff é recusado.
        expect.objectContaining({ path: '.env', area: 'unstaged', restricted: true }),
      ]),
    );

    const readme = await client.nexus.workspace.gitDiff('pane-app', { path: 'README.md', area: 'unstaged' });
    expect(readme).toMatchObject({ kind: 'patch', path: 'README.md', staged: false, truncated: false });
    expect(nexusDiffLines(readme).lines).toEqual(
      expect.arrayContaining([
        { kind: 'delete', text: 'linha 2', oldLineNumber: 2 },
        { kind: 'add', text: 'linha dois', newLineNumber: 2 },
        { kind: 'context', text: 'linha 3', oldLineNumber: 3, newLineNumber: 3 },
      ]),
    );
    // Nomes do Orca (`worktree: id:<pane>`, `filePath`, `staged`) chegam ao mesmo comando.
    const staged = await client.sendRequest('git.diff', {
      worktree: 'id:pane-app',
      filePath: 'src/app.ts',
      staged: true,
    });
    expect(staged).toMatchObject({ ok: true, result: { kind: 'patch', staged: true } });
    expect((staged as { result: { patch: string } }).result.patch).toContain('+export const a = 2;');
    await expect(
      client.nexus.workspace.gitDiff('pane-app', { path: 'notes.txt', area: 'untracked' }),
    ).resolves.toMatchObject({ kind: 'untracked', content: 'nova nota\n', truncated: false, binary: false });
    await expect(
      client.nexus.workspace.gitDiff('pane-app', { path: 'image.bin', area: 'unstaged' }),
    ).resolves.toEqual({ kind: 'binary', path: 'image.bin', staged: false });
    const big = await client.nexus.workspace.gitDiff('pane-app', { path: 'big.txt', area: 'unstaged' });
    expect(big).toMatchObject({ kind: 'patch', truncated: true });
    expect(big.kind === 'patch' ? big.patch.length : -1).toBeLessThanOrEqual(256 * 1024);

    // Worker em worktree: a raiz é a worktree DELE (executionScope), não o checkout do projeto.
    const worker = await client.nexus.workspace.gitStatus('pane-worker');
    expect(worker.entries.map((entry) => entry.path)).toEqual(['w.txt']);
    // Nada disso digitou no PTY do pane.
    expect(h.writes).toHaveLength(writesBefore);
    client.close();
  });

  it('lists folders and reads files with the explorer rules, size limit and binary detection', async () => {
    const { client } = await connectApp();
    const root = await client.nexus.workspace.listFiles('pane-app');
    const names = root.entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['src', 'README.md', 'notes.txt', 'big.txt', 'image.bin']));
    // `.git`, segredo e links (para fora ou para o segredo) não aparecem.
    for (const hidden of ['.git', '.env', 'leak.txt', 'leakdir', 'envlink']) {
      expect(names).not.toContain(hidden);
    }
    expect(root.entries.find((entry) => entry.name === 'src')).toEqual({ name: 'src', path: 'src', kind: 'dir' });
    await expect(client.nexus.workspace.listFiles('pane-app', 'src')).resolves.toEqual({
      path: 'src',
      entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file' }],
      truncated: false,
    });
    await expect(client.nexus.workspace.readFile('pane-app', 'README.md')).resolves.toEqual({
      path: 'README.md',
      content: 'linha 1\nlinha dois\nlinha 3\n',
      truncated: false,
      byteLength: 27,
      binary: false,
    });
    // Forma do `files.read` do Orca: {content, truncated, byteLength}.
    await expect(
      client.sendRequest('files.read', { worktree: 'id:pane-app', relativePath: 'src/app.ts' }),
    ).resolves.toMatchObject({ ok: true, result: { content: 'export const a = 2;\n', truncated: false } });
    const big = await client.nexus.workspace.readFile('pane-app', 'big.txt');
    expect(big).toMatchObject({ truncated: true, byteLength: 300_000, binary: false });
    expect(big.content).toHaveLength(256 * 1024);
    await expect(client.nexus.workspace.readFile('pane-app', 'image.bin')).resolves.toMatchObject({
      binary: true,
      content: '',
    });
    client.close();
  });

  it('refuses symlinks that escape the real root, parent/absolute paths, .git internals and secrets', async () => {
    const { client } = await connectApp();
    const ws = client.nexus.workspace;
    const messages: string[] = [];
    const refused = async (promise: Promise<unknown>, reason: string) => {
      const error = await promise.then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      messages.push(error);
      expect(error).toBe(`not authorized: ${reason}`);
    };
    // Links para fora do checkout (arquivo, pasta, e o diff de arquivo novo).
    await refused(ws.readFile('pane-app', 'leak.txt'), 'path-escapes-checkout');
    await refused(ws.readFile('pane-app', 'leakdir/secret.txt'), 'path-escapes-checkout');
    await refused(ws.listFiles('pane-app', 'leakdir'), 'path-escapes-checkout');
    await refused(ws.gitDiff('pane-app', { path: 'leak.txt', area: 'untracked' }), 'path-escapes-checkout');
    // Caminhos que saem da raiz sem link.
    await refused(ws.readFile('pane-app', '../outside/secret.txt'), 'parent-traversal');
    await refused(ws.readFile('pane-app', 'src/../../outside/secret.txt'), 'parent-traversal');
    await refused(ws.readFile('pane-app', path.join(h.repo, '..', 'outside', 'secret.txt')), 'absolute-path');
    await refused(ws.readFile('pane-app', 'README.md\u0003'), 'invalid-path');
    // Internos do Git (com e sem caixa) e segredos, inclusive por link interno.
    await refused(ws.readFile('pane-app', '.git/config'), 'git-internals');
    await refused(ws.readFile('pane-app', '.GIT/config'), 'git-internals');
    await refused(ws.listFiles('pane-app', '.git'), 'git-internals');
    await refused(ws.readFile('pane-app', '.env'), 'secret-file');
    await refused(ws.gitDiff('pane-app', { path: '.env', area: 'unstaged' }), 'secret-file');
    await refused(ws.readFile('pane-app', 'envlink'), 'secret-file');
    expect(messages.join('\n')).not.toContain(OUTSIDE_SECRET);
    expect(messages.join('\n')).not.toContain('new-secret');
    client.close();
  });

  it('authorizes per pane: another project, a checkout that is not its real path, an unknown pane', async () => {
    const { client } = await connectApp();
    await expect(client.nexus.workspace.gitStatus('pane-other')).rejects.toThrow('not authorized: scope');
    await expect(client.nexus.workspace.readFile('pane-other', 'README.md')).rejects.toThrow(
      'not authorized: scope',
    );
    await expect(client.nexus.workspace.gitStatus('pane-moved')).rejects.toThrow(
      'not authorized: checkout-identity-changed',
    );
    await expect(client.nexus.workspace.listFiles('pane-ghost')).rejects.toThrow('pane not found');
    // Sem paneId: recusa de forma, sem ir à bridge.
    await expect(client.sendRequest('git.status')).resolves.toMatchObject({
      ok: false,
      error: { message: 'parâmetro paneId ausente' },
    });
    client.close();
  });

  it('raw client: no write commands, the same id twice is answered twice without side effects, no remote URL', async () => {
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h.repo, encoding: 'utf8' });
    const headBefore = head();
    const raw = await rawAuthedSocket();
    const first = await raw.ask({ id: 'dup', type: 'git.status', paneId: 'pane-app' });
    const second = await raw.ask({ id: 'dup', type: 'git.status', paneId: 'pane-app' });
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    // Sem `remote` (URL pode ter credencial) e sem a saída crua do porcelain.
    expect(Object.keys(first.result as object).sort()).toEqual([
      'ahead',
      'behind',
      'branch',
      'clean',
      'hasUnresolvedConflicts',
      'hasUpstream',
      'paneId',
      'staged',
      'truncated',
      'unstaged',
      'untracked',
    ]);
    for (const type of ['git.commit', 'git.stage', 'git.checkout', 'files.write']) {
      await expect(
        raw.ask({ id: `w-${type}`, type, paneId: 'pane-app', message: 'x', path: 'README.md', content: 'x' }),
      ).resolves.toEqual({ id: `w-${type}`, ok: false, error: `unknown command: ${type}` });
    }
    await expect(raw.ask({ id: 'after', type: 'git.status', paneId: 'pane-app' })).resolves.toEqual({
      ...first,
      id: 'after',
    });
    expect(head()).toBe(headBefore);
    expect(fs.readFileSync(path.join(h.repo, 'README.md'), 'utf8')).toBe('linha 1\nlinha dois\nlinha 3\n');
    raw.close();
  });

  it('re-authenticates after a dropped socket; a revoked device fails via auth-failed; a re-paired one reads again', async () => {
    const sockets: WebSocket[] = [];
    const { client } = await connectApp((socket) => sockets.push(socket));
    await expect(client.nexus.workspace.gitStatus('pane-app')).resolves.toMatchObject({ clean: false });
    const opened = sockets.length;
    sockets.at(-1)!.terminate();
    await waitFor(
      () => sockets.length > opened && client.getState() === 'connected',
      'reconexão com auth',
      10_000,
    );
    await expect(client.nexus.workspace.listFiles('pane-app', 'src')).resolves.toMatchObject({ path: 'src' });

    bridge.revokeRemoteTokens(scope);
    await waitFor(() => client.getState() === 'auth-failed', 'revogação');
    await expect(client.sendRequest('git.status', { paneId: 'pane-app' })).rejects.toThrow(/pareie de novo/);
    await expect(client.nexus.workspace.readFile('pane-app', 'README.md')).rejects.toThrow(/pareie de novo/);
    client.close();

    const again = await connectApp();
    await expect(again.client.nexus.workspace.readFile('pane-app', 'README.md')).resolves.toMatchObject({
      truncated: false,
    });
    again.client.close();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// MOB-05 (F-1021): atividade dos panes empurrada pela bridge real, a partir dos
// sinais que o desktop já publica (estado do PTY + planos de "pede você").
// ---------------------------------------------------------------------------

describe('host Nexus no app: atividade dos panes pela bridge real (MOB-05)', () => {
  type ActivityFrame = { type?: string; [key: string]: unknown };
  let stopSources: (() => void) | null = null;
  let activity: typeof import('./remote-pane-activity');

  beforeAll(async () => {
    activity = await import('./remote-pane-activity');
    const sources = await import('./remote-pane-activity-sources');
    stopSources = sources.startRemotePaneActivitySources();
  });

  afterAll(() => {
    stopSources?.();
    activity.__setRemotePaneActivityLimitsForTests(null);
  });

  async function connectRecording(scopes?: readonly RemoteDeviceScope[]) {
    const frames: ActivityFrame[] = [];
    const app = await connectApp(
      (socket) =>
        socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as ActivityFrame)),
      scopes,
    );
    const pushes: Array<{ paneId: string; activity: string; at: number }> = [];
    app.client.nexus.onPaneActivity((entry) => pushes.push({ ...entry }));
    return { ...app, frames, pushes };
  }

  it('empurra a transição só para quem lê o pane, sem saída, e o app relê o estado atual', async () => {
    activity.__setRemotePaneActivityLimitsForTests({ coalesceMs: 20, maxPerWindow: 50, windowMs: 60_000 });
    const { client, frames, pushes } = await connectRecording();
    const last = (paneId: string) => pushes.filter((push) => push.paneId === paneId).at(-1)?.activity;

    h.stateTap!('sess-app', 'busy');
    h.stateTap!('sess-other', 'busy'); // pane de outro projeto: este aparelho não lê
    await waitFor(() => last('pane-app') === 'working', 'push trabalhando');

    h.semanticTap!({ sessionId: 'sess-app', paneId: 'pane-app', status: 'awaiting-input' });
    h.orcaTap!('sess-other', 'waiting');
    await waitFor(() => last('pane-app') === 'waiting', 'push pede você');

    // O app reconstrói o cartão depois de conectar: só panes legíveis.
    await expect(client.nexus.paneActivity()).resolves.toEqual([
      { paneId: 'pane-app', activity: 'waiting', at: expect.any(Number) },
    ]);

    h.semanticTap!({ sessionId: 'sess-app', paneId: 'pane-app', status: 'completed' });
    h.stateTap!('sess-app', 'idle');
    await waitFor(() => last('pane-app') === 'idle', 'push parado/terminou');
    h.exitTap!('sess-app');
    h.exitTap!('sess-other');
    await waitFor(() => last('pane-app') === 'exited', 'push encerrado');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const wire = frames.filter((frame) => frame.type === 'pane.activity');
    expect(wire.map((frame) => frame.activity)).toEqual(['working', 'waiting', 'idle', 'exited']);
    for (const frame of wire) {
      // Só pane, atividade e instante: nada de sessão nem de saída do terminal.
      expect(Object.keys(frame).sort()).toEqual(['activity', 'at', 'paneId', 'type']);
      expect(frame.paneId).toBe('pane-app');
    }
    expect(JSON.stringify(frames)).not.toContain('pane-other');
    expect(JSON.stringify(frames)).not.toContain('boot ok');
    client.close();
  });

  it('aparelho sem o escopo "Ver" (read, MOB-12) não recebe atividade nem lê a lista', async () => {
    activity.__setRemotePaneActivityLimitsForTests({ coalesceMs: 20, maxPerWindow: 50, windowMs: 60_000 });
    const reader = await connectRecording();
    const blind = await connectRecording(['input', 'approve']);
    h.stateTap!('sess-moved', 'busy');
    await waitFor(
      () => reader.pushes.some((push) => push.paneId === 'pane-moved' && push.activity === 'working'),
      'push para o aparelho com read',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(blind.frames.filter((frame) => frame.type === 'pane.activity')).toEqual([]);
    expect(blind.pushes).toEqual([]);
    await expect(blind.client.nexus.paneActivity()).rejects.toThrow(/permissão "Ver"/);
    reader.client.close();
    blind.client.close();
  });

  it('agrupa a rajada em um push e, acima do teto, segura até a janela abrir sem perder o estado final', async () => {
    activity.__setRemotePaneActivityLimitsForTests({ coalesceMs: 30, maxPerWindow: 2, windowMs: 800 });
    const { client, pushes } = await connectRecording();
    const worker = () =>
      pushes.filter((push) => push.paneId === 'pane-worker').map((push) => push.activity);

    // 20 trocas busy↔idle no mesmo instante: um push só, com o estado final.
    for (let i = 0; i < 20; i += 1) h.stateTap!('sess-worker', i % 2 === 0 ? 'busy' : 'idle');
    await waitFor(() => worker().length === 1, 'push agrupado');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worker()).toEqual(['idle']);

    // A 2ª troca sai; a 3ª passa do teto (2 por janela) e espera a janela abrir.
    h.stateTap!('sess-worker', 'busy');
    await waitFor(() => worker().length === 2, '2º push');
    h.stateTap!('sess-worker', 'idle');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(worker()).toEqual(['idle', 'working']);
    await waitFor(() => worker().length === 3, 'estado final depois da janela', 3_000);
    expect(worker()).toEqual(['idle', 'working', 'idle']);
    client.close();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import { OMP_RPC_CHANNELS } from '../../shared/omp-rpc-types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';

/**
 * cli-rpc grid pane (P3): spawnOmpRpcPane presents an `omp --mode rpc-ui`
 * session as an ordinary grid pane — PTY-shaped streaming with per-session
 * sequences + replay, protocol-driven busy/idle, line-buffered input →
 * prompt, kill → dispose + synthetic exit. Electron, the omp child service,
 * the gate, the MCP surface and the activity publisher are mocked.
 */

interface FakeSessionOptions {
  sessionId: string;
  model?: { provider: string; modelId: string };
  env?: Record<string, string>;
  governed?: boolean;
  credentialSecrets?: readonly string[];
}

type FakePushEvent = { kind: string; [key: string]: unknown };

interface FakeSessionCallbacks {
  onPush?: (event: FakePushEvent) => void;
  [key: string]: unknown;
}

const h = vi.hoisted(() => {
  class FakeOmpRpcSession {
    static instances: FakeOmpRpcSession[] = [];
    readonly options: FakeSessionOptions;
    readonly callbacks: FakeSessionCallbacks;
    readonly sessionId: string;
    state = 'ready';
    disposed = false;
    terminateImpl: () => Promise<{
      ok: boolean;
      rootExited: boolean;
      descendantsExited: boolean;
      error?: string;
    }> = async () => ({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });

    constructor(options: FakeSessionOptions, callbacks: FakeSessionCallbacks) {
      this.options = options;
      this.callbacks = callbacks;
      this.sessionId = options.sessionId;
      FakeOmpRpcSession.instances.push(this);
    }

    dispose(): void {
      this.disposed = true;
    }

    async terminate(): Promise<{
      ok: boolean;
      rootExited: boolean;
      descendantsExited: boolean;
      error?: string;
    }> {
      this.disposed = true;
      return this.terminateImpl();
    }

    snapshot(): { state: string } {
      return { state: this.state };
    }

    async prompt(): Promise<void> {}
    async abort(): Promise<void> {}
    async setModel(): Promise<void> {}
    respondUi(): boolean {
      return true;
    }
  }

  const resolveOmpBin = vi.fn(async () => ({ binPath: '/fake/omp' }));
  const preflightOmpRpcSpawn = vi.fn(async (selectedModel?: string) => {
    const modelRef =
      selectedModel || 'anthropic/claude-sonnet-4-6';
    const slash = modelRef.indexOf('/');
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new Error(
        `modelo omp malformado: "${modelRef}" (formato esperado: provider/modelId)`,
      );
    }
    const resolved = await resolveOmpBin();
    return {
      modelRef,
      model: {
        provider: modelRef.slice(0, slash),
        modelId: modelRef.slice(slash + 1),
      },
      binPath: resolved.binPath,
      keyEnv: {},
      credentialScope: {
        modelProvider: modelRef.slice(0, slash),
        source: 'broker',
        authorityProviderId: modelRef.slice(0, slash),
        envNames: [] as string[],
      },
    };
  });

  return {
    FakeOmpRpcSession,
    getAllWindows: vi.fn((): unknown[] => []),
    ipcHandle: vi.fn(),
    resolveOmpBin,
    buildOmpChildEnv: vi.fn(() => ({ PATH: '/usr/bin', NO_COLOR: '1' })),
    preflightOmpRpcSpawn,
    waitForOmpSessionReady: vi.fn(async () => undefined),
    mintToken: vi.fn((input: { missionId?: string }) => ({
      token: 'gate-token',
      missionId: input.missionId,
    })),
    bindTokenToSession: vi.fn(),
    releaseSession: vi.fn(),
    releaseSessionByToken: vi.fn(),
    dispatchToolCall: vi.fn(),
    buildToolset: vi.fn((): unknown[] => []),
    auditSuccess: vi.fn(),
    getAdapter: vi.fn((): undefined => undefined),
    publishSessionActivityState: vi.fn(),
    publishExternalSessionExit: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: h.getAllWindows },
  ipcMain: { handle: h.ipcHandle },
}));
vi.mock('./omp-rpc-service', () => ({
  OmpRpcSession: h.FakeOmpRpcSession,
  buildOmpChildEnv: h.buildOmpChildEnv,
  resolveOmpBin: h.resolveOmpBin,
  waitForOmpSessionReady: h.waitForOmpSessionReady,
}));
vi.mock('../pty/pre-spawn-probe', () => ({
  preflightOmpRpcSpawn: h.preflightOmpRpcSpawn,
}));
vi.mock('../orch/gate', () => ({
  mintToken: h.mintToken,
  bindTokenToSession: h.bindTokenToSession,
  releaseSession: h.releaseSession,
  releaseSessionByToken: h.releaseSessionByToken,
}));
vi.mock('../orch/mcp-dispatch', () => ({ dispatchToolCall: h.dispatchToolCall }));
vi.mock('../orch/tools', () => ({ buildToolset: h.buildToolset }));
vi.mock('../jarvis/audit-log', () => ({ auditSuccess: h.auditSuccess }));
vi.mock('./adapter-registry', () => ({ getAdapter: h.getAdapter }));
vi.mock('../pty/pty-manager', () => ({
  publishSessionActivityState: h.publishSessionActivityState,
  publishExternalSessionExit: h.publishExternalSessionExit,
}));

import {
  __resetOmpRpcLifecycleForTests,
  __resetOmpRpcPaneStreamsForTests,
  acknowledgeOmpRpcPaneOutput,
  canRendererControlOmpRpcPane,
  detachOmpRpcMissionPane,
  disposeAllOmpRpcSessions,
  isOmpRpcPaneOwnedBy,
  isOmpRpcPaneSession,
  isOmpRpcSession,
  killOmpRpcPane,
  liveOmpRpcRuntimeSummary,
  listOmpRpcSessions,
  recoverOmpRpcPaneOutput,
  spawnOmpRpcPane,
  sealOmpRpcAdmissionForShutdown,
  terminateOmpRpcSession,
  writeOmpRpcPaneInput,
} from './omp-rpc-ipc';

type FakeWebContents = WebContents & {
  send: ReturnType<typeof vi.fn>;
  __setDestroyed: (destroyed: boolean) => void;
};

function fakeWebContents(id: number): FakeWebContents {
  const state = { destroyed: false };
  return {
    id,
    isDestroyed: () => state.destroyed,
    isCrashed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    __setDestroyed: (destroyed: boolean) => {
      state.destroyed = destroyed;
    },
  } as unknown as FakeWebContents;
}

const scopeA = testProjectScope({
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/ws/a',
});

function lastSession(): InstanceType<typeof h.FakeOmpRpcSession> {
  const instance = h.FakeOmpRpcSession.instances.at(-1);
  if (!instance) throw new Error('nenhuma sessão omp construída');
  return instance;
}

function emitPush(event: FakePushEvent): void {
  const onPush = lastSession().callbacks.onPush;
  if (!onPush) throw new Error('sessão sem onPush');
  onPush(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.FakeOmpRpcSession.instances.length = 0;
  h.getAllWindows.mockReturnValue([]);
});

afterEach(async () => {
  await disposeAllOmpRpcSessions();
  __resetOmpRpcPaneStreamsForTests();
  __resetOmpRpcLifecycleForTests();
});

describe('spawnOmpRpcPane', () => {
  it('inventories deferred preflight and refuses materialization after owner destruction', async () => {
    let resolveBin!: (value: { binPath: string }) => void;
    h.resolveOmpBin.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBin = resolve;
      }),
    );
    const owner = fakeWebContents(700);
    const spawn = spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });

    expect(liveOmpRpcRuntimeSummary()).toEqual({ total: 1, busy: 1 });
    expect(listOmpRpcSessions()).toEqual([]);
    owner.__setDestroyed(true);
    resolveBin({ binPath: '/fake/omp' });

    await expect(spawn).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/owner.*disappeared|owner.*unavailable/i),
    });
    expect(h.mintToken).not.toHaveBeenCalled();
    expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
    expect(liveOmpRpcRuntimeSummary()).toEqual({ total: 0, busy: 0 });
  });

  it('blocks a new acquire after a zero snapshot is synchronously sealed', async () => {
    expect(liveOmpRpcRuntimeSummary()).toEqual({ total: 0, busy: 0 });
    sealOmpRpcAdmissionForShutdown();

    await expect(
      spawnOmpRpcPane({
        owner: fakeWebContents(701),
        scope: scopeA,
        workspaceRoot: scopeA.rootRealPath,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/shutdown is in progress/i),
    });
    expect(h.resolveOmpBin).not.toHaveBeenCalled();
    expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
  });

  it('mantém admission fechada após disposeAll resolver', async () => {
    await expect(disposeAllOmpRpcSessions()).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [],
      terminatedSessionIds: [],
      failedSessionIds: [],
    });

    await expect(
      spawnOmpRpcPane({
        owner: fakeWebContents(0),
        scope: scopeA,
        workspaceRoot: scopeA.rootRealPath,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/shutdown is in progress/i),
    });
    expect(h.resolveOmpBin).not.toHaveBeenCalled();
    expect(h.mintToken).not.toHaveBeenCalled();
    expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
  });

  it('shutdown revoga pane spawn enquanto resolveOmpBin está pendente', async () => {
    let resolveBin!: (value: { binPath: string }) => void;
    h.resolveOmpBin.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBin = resolve;
      }),
    );

    const spawnOutcome = spawnOmpRpcPane({
      owner: fakeWebContents(0),
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    expect(h.resolveOmpBin).toHaveBeenCalledOnce();

    let shutdownSettled = false;
    const shutdown = disposeAllOmpRpcSessions().then((result) => {
      shutdownSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    resolveBin({ binPath: '/fake/omp' });
    await expect(spawnOutcome).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/revoked by shutdown/i),
    });
    expect(h.mintToken).not.toHaveBeenCalled();
    expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
    await expect(shutdown).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [],
      terminatedSessionIds: [],
      failedSessionIds: [],
    });
  });

  it('spawna como panel com paneId real, token mintado e prompt inicial', async () => {
    const owner = fakeWebContents(1);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      paneId: 'pane-1',
      model: 'anthropic/claude-sonnet-4-6',
      prompt: 'começa a missão',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.mintToken).toHaveBeenCalledOnce();
    expect(h.bindTokenToSession).toHaveBeenCalledOnce();

    const rows = listOmpRpcSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: result.sessionId,
      paneId: 'pane-1',
      kind: 'panel',
    });

    const session = lastSession();
    const promptSpy = vi.spyOn(session, 'prompt');
    expect(promptSpy).not.toHaveBeenCalled(); // prompt já foi enviado no spawn
    expect(isOmpRpcPaneSession(result.sessionId)).toBe(true);
    expect(isOmpRpcPaneOwnedBy(result.sessionId, owner)).toBe(true);
    expect(isOmpRpcPaneOwnedBy(result.sessionId, fakeWebContents(99))).toBe(false);
    expect(session.options.governed).toBe(true);
    expect(h.publishSessionActivityState).toHaveBeenCalledWith(
      result.sessionId,
      'idle',
    );
  });

  it('aplica somente o env da credencial escolhida pelo preflight', async () => {
    h.preflightOmpRpcSpawn.mockResolvedValueOnce({
      modelRef: 'zai/glm-5',
      model: { provider: 'zai', modelId: 'glm-5' },
      binPath: '/fake/omp',
      keyEnv: {
        ZAI_API_KEY: 'selected-secret',
      },
      credentialScope: {
        modelProvider: 'zai',
        source: 'launcher',
        authorityProviderId: 'glm',
        envNames: ['ZAI_API_KEY'],
      },
    });
    const result = await spawnOmpRpcPane({
      owner: fakeWebContents(101),
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      model: 'zai/glm-5',
    });
    expect(result.ok).toBe(true);
    expect(lastSession().options.env).toEqual({
      PATH: '/usr/bin',
      NO_COLOR: '1',
      ZAI_API_KEY: 'selected-secret',
    });
    expect(lastSession().options.env).not.toHaveProperty(
      'OPENROUTER_API_KEY',
    );
  });

  it('falha sem vazar gate quando o binário não resolve', async () => {
    h.resolveOmpBin.mockRejectedValueOnce(new Error('sem omp'));
    const result = await spawnOmpRpcPane({
      owner: fakeWebContents(2),
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    expect(result.ok).toBe(false);
    expect(h.mintToken).not.toHaveBeenCalled();
    expect(listOmpRpcSessions()).toHaveLength(0);
  });

  it('prompt inicial rejeitado encerra pane, sessão e gate', async () => {
    vi.spyOn(h.FakeOmpRpcSession.prototype, 'prompt').mockRejectedValueOnce(
      new Error('prompt rejeitado'),
    );
    const result = await spawnOmpRpcPane({
      owner: fakeWebContents(10),
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      prompt: 'começar',
    });

    expect(result).toEqual({ ok: false, error: 'prompt rejeitado' });
    expect(lastSession().disposed).toBe(true);
    expect(listOmpRpcSessions()).toHaveLength(0);
    expect(h.releaseSession).toHaveBeenCalledOnce();
  });
});

describe('streaming, estado, input e kill do pane RPC', () => {
  it('text-delta vira PTY data sequenciado; recover serve o replay do gap', async () => {
    const owner = fakeWebContents(3);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    if (!result.ok) throw new Error('spawn falhou');
    const { sessionId } = result;

    emitPush({ kind: 'text-delta', delta: 'primeira ' });
    emitPush({ kind: 'text-delta', delta: 'segunda' });

    expect(owner.send).toHaveBeenCalledWith(PTY_CHANNELS.data, {
      sessionId,
      sequence: 1,
      data: 'primeira ',
    });
    expect(owner.send).toHaveBeenCalledWith(PTY_CHANNELS.data, {
      sessionId,
      sequence: 2,
      data: 'segunda',
    });

    expect(recoverOmpRpcPaneOutput(sessionId, 1)).toEqual([
      { sessionId, sequence: 2, data: 'segunda' },
    ]);
    expect(recoverOmpRpcPaneOutput(sessionId, 0)).toHaveLength(2);
    expect(acknowledgeOmpRpcPaneOutput(sessionId)).toBe(true);
  });

  it('status do protocolo dirige busy/idle — nunca timeout', async () => {
    const owner = fakeWebContents(4);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    if (!result.ok) throw new Error('spawn falhou');
    const { sessionId } = result;

    emitPush({ kind: 'status', state: 'busy' });
    expect(h.publishSessionActivityState).toHaveBeenCalledWith(
      sessionId,
      'busy',
    );
    emitPush({ kind: 'status', state: 'idle' });
    expect(h.publishSessionActivityState).toHaveBeenLastCalledWith(
      sessionId,
      'idle',
    );
  });

  it('input acumula até Enter e vira prompt; sessão desconhecida recusa', async () => {
    const owner = fakeWebContents(5);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    if (!result.ok) throw new Error('spawn falhou');
    const { sessionId } = result;
    const session = lastSession();
    const promptSpy = vi.spyOn(session, 'prompt');

    expect(writeOmpRpcPaneInput(sessionId, 'arruma o')).toBe(true);
    expect(writeOmpRpcPaneInput(sessionId, ' login')).toBe(true);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(writeOmpRpcPaneInput(sessionId, '\r')).toBe(true);
    expect(promptSpy).toHaveBeenCalledWith('arruma o login');
    expect(writeOmpRpcPaneInput('sessao-inexistente', 'x')).toBe(false);
  });

  it('keeps a grid mission session observable but not renderer-controllable', async () => {
    const owner = fakeWebContents(51);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      missionId: 'mission-a',
      workerIncarnationId: 'worker-a',
    });
    if (!result.ok) throw new Error('spawn falhou');

    expect(isOmpRpcPaneOwnedBy(result.sessionId, owner)).toBe(true);
    expect(canRendererControlOmpRpcPane(result.sessionId, owner)).toBe(false);
    expect(listOmpRpcSessions()).toEqual([
      expect.objectContaining({
        sessionId: result.sessionId,
        missionId: 'mission-a',
        kind: 'mission',
      }),
    ]);
    expect(killOmpRpcPane(result.sessionId)).toBe(true);
  });

  it('detaches mission presentation so a reused renderer cannot observe scope A in B', async () => {
    const owner = fakeWebContents(52);
    bindResolvedRendererWorkspaceScope(owner, scopeA);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      missionId: 'mission-a',
      workerIncarnationId: 'worker-a',
    });
    if (!result.ok) throw new Error('spawn falhou');
    expect(listOmpRpcSessions(owner)).toHaveLength(1);

    expect(detachOmpRpcMissionPane(owner, result.sessionId)).toBe(true);
    expect(isOmpRpcPaneOwnedBy(result.sessionId, owner)).toBe(false);
    expect(canRendererControlOmpRpcPane(result.sessionId, owner)).toBe(false);
    owner.send.mockClear();
    emitPush({ kind: 'text-delta', delta: 'segredo do projeto A' });
    expect(owner.send).not.toHaveBeenCalledWith(
      PTY_CHANNELS.data,
      expect.objectContaining({ sessionId: result.sessionId }),
    );

    bindResolvedRendererWorkspaceScope(
      owner,
      testProjectScope({
        projectId: 'project-b',
        checkoutId: 'checkout-b',
        rootRealPath: '/ws/b',
      }),
    );
    expect(listOmpRpcSessions(owner)).toEqual([]);
    clearRendererWorkspaceScope(owner);
    expect(killOmpRpcPane(result.sessionId)).toBe(true);
  });

  it('kill emite exit sintético, publica idle e dispõe a sessão', async () => {
    const owner = fakeWebContents(6);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    if (!result.ok) throw new Error('spawn falhou');
    const { sessionId } = result;

    expect(killOmpRpcPane(sessionId)).toBe(true);
    expect(owner.send).toHaveBeenCalledWith(PTY_CHANNELS.exit, {
      sessionId,
      exitCode: 0,
    });
    expect(h.publishSessionActivityState).toHaveBeenLastCalledWith(
      sessionId,
      'idle',
    );
    await vi.waitFor(() => {
      expect(listOmpRpcSessions()).toHaveLength(0);
    });
    expect(writeOmpRpcPaneInput(sessionId, 'x')).toBe(false);
    expect(killOmpRpcPane(sessionId)).toBe(false);
  });

  it('term provider só resolve depois da prova física de root e descendentes', async () => {
    const result = await spawnOmpRpcPane({
      owner: fakeWebContents(31),
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      paneId: 'pane-physical-exit',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = lastSession();
    let resolveProof!: (proof: {
      ok: true;
      rootExited: true;
      descendantsExited: true;
    }) => void;
    session.terminateImpl =
      () =>
        new Promise((resolve) => {
          resolveProof = resolve;
        });
    let settled = false;
    const termination = terminateOmpRpcSession(result.sessionId, {
      timeoutMs: 10_000,
      pollMs: 1,
    }).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(session.disposed).toBe(true);
    expect(h.releaseSession).toHaveBeenCalledOnce();
    expect(isOmpRpcSession(result.sessionId)).toBe(true);
    expect(settled).toBe(false);

    resolveProof({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    await expect(termination).resolves.toBe(true);
    expect(isOmpRpcSession(result.sessionId)).toBe(false);
    expect(listOmpRpcSessions()).toEqual([]);
  });

  it('evento exit natural só libera o pane após a prova física completa', async () => {
    const owner = fakeWebContents(7);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    if (!result.ok) throw new Error('spawn falhou');
    const { sessionId } = result;

    emitPush({ kind: 'exit', code: 1 });
    expect(owner.send).toHaveBeenCalledWith(PTY_CHANNELS.exit, {
      sessionId,
      exitCode: 1,
    });
    await vi.waitFor(() => {
      expect(listOmpRpcSessions()).toHaveLength(0);
    });
  });

  it('preserva a autoridade e bloqueia shutdown/replacement quando descendentes não saem', async () => {
    const result = await spawnOmpRpcPane({
      owner: fakeWebContents(71),
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
      paneId: 'pane-descendant-stuck',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = lastSession();
    session.terminateImpl = async () => ({
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error: 'descendant still alive',
    });

    session.state = 'exited';
    emitPush({ kind: 'exit', code: 1 });
    await vi.waitFor(() => {
      expect(h.releaseSession).toHaveBeenCalled();
    });
    expect(isOmpRpcSession(result.sessionId)).toBe(true);
    expect(isOmpRpcPaneSession(result.sessionId)).toBe(true);

    await expect(terminateOmpRpcSession(result.sessionId)).resolves.toBe(false);
    await expect(disposeAllOmpRpcSessions()).resolves.toEqual({
      ok: false,
      attemptedSessionIds: [result.sessionId],
      terminatedSessionIds: [],
      failedSessionIds: [result.sessionId],
    });
    expect(isOmpRpcSession(result.sessionId)).toBe(true);

    // Test cleanup may now prove the same preserved physical identity.
    session.terminateImpl = async () => ({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
  });

  it('pushEvent de panel continua indo só ao owner (canal ompRpc)', async () => {
    const owner = fakeWebContents(8);
    const other = fakeWebContents(9);
    const result = await spawnOmpRpcPane({
      owner,
      scope: scopeA,
      workspaceRoot: scopeA.rootRealPath,
    });
    if (!result.ok) throw new Error('spawn falhou');

    const event = { kind: 'text-delta', delta: 'x' };
    emitPush(event);
    expect(owner.send).toHaveBeenCalledWith(OMP_RPC_CHANNELS.event, {
      sessionId: result.sessionId,
      event,
    });
    expect(other.send).not.toHaveBeenCalled();
  });
});

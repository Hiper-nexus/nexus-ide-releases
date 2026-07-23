import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  OMP_RPC_CHANNELS,
  type OmpRpcStartResult,
} from '../../shared/omp-rpc-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';

/**
 * R1/R4 hardening tests for omp-rpc-ipc:
 * - R1: push envelopes carry message deltas (= session CONTENT), so panel
 *   sessions stream only to their owner renderer and mission workers only to
 *   windows bound to the same project scope — never to foreign projects.
 * - R4: a malformed non-empty model ref fails loud (provider/modelId) before
 *   any gate token is minted or process spawned.
 *
 * Electron, the omp child service, the gate and the MCP surface are mocked;
 * the renderer→scope registry is the REAL module (same pattern as
 * project-scoped-broadcast.test.ts / failover.test.ts).
 */

interface FakeSessionOptions {
  sessionId: string;
  workspaceRoot?: string;
  model?: { provider: string; modelId: string };
  approvalPolicy?: 'safe' | 'yolo';
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

    constructor(options: FakeSessionOptions, callbacks: FakeSessionCallbacks) {
      this.options = options;
      this.callbacks = callbacks;
      this.sessionId = options.sessionId;
      FakeOmpRpcSession.instances.push(this);
    }

    dispose(): void {
      this.disposed = true;
    }

    snapshot(): { state: string } {
      return { state: this.state };
    }

    async prompt(): Promise<void> {}
    async promptAndWaitForAgentStart(): Promise<void> {}
    async abort(): Promise<void> {}
    async setModel(): Promise<void> {}
    respondUi(): boolean {
      return true;
    }
    async listModels(): Promise<unknown[]> {
      return [];
    }
  }

  return {
    FakeOmpRpcSession,
    getAllWindows: vi.fn((): unknown[] => []),
    ipcHandle: vi.fn(),
    resolveOmpBin: vi.fn(async () => ({ binPath: '/fake/omp' })),
    waitForOmpSessionReady: vi.fn(async () => undefined),
    mintToken: vi.fn((input: {
      missionId?: string;
      allowedTools?: string[];
      executionScope?: ProjectExecutionScope;
    }) => ({
      ...input,
      token: 'gate-token',
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
  resolveOmpBin: h.resolveOmpBin,
  waitForOmpSessionReady: h.waitForOmpSessionReady,
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
  disposeAllOmpRpcSessions,
  isSafeOmpMissionPreflightFailure,
  listOmpRpcSessions,
  registerOmpRpcIpc,
  spawnMissionOmpRpcWorker,
} from './omp-rpc-ipc';
import { getExternalWorkerSessionInfo } from '../orch/external-worker-session-registry';

type FakeWebContents = WebContents & {
  send: ReturnType<typeof vi.fn>;
  __setDestroyed: (destroyed: boolean) => void;
};

function fakeWebContents(id: number, destroyed = false): FakeWebContents {
  const state = { destroyed };
  return {
    id,
    isDestroyed: () => state.destroyed,
    isCrashed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    __setDestroyed: (value: boolean) => {
      state.destroyed = value;
    },
  } as unknown as FakeWebContents;
}

function fakeWindow(wc: FakeWebContents, destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: wc };
}

const scopeA: ProjectExecutionScope = testProjectScope({
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/ws/a',
});
const scopeB: ProjectExecutionScope = testProjectScope({
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/ws/b',
});

const missionInput = {
  scope: scopeA,
  executionScope: scopeA,
  missionId: 'mission-1',
  workerIncarnationId: 'worker-incarnation-omp',
};

/** Owners with a bound scope, cleared after each test. */
const boundOwners: FakeWebContents[] = [];

function bindScope(wc: FakeWebContents, scope: ProjectExecutionScope): void {
  bindResolvedRendererWorkspaceScope(wc, scope);
  boundOwners.push(wc);
}

function ipcHandler(
  channel: string,
): (event: unknown, raw: unknown) => unknown {
  const call = h.ipcHandle.mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`handler não registrado: ${channel}`);
  return call[1] as (event: unknown, raw: unknown) => unknown;
}

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

afterEach(() => {
  disposeAllOmpRpcSessions();
  for (const owner of boundOwners.splice(0)) {
    clearRendererWorkspaceScope(owner);
  }
});

describe('R1 — roteamento de eventos ompRpc:event', () => {
  it('sessão panel envia SOMENTE ao renderer owner, mesmo havendo outras janelas do mesmo projeto', async () => {
    const owner = fakeWebContents(1);
    const sameProjectWindow = fakeWebContents(2);
    const foreignWindow = fakeWebContents(3);
    bindScope(owner, scopeA);
    bindScope(sameProjectWindow, scopeA);
    bindScope(foreignWindow, scopeB);
    h.getAllWindows.mockReturnValue([
      fakeWindow(owner),
      fakeWindow(sameProjectWindow),
      fakeWindow(foreignWindow),
    ]);

    registerOmpRpcIpc();
    const start = ipcHandler(OMP_RPC_CHANNELS.start);
    const result = (await start(
      { sender: owner },
      { approvalPolicy: 'safe' },
    )) as OmpRpcStartResult;
    expect(result.ok).toBe(true);

    const event = { kind: 'message_delta', delta: 'conteúdo da sessão' };
    emitPush(event);

    expect(owner.send).toHaveBeenCalledWith(OMP_RPC_CHANNELS.event, {
      sessionId: result.sessionId,
      event,
    });
    expect(sameProjectWindow.send).not.toHaveBeenCalled();
    expect(foreignWindow.send).not.toHaveBeenCalled();
  });

  it('sessão mission envia a TODAS as janelas do mesmo projeto e a nenhuma janela estranha', async () => {
    const windowA = fakeWebContents(11);
    const secondWindowA = fakeWebContents(12);
    const windowB = fakeWebContents(13);
    const scopelessWindow = fakeWebContents(14);
    bindScope(windowA, scopeA);
    bindScope(secondWindowA, scopeA);
    bindScope(windowB, scopeB);
    h.getAllWindows.mockReturnValue([
      fakeWindow(windowA),
      fakeWindow(secondWindowA),
      fakeWindow(windowB),
      fakeWindow(scopelessWindow),
    ]);

    const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);
    const event = { kind: 'message_delta', delta: 'conteúdo da missão' };
    emitPush(event);

    const envelope = { sessionId, event };
    expect(windowA.send).toHaveBeenCalledWith(OMP_RPC_CHANNELS.event, envelope);
    expect(secondWindowA.send).toHaveBeenCalledWith(
      OMP_RPC_CHANNELS.event,
      envelope,
    );
    expect(windowB.send).not.toHaveBeenCalled();
    expect(scopelessWindow.send).not.toHaveBeenCalled();
  });

  it('janela destruída ou em teardown não quebra o push das demais', async () => {
    const healthy = fakeWebContents(21);
    const destroyed = fakeWebContents(22, true);
    const tearingDown = fakeWebContents(23);
    tearingDown.send.mockImplementation(() => {
      throw new Error('Render frame was disposed');
    });
    bindScope(healthy, scopeA);
    bindScope(destroyed, scopeA);
    bindScope(tearingDown, scopeA);
    h.getAllWindows.mockReturnValue([
      fakeWindow(destroyed),
      fakeWindow(tearingDown),
      fakeWindow(healthy),
    ]);

    const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);
    const event = { kind: 'message_delta', delta: 'x' };
    expect(() => emitPush(event)).not.toThrow();
    expect(healthy.send).toHaveBeenCalledWith(OMP_RPC_CHANNELS.event, {
      sessionId,
      event,
    });
    expect(destroyed.send).not.toHaveBeenCalled();
  });

  it('owner destruído de sessão panel derruba o evento silenciosamente', async () => {
    const owner = fakeWebContents(31);
    bindScope(owner, scopeA);
    h.getAllWindows.mockReturnValue([fakeWindow(owner)]);

    registerOmpRpcIpc();
    const start = ipcHandler(OMP_RPC_CHANNELS.start);
    const result = (await start(
      { sender: owner },
      { approvalPolicy: 'safe' },
    )) as OmpRpcStartResult;
    expect(result.ok).toBe(true);

    owner.__setDestroyed(true);
    expect(() =>
      emitPush({ kind: 'message_delta', delta: 'x' }),
    ).not.toThrow();
    expect(owner.send).not.toHaveBeenCalled();
  });
});

describe('R4 — parseOmpModelRef fail-loud (via spawnMissionOmpRpcWorker)', () => {
  it('modelo provider/modelId válido chega parseado à sessão', async () => {
    await spawnMissionOmpRpcWorker({
      ...missionInput,
      model: 'openai/gpt-5.6-sol',
    });
    expect(lastSession().options.model).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
    });
  });

  it('modelo ausente ou vazio segue undefined (default do omp é escolha legítima)', async () => {
    await spawnMissionOmpRpcWorker({ ...missionInput });
    await spawnMissionOmpRpcWorker({ ...missionInput, model: '' });
    expect(h.FakeOmpRpcSession.instances.map((i) => i.options.model)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each([
    ['sem barra', 'gpt-5.6'],
    ['modelId vazio', 'openai/'],
    ['provider vazio', '/gpt-5'],
  ])('modelo malformado (%s) rejeita com mensagem clara', async (_label, model) => {
    await expect(
      spawnMissionOmpRpcWorker({ ...missionInput, model }),
    ).rejects.toThrow(/modelo omp malformado.*provider\/modelId/);
  });

  it('falha antes de mintar token, resolver binário ou spawnar (sem vazamento de gate)', async () => {
    const failure = await spawnMissionOmpRpcWorker({
      ...missionInput,
      model: 'gpt-5.6',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/provider\/modelId/);
    expect(isSafeOmpMissionPreflightFailure(failure)).toBe(true);
    expect(h.mintToken).not.toHaveBeenCalled();
    expect(h.resolveOmpBin).not.toHaveBeenCalled();
    expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
    expect(h.releaseSession).not.toHaveBeenCalled();
    expect(h.releaseSessionByToken).not.toHaveBeenCalled();
  });
});

describe('mission spawn transaction cleanup', () => {
  it('binds child cwd and MCP host tools to the task worktree, not the coordination checkout', async () => {
    const coordinationScope = {
      ...scopeA,
      rootRealPath: '/main',
    };
    const executionScope = {
      ...coordinationScope,
      rootRealPath: '/wt',
    };

    await spawnMissionOmpRpcWorker({
      ...missionInput,
      scope: coordinationScope,
      executionScope,
      allowedTools: ['nexus_file_write', 'nexus_git_status'],
    });

    expect(lastSession().options.workspaceRoot).toBe('/wt');
    expect(h.mintToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: coordinationScope,
        executionScope,
      }),
    );

    const dispatchHostTool = lastSession().callbacks.dispatchHostTool as
      | ((toolName: string, args: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    expect(dispatchHostTool).toBeTypeOf('function');
    h.dispatchToolCall.mockResolvedValueOnce({ ok: true, result: {} });
    await dispatchHostTool?.('nexus_file_write', {
      path: 'src/worker.ts',
      content: 'worktree only',
    });
    expect(h.dispatchToolCall).toHaveBeenLastCalledWith(
      'http-mcp',
      expect.anything(),
      'nexus_file_write',
      expect.objectContaining({ path: 'src/worker.ts' }),
      expect.objectContaining({
        scope: coordinationScope,
        executionScope,
      }),
    );
  });

  it.each([
    ['installationId', 'installation-foreign'],
    ['projectId', 'project-foreign'],
    ['checkoutId', 'checkout-foreign'],
  ] as const)(
    'rejects execution scope with foreign %s before bin/token/spawn',
    async (coordinate, foreignValue) => {
      const failure = await spawnMissionOmpRpcWorker({
        ...missionInput,
        executionScope: {
          ...scopeA,
          [coordinate]: foreignValue,
          rootRealPath: '/wt',
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /execution scope.*coordination scope/i,
      );
      expect(isSafeOmpMissionPreflightFailure(failure)).toBe(true);
      expect(h.resolveOmpBin).not.toHaveBeenCalled();
      expect(h.mintToken).not.toHaveBeenCalled();
      expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
    },
  );

  it('rejects non-normalized execution root before side effects', async () => {
    const failure = await spawnMissionOmpRpcWorker({
      ...missionInput,
      executionScope: {
        ...scopeA,
        rootRealPath: '/wt/../escape',
      },
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toMatch(/execution root.*absolute.*normal/i);
    expect(isSafeOmpMissionPreflightFailure(failure)).toBe(true);
    expect(h.resolveOmpBin).not.toHaveBeenCalled();
    expect(h.mintToken).not.toHaveBeenCalled();
  });

  it('disposes the process and releases the gate when readiness fails', async () => {
    h.waitForOmpSessionReady.mockRejectedValueOnce(new Error('omp boot timeout'));

    await expect(spawnMissionOmpRpcWorker(missionInput)).rejects.toThrow(
      'omp boot timeout',
    );

    expect(lastSession().disposed).toBe(true);
    expect(listOmpRpcSessions()).toEqual([]);
    expect(h.releaseSession).toHaveBeenCalledTimes(1);
  });

  it('usa uma identidade única para gate, dispatch, heartbeat e handoff', async () => {
    const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);

    expect(h.bindTokenToSession).toHaveBeenLastCalledWith('gate-token', sessionId);
    expect(h.mintToken).toHaveBeenLastCalledWith(expect.objectContaining({
      workerIncarnationId: missionInput.workerIncarnationId,
    }));
    expect(getExternalWorkerSessionInfo(sessionId)).toMatchObject({
      sessionId,
      missionId: missionInput.missionId,
      workerIncarnationId: missionInput.workerIncarnationId,
      role: 'worker',
      scope: scopeA,
    });

    emitPush({ kind: 'status', state: 'busy' });
    expect(h.publishSessionActivityState).toHaveBeenLastCalledWith(
      sessionId,
      'busy',
    );
    emitPush({ kind: 'exit', code: 1 });
    expect(h.publishExternalSessionExit).toHaveBeenCalledWith(sessionId);
    expect(getExternalWorkerSessionInfo(sessionId)).toBeNull();
  });

  it('disposes the process and releases the gate when the initial prompt fails', async () => {
    const prompt = vi
      .spyOn(h.FakeOmpRpcSession.prototype, 'promptAndWaitForAgentStart')
      .mockRejectedValueOnce(new Error('prompt rejected'));

    const failure = await spawnMissionOmpRpcWorker({
      ...missionInput,
      prompt: 'execute',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('prompt rejected');
    expect(isSafeOmpMissionPreflightFailure(failure)).toBe(false);

    expect(prompt).toHaveBeenCalledWith('execute');
    expect(lastSession().disposed).toBe(true);
    expect(listOmpRpcSessions()).toEqual([]);
    expect(h.releaseSession).toHaveBeenCalledTimes(1);
  });

  it('executa o bind durável antes de entregar o primeiro prompt', async () => {
    const onSessionReady = vi.fn();
    const onAccepted = vi.fn();
    const prompt = vi
      .spyOn(h.FakeOmpRpcSession.prototype, 'promptAndWaitForAgentStart')
      .mockImplementationOnce(async () => {
        expect(onSessionReady).toHaveBeenCalledOnce();
      });

    const result = await spawnMissionOmpRpcWorker({
      ...missionInput,
      prompt: 'execute',
      onSessionReady,
      onAccepted,
    });

    expect(onSessionReady).toHaveBeenCalledWith(result.paneId, result.sessionId);
    expect(prompt).toHaveBeenCalledWith('execute');
    expect(onAccepted).toHaveBeenCalledWith(result.paneId, result.sessionId);
    expect(onSessionReady.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0]!,
    );
    expect(prompt.mock.invocationCallOrder[0]).toBeLessThan(
      onAccepted.mock.invocationCallOrder[0]!,
    );
  });

  it('não persiste aceite se agent_start e exit disputam o mesmo tick', async () => {
    const onSessionReady = vi.fn();
    const onAccepted = vi.fn();
    vi.spyOn(
      h.FakeOmpRpcSession.prototype,
      'promptAndWaitForAgentStart',
    ).mockImplementationOnce(async function (
      this: InstanceType<typeof h.FakeOmpRpcSession>,
    ) {
      // Simula o serviço resolvendo o aceite do agent_start enquanto o
      // processo já publicou exit, antes de o await do spawn continuar.
      this.state = 'exited';
    });

    const failure = await spawnMissionOmpRpcWorker({
      ...missionInput,
      prompt: 'execute',
      onSessionReady,
      onAccepted,
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toMatch(/encerrou durante o aceite/);
    expect(isSafeOmpMissionPreflightFailure(failure)).toBe(false);
    expect(onSessionReady).toHaveBeenCalledOnce();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(lastSession().disposed).toBe(true);
    expect(listOmpRpcSessions()).toEqual([]);
    expect(h.releaseSession).toHaveBeenCalledTimes(1);
    expect(h.publishExternalSessionExit).toHaveBeenCalledTimes(1);
    expect(getExternalWorkerSessionInfo(lastSession().sessionId)).toBeNull();
  });

  it('falha no bind antes do prompt e encerra a sessão sem segundo efeito', async () => {
    const prompt = vi.spyOn(
      h.FakeOmpRpcSession.prototype,
      'promptAndWaitForAgentStart',
    );
    const failure = await spawnMissionOmpRpcWorker({
      ...missionInput,
      prompt: 'não deve sair',
      onSessionReady: () => {
        throw new Error('bind dispatch falhou');
      },
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe('bind dispatch falhou');
    expect(isSafeOmpMissionPreflightFailure(failure)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(lastSession().disposed).toBe(true);
  });

  it('falha no registro pós-aceite e encerra o worker já iniciado', async () => {
    const failure = await spawnMissionOmpRpcWorker({
      ...missionInput,
      prompt: 'execute',
      onAccepted: () => {
        throw new Error('registro de pane falhou');
      },
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe('registro de pane falhou');
    expect(isSafeOmpMissionPreflightFailure(failure)).toBe(false);
    expect(lastSession().disposed).toBe(true);
    expect(listOmpRpcSessions()).toEqual([]);
  });
});

describe('R1b — controle e listagem de sessões escopados por projeto', () => {
  it('renderer de projeto estranho NÃO controla sessão mission (prompt/abort negados)', async () => {
    registerOmpRpcIpc();
    const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);
    const session = lastSession();
    const promptSpy = vi.spyOn(session, 'prompt');

    const foreign = fakeWebContents(41);
    bindScope(foreign, scopeB);
    const prompt = ipcHandler(OMP_RPC_CHANNELS.prompt);
    const denied = (await prompt(
      { sender: foreign },
      { sessionId, message: 'rode algo' },
    )) as { ok: boolean; error?: string };

    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/fora do escopo deste projeto/);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      OMP_RPC_CHANNELS.prompt,
      { message: 'rode algo' },
      'prompt',
    ],
    [OMP_RPC_CHANNELS.abort, {}, 'abort'],
    [
      OMP_RPC_CHANNELS.setModel,
      { provider: 'openai', modelId: 'gpt-5' },
      'setModel',
    ],
    [
      OMP_RPC_CHANNELS.respondUi,
      { requestId: 'approval-1', response: { confirmed: true } },
      'respondUi',
    ],
    [OMP_RPC_CHANNELS.dispose, {}, 'dispose'],
  ] as const)(
    'renderer do MESMO projeto não pode mutar sessão mission via %s',
    async (channel, payload, method) => {
      registerOmpRpcIpc();
      const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);
      const session = lastSession();
      const methodSpy =
        method === 'dispose'
          ? vi.spyOn(session, 'dispose')
          : vi.spyOn(session, method);

      const sibling = fakeWebContents(42);
      bindScope(sibling, scopeA);
      const mutate = ipcHandler(channel);
      const denied = (await mutate(
        { sender: sibling },
        { sessionId, ...payload },
      )) as { ok: boolean; error?: string };

      expect(denied.ok).toBe(false);
      expect(denied.error).toMatch(/sessão de missão.*main/i);
      expect(methodSpy).not.toHaveBeenCalled();
    },
  );

  it('renderer do MESMO projeto pode observar estado e modelos da sessão mission', async () => {
    registerOmpRpcIpc();
    const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);

    const sibling = fakeWebContents(42);
    bindScope(sibling, scopeA);
    const getState = ipcHandler(OMP_RPC_CHANNELS.getState);
    const listModels = ipcHandler(OMP_RPC_CHANNELS.listModels);

    expect(getState({ sender: sibling }, { sessionId })).toMatchObject({
      ok: true,
      snapshot: { state: 'ready' },
    });
    await expect(
      listModels({ sender: sibling }, { sessionId }),
    ).resolves.toMatchObject({ ok: true, models: [] });
  });

  it('renderer sem escopo bound não controla sessão mission', async () => {
    registerOmpRpcIpc();
    const { sessionId } = await spawnMissionOmpRpcWorker(missionInput);

    const scopeless = fakeWebContents(43);
    const abort = ipcHandler(OMP_RPC_CHANNELS.abort);
    const denied = (await abort(
      { sender: scopeless },
      { sessionId },
    )) as { ok: boolean; error?: string };

    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/fora do escopo deste projeto/);
  });

  it('listSessions filtra: panel só para o owner, mission só para o mesmo projeto', async () => {
    const owner = fakeWebContents(44);
    bindScope(owner, scopeA);
    h.getAllWindows.mockReturnValue([fakeWindow(owner)]);

    registerOmpRpcIpc();
    const start = ipcHandler(OMP_RPC_CHANNELS.start);
    const panel = (await start(
      { sender: owner },
      { approvalPolicy: 'safe' },
    )) as OmpRpcStartResult;
    expect(panel.ok).toBe(true);
    const { sessionId: missionSessionId } = await spawnMissionOmpRpcWorker(
      missionInput,
    );

    const listSessions = ipcHandler(OMP_RPC_CHANNELS.listSessions);

    // Projeto estranho: não vê nada.
    const foreign = fakeWebContents(45);
    bindScope(foreign, scopeB);
    expect(listSessions({ sender: foreign }, null)).toEqual([]);

    // Mesmo projeto (não-owner): vê a mission, não a panel alheia.
    const sibling = fakeWebContents(46);
    bindScope(sibling, scopeA);
    const siblingRows = listSessions({ sender: sibling }, null) as {
      sessionId: string;
      kind: string;
    }[];
    expect(siblingRows.map((r) => r.sessionId)).toEqual([missionSessionId]);
    expect(siblingRows[0]?.kind).toBe('mission');

    // Owner: vê as duas.
    const ownerRows = listSessions({ sender: owner }, null) as {
      sessionId: string;
    }[];
    expect(ownerRows.map((r) => r.sessionId).sort()).toEqual(
      [panel.sessionId, missionSessionId].sort(),
    );
  });
});

describe('renderer start authority', () => {
  it.each([
    {
      approvalPolicy: 'safe',
      missionId: missionInput.missionId,
    },
    {
      approvalPolicy: 'yolo',
    },
    {
      approvalPolicy: 'yolo',
      missionId: missionInput.missionId,
    },
  ])(
    'rejeita missionId/yolo antes de mintar token ou spawnar: %j',
    async (payload) => {
      const owner = fakeWebContents(51);
      bindScope(owner, scopeA);
      registerOmpRpcIpc();

      const result = (await ipcHandler(OMP_RPC_CHANNELS.start)(
        { sender: owner },
        payload,
      )) as OmpRpcStartResult;

      expect(result).toEqual({ ok: false, error: 'payload inválido' });
      expect(h.mintToken).not.toHaveBeenCalled();
      expect(h.resolveOmpBin).not.toHaveBeenCalled();
      expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
    },
  );

  it('sessão de painel é safe, sem identidade de missão e com host tools read-only', async () => {
    const owner = fakeWebContents(52);
    bindScope(owner, scopeA);
    registerOmpRpcIpc();

    const result = (await ipcHandler(OMP_RPC_CHANNELS.start)(
      { sender: owner },
      { approvalPolicy: 'safe' },
    )) as OmpRpcStartResult;

    expect(result.ok).toBe(true);
    expect(lastSession().options.approvalPolicy).toBe('safe');
    expect(h.mintToken).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          'nexus_mission_get',
          'nexus_file_read',
          'nexus_git_diff',
        ]),
      }),
    );
    const gateInput = h.mintToken.mock.calls.at(-1)?.[0];
    expect(gateInput).not.toHaveProperty('missionId');
    const allowedTools = gateInput?.allowedTools as string[];
    expect(allowedTools).not.toEqual(
      expect.arrayContaining([
        'nexus_handoff_submit',
        'nexus_route_task',
        'nexus_file_write',
        'nexus_git_add',
        'nexus_git_commit',
      ]),
    );
  });

  it.each([
    [{ confirmed: true }],
    [{ value: 'Sim, executar' }],
  ])(
    'nega resposta afirmativa do renderer sem boundary nativa: %j',
    async (response) => {
      const owner = fakeWebContents(53);
      bindScope(owner, scopeA);
      registerOmpRpcIpc();
      const start = (await ipcHandler(OMP_RPC_CHANNELS.start)(
        { sender: owner },
        { approvalPolicy: 'safe' },
      )) as OmpRpcStartResult;
      const respondUi = ipcHandler(OMP_RPC_CHANNELS.respondUi);
      const responseSpy = vi.spyOn(lastSession(), 'respondUi');

      const result = (await respondUi(
        { sender: owner },
        {
          sessionId: start.sessionId,
          requestId: 'approval-1',
          response,
        },
      )) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/aprovação positiva.*main/i);
      expect(responseSpy).not.toHaveBeenCalled();
    },
  );

  it.each([[{ confirmed: false }], [{ cancelled: true }]])(
    'permite somente negação/cancelamento explícitos do painel: %j',
    async (response) => {
      const owner = fakeWebContents(54);
      bindScope(owner, scopeA);
      registerOmpRpcIpc();
      const start = (await ipcHandler(OMP_RPC_CHANNELS.start)(
        { sender: owner },
        { approvalPolicy: 'safe' },
      )) as OmpRpcStartResult;
      const responseSpy = vi.spyOn(lastSession(), 'respondUi');

      const result = (await ipcHandler(OMP_RPC_CHANNELS.respondUi)(
        { sender: owner },
        {
          sessionId: start.sessionId,
          requestId: 'approval-1',
          response,
        },
      )) as { ok: boolean; error?: string };

      expect(result.ok).toBe(true);
      expect(responseSpy).toHaveBeenCalledWith('approval-1', response);
    },
  );
});

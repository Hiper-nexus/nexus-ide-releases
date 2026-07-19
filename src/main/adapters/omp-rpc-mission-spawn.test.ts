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
  model?: { provider: string; modelId: string };
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

import {
  disposeAllOmpRpcSessions,
  registerOmpRpcIpc,
  spawnMissionOmpRpcWorker,
} from './omp-rpc-ipc';

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
  workspaceRoot: scopeA.rootRealPath,
  missionId: 'mission-1',
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
    await expect(
      spawnMissionOmpRpcWorker({ ...missionInput, model: 'gpt-5.6' }),
    ).rejects.toThrow(/provider\/modelId/);
    expect(h.mintToken).not.toHaveBeenCalled();
    expect(h.resolveOmpBin).not.toHaveBeenCalled();
    expect(h.FakeOmpRpcSession.instances).toHaveLength(0);
    expect(h.releaseSession).not.toHaveBeenCalled();
    expect(h.releaseSessionByToken).not.toHaveBeenCalled();
  });
});

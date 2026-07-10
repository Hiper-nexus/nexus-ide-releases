import { describe, expect, it, vi } from 'vitest';
import { DESIGN_WRITEBACK_CHANNELS } from '../../shared/channels';
import type { ProjectExecutionScope } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: any }, raw?: unknown) => unknown>(),
  scopes: new Map<number, ProjectExecutionScope>(),
  scopeListener: null as null | ((owner: any) => void),
  designListener: null as null | ((key: string, event: any, source?: any) => void),
  getPaneInfo: vi.fn(),
  getLastSelection: vi.fn(),
  assertTrustedPreview: vi.fn(),
  getMissionWorkflow: vi.fn(),
  assertMutationAllowed: vi.fn(),
  ensureAuditWritable: vi.fn(),
  auditIntent: vi.fn(),
  auditSuccess: vi.fn(),
  auditError: vi.fn(),
  auditDenied: vi.fn(),
  targetPath: vi.fn(() => 'src/App.tsx'),
  start: vi.fn(async () => ({ ok: true as const, files: 1, elements: 2 })),
  stop: vi.fn(async () => ({ ok: true as const })),
  status: vi.fn(() => ({
    enabled: true,
    active: false,
    styleMode: 'tailwind' as const,
    canUndo: false,
    canRedo: false,
  })),
  apply: vi.fn(async () => ({ ok: true as const, file: 'src/App.tsx', kind: 'text' })),
  undo: vi.fn(async () => null),
  redo: vi.fn(async () => null),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: any }, raw?: unknown) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireLiveRendererWorkspaceScope: (owner: any, expected?: ProjectExecutionScope) => {
    if (owner.isDestroyed() || owner.isCrashed()) throw new Error('renderer unavailable');
    const scope = mocks.scopes.get(owner.id);
    if (!scope) throw new Error('renderer has no authorized workspace scope');
    if (
      expected &&
      (scope.projectId !== expected.projectId ||
        scope.checkoutId !== expected.checkoutId ||
        scope.rootRealPath !== expected.rootRealPath)
    ) {
      throw new Error('renderer workspace authority changed');
    }
    return scope;
  },
  onRendererWorkspaceScopeChange: (listener: (owner: any) => void) => {
    mocks.scopeListener = listener;
    return () => {
      mocks.scopeListener = null;
    };
  },
}));

vi.mock('../browser/design-session', () => ({
  onDesignEvent: (listener: (key: string, event: any, source?: any) => void) => {
    mocks.designListener = listener;
    return () => {
      mocks.designListener = null;
    };
  },
  getLastSelection: mocks.getLastSelection,
}));

vi.mock('../browser/browser-manager', () => ({
  assertTrustedLocalDesignPreview: mocks.assertTrustedPreview,
  browserDesignSessionKey: (scope: ProjectExecutionScope, paneId: string) =>
    `${scope.projectId}\0${scope.checkoutId}\0${paneId}`,
}));

vi.mock('../orch/pane-registry', () => ({
  getPaneAuthzInfoOwnedByPane: mocks.getPaneInfo,
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    getMissionWorkflow: mocks.getMissionWorkflow,
    assertMutationAllowed: mocks.assertMutationAllowed,
  }),
}));

vi.mock('../jarvis/audit-log', () => ({
  ensureAuditLogWritable: mocks.ensureAuditWritable,
  auditIntent: mocks.auditIntent,
  auditSuccess: mocks.auditSuccess,
  auditError: mocks.auditError,
  auditDenied: mocks.auditDenied,
}));

vi.mock('./design-writeback-service', () => ({
  startDesignWriteback: mocks.start,
  stopDesignWriteback: mocks.stop,
  designWritebackStatus: mocks.status,
  applyDesignAction: mocks.apply,
  undoDesignAction: mocks.undo,
  redoDesignAction: mocks.redo,
  designActionTargetPath: mocks.targetPath,
}));

function scope(projectId: string, checkoutId: string, rootRealPath: string) {
  return Object.freeze({
    version: 1 as const,
    installationId: 'installation-a',
    projectId,
    checkoutId,
    rootRealPath,
    identitySource: 'manifest' as const,
  });
}

function owner(id: number) {
  return {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
  };
}

const missionBinding = Object.freeze({
  browserPaneId: 'pane-browser',
  paneId: 'pane-agent',
  missionId: 'mission-a',
});

function authorizeMission(renderer: ReturnType<typeof owner>, exactScope: ProjectExecutionScope) {
  mocks.getPaneInfo.mockReturnValue({
    paneId: missionBinding.paneId,
    sessionId: 'pty-agent',
    kind: 'cli-agent',
    missionId: missionBinding.missionId,
    contextRevision: 'context-revision-a',
    scope: exactScope,
    executionScope: exactScope,
  });
  mocks.getMissionWorkflow.mockReturnValue({
    contract: { contract: { contextRevision: 'context-revision-a' } },
    workflow: { stage: 'execution' },
  });
  mocks.getLastSelection.mockReturnValue({
    attributes: { 'data-nexus-id': 'child-a' },
  });
  mocks.scopes.set(renderer.id, exactScope);
}

async function freshModule(allowSourceMutation = true) {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.scopes.clear();
  mocks.scopeListener = null;
  mocks.designListener = null;
  vi.clearAllMocks();
  mocks.getPaneInfo.mockReturnValue(null);
  mocks.getMissionWorkflow.mockReturnValue({ contract: null, workflow: null });
  mocks.getLastSelection.mockReturnValue(null);
  const module = await import('./design-ipc');
  module.registerDesignWritebackIpc({ allowSourceMutation });
  return module;
}

function handler(channel: string) {
  const value = mocks.handlers.get(channel);
  if (!value) throw new Error(`missing handler ${channel}`);
  return value;
}

describe('design write-back IPC authority', () => {
  it('registers a zero-effect fail-closed surface for packaged releases', async () => {
    await freshModule(false);
    const renderer = owner(11);
    mocks.scopes.set(
      renderer.id,
      scope('project-a', 'checkout-a', '/projects/a'),
    );

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.status)({ sender: renderer }),
    ).resolves.toMatchObject({ enabled: false, active: false, authorityReady: false });
    for (const channel of [
      DESIGN_WRITEBACK_CHANNELS.start,
      DESIGN_WRITEBACK_CHANNELS.stop,
      DESIGN_WRITEBACK_CHANNELS.action,
      DESIGN_WRITEBACK_CHANNELS.undo,
      DESIGN_WRITEBACK_CHANNELS.redo,
    ]) {
      await expect(handler(channel)({ sender: renderer }, {})).rejects.toThrow(
        /design_writeback_disabled_in_release/,
      );
    }
    expect(mocks.designListener).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.ensureAuditWritable).not.toHaveBeenCalled();
    expect(mocks.getPaneInfo).not.toHaveBeenCalled();
  });

  it('isolates sessions by exact project scope and WebContents owner', async () => {
    await freshModule();
    const ownerA = owner(11);
    const ownerB = owner(22);
    const scopeA = scope('project-a', 'checkout-a', '/projects/a');
    const scopeB = scope('project-b', 'checkout-b', '/projects/b');
    authorizeMission(ownerA, scopeA);

    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: ownerA }, missionBinding);
    authorizeMission(ownerB, scopeB);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: ownerB }, missionBinding);

    expect(mocks.start).toHaveBeenCalledTimes(2);
    const startCalls = mocks.start.mock.calls as unknown as Array<[string, string]>;
    expect(startCalls[0][0]).toBe('/projects/a');
    expect(startCalls[1][0]).toBe('/projects/b');
    expect(startCalls[0][1]).not.toBe(startCalls[1][1]);

    authorizeMission(ownerA, scopeA);
    await handler(DESIGN_WRITEBACK_CHANNELS.action)(
      { sender: ownerA },
      { binding: missionBinding, action: { kind: 'text', nexusId: 'node-a', text: 'updated' } },
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      { kind: 'text', nexusId: 'node-a', text: 'updated' },
      startCalls[0][1],
    );
  });

  it('rejects a second window claiming the same project checkout', async () => {
    await freshModule();
    const ownerA = owner(11);
    const ownerB = owner(22);
    const shared = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(ownerA, shared);
    mocks.scopes.set(ownerB.id, shared);

    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: ownerA }, missionBinding);
    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: ownerB }, missionBinding),
    ).rejects.toThrow(/another project window/);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('fails closed on scope drift and schedules cleanup', async () => {
    await freshModule();
    const renderer = owner(11);
    const original = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, original);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    const key = (mocks.start.mock.calls as unknown as Array<[string, string]>)[0][1];

    mocks.scopes.set(
      renderer.id,
      scope('project-b', 'checkout-b', '/projects/b'),
    );
    mocks.scopeListener?.(renderer);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(key));

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.action)(
        { sender: renderer },
        { binding: missionBinding, action: { kind: 'delete', nexusId: 'node-a' } },
      ),
    ).rejects.toThrow(/does not own|not active/);
  });

  it('keeps failed cleanup ownership retryable and deletes it only after success', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    mocks.stop.mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.stop)({ sender: renderer }, missionBinding),
    ).rejects.toThrow(/cleanup failed/);
    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.stop)({ sender: renderer }, missionBinding),
    ).resolves.toEqual({ ok: true });
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed actions before invoking the filesystem service', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.action)(
        { sender: renderer },
        { binding: missionBinding, action: { kind: 'text', nexusId: '', text: 'x' } },
      ),
    ).rejects.toThrow(/invalid design action/);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('accepts trusted reorder only from the exact owner and full project scope', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    const session = (mocks.start.mock.calls as unknown as Array<[string, string]>)[0][1];
    const reorder = {
      type: 'reorder',
      reorder: {
        nexusId: 'child-a',
        parentNexusId: 'parent-a',
        fromIndex: 1,
        toIndex: 0,
      },
    };

    mocks.designListener?.('project-a\0checkout-a\0pane-browser', reorder, {
      owner: renderer,
      scope: exactScope,
    });

    await vi.waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(
        { kind: 'reorder', ...reorder.reorder },
        session,
      ),
    );
  });

  it('drops reorder from another window even when project and checkout match', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);

    mocks.designListener?.(
      'project-a\0checkout-a\0pane-from-another-window',
      {
        type: 'reorder',
        reorder: {
          nexusId: 'child-a',
          parentNexusId: 'parent-a',
          fromIndex: 1,
          toIndex: 0,
        },
      },
      { owner: owner(22), scope: exactScope },
    );

    await Promise.resolve();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('drops reorder when any project execution scope field differs', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    const reorder = {
      type: 'reorder',
      reorder: {
        nexusId: 'child-a',
        parentNexusId: 'parent-a',
        fromIndex: 1,
        toIndex: 0,
      },
    };
    const mismatches: ProjectExecutionScope[] = [
      { ...exactScope, installationId: 'installation-b' },
      { ...exactScope, rootRealPath: '/projects/other-root' },
      { ...exactScope, identitySource: 'provisional' },
    ];

    for (const mismatchedScope of mismatches) {
      mocks.designListener?.('project-a\0checkout-a\0pane-browser', reorder, {
        owner: renderer,
        scope: mismatchedScope,
      });
    }
    mocks.designListener?.('project-a\0checkout-a\0pane-browser', reorder);

    await Promise.resolve();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('requires a main-verified mission binding before instrumentation starts', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    mocks.scopes.set(renderer.id, exactScope);

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding),
    ).rejects.toThrow(/mission-bound|trusted mission/i);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.auditIntent).not.toHaveBeenCalled();
  });

  it('disables direct write-back for a mission executing in another worktree', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    mocks.getPaneInfo.mockReturnValue({
      paneId: missionBinding.paneId,
      sessionId: 'pty-agent',
      kind: 'cli-agent',
      missionId: missionBinding.missionId,
      contextRevision: 'context-revision-a',
      scope: exactScope,
      executionScope: { ...exactScope, rootRealPath: '/projects/a-worktree' },
    });

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding),
    ).rejects.toThrow(/another worktree/i);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('disables direct write-back for an unverified third-party browser pane', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    mocks.assertTrustedPreview.mockImplementationOnce(() => {
      throw new Error('direct write-back is available only for a local preview');
    });

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding),
    ).rejects.toThrow(/local preview/i);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('freezes the PREVC context revision from main and audits intent plus outcome', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);

    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    await handler(DESIGN_WRITEBACK_CHANNELS.action)(
      { sender: renderer },
      {
        binding: missionBinding,
        action: { kind: 'delete', nexusId: 'node-a' },
      },
    );

    expect(mocks.assertMutationAllowed).toHaveBeenCalledWith(
      'mission-a',
      'nexus_design_writeback_start',
      expect.objectContaining({ paneId: 'pane-agent' }),
    );
    expect(mocks.assertMutationAllowed).toHaveBeenCalledWith(
      'mission-a',
      'nexus_design_writeback_delete',
      expect.objectContaining({ path: 'src/App.tsx' }),
    );
    const auditContext = mocks.auditIntent.mock.calls.at(-1)?.[0];
    expect(auditContext).toMatchObject({
      scope: exactScope,
      missionId: 'mission-a',
      contextRevision: 'context-revision-a',
    });
    expect(mocks.auditSuccess).toHaveBeenCalled();
  });

  it('fails before an effect when audit persistence is unavailable', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    mocks.ensureAuditWritable.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding),
    ).rejects.toThrow(/audit_unavailable/i);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('rejects mission/context drift after start and records the denial', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    mocks.getMissionWorkflow.mockReturnValue({
      contract: { contract: { contextRevision: 'context-revision-b' } },
      workflow: { stage: 'execution' },
    });

    await expect(
      handler(DESIGN_WRITEBACK_CHANNELS.action)(
        { sender: renderer },
        { binding: missionBinding, action: { kind: 'delete', nexusId: 'node-a' } },
      ),
    ).rejects.toThrow(/stale context|context.*changed|drift/i);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.auditDenied).toHaveBeenCalled();
  });

  it('rejects reorder whose element no longer matches the main-side selection', async () => {
    await freshModule();
    const renderer = owner(11);
    const exactScope = scope('project-a', 'checkout-a', '/projects/a');
    authorizeMission(renderer, exactScope);
    await handler(DESIGN_WRITEBACK_CHANNELS.start)({ sender: renderer }, missionBinding);
    mocks.getLastSelection.mockReturnValue({
      attributes: { 'data-nexus-id': 'different-child' },
    });

    mocks.designListener?.(
      'project-a\0checkout-a\0pane-browser',
      {
        eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e70',
        type: 'reorder',
        reorder: {
          nexusId: 'child-a',
          parentNexusId: 'parent-a',
          fromIndex: 1,
          toIndex: 0,
        },
      },
      { owner: renderer, scope: exactScope },
    );

    await vi.waitFor(() => expect(mocks.auditDenied).toHaveBeenCalled());
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

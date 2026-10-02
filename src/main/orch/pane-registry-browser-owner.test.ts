import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { CallerCtx, PaneAuthzInfo } from './pane-authz';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AcpDriverSession } from '../acp/acp-harness-driver';
import type { MainOwnedPane } from './main-owned-pane-runtime';

const facts = vi.hoisted(() => ({
  sessions: new Map<string, { ownerId: number | null; live: boolean; scope: ProjectExecutionScope }>(),
  contexts: new Map<string, CallerCtx>(),
  rendererScopes: new Map<number, ProjectExecutionScope>(),
  headless: new Map<string, PaneAuthzInfo>(),
  acp: new Map<string, AcpDriverSession>(),
  owned: new Map<string, MainOwnedPane>(),
}));
vi.mock('../license-enforcement', () => ({ assertLicensedAgentCapacity: vi.fn() }));
vi.mock('./operator-spawn-route', () => ({ parentPaneIdFor: vi.fn() }));
vi.mock('../connectors/app-events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('../persistence/provider-session-store', () => ({ copyProviderPaneSession: vi.fn() }));
vi.mock('../adapters/mimo-session-owner', () => ({ currentMimoSessionOwnerKey: vi.fn() }));
vi.mock('../persistence/provider-config-store', () => ({ providerAuthStrategy: vi.fn(), resolveRuntimeApiKey: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({
  detachOwnedMissionAgentSession: vi.fn(), getAgentSessionInfo: (id: string) => facts.sessions.get(id),
  getSessionState: (id: string) => facts.sessions.get(id)?.live ? 'idle' : null,
  isSessionOwnedBy: (owner: WebContents, id: string) => facts.sessions.get(id)?.ownerId === owner.id,
  listAgentSessionsForPane: () => [], orchTerminateSession: vi.fn(async () => true),
  reattachDetachedMissionAgentSession: vi.fn(), tapSessionData: vi.fn(), tapSessionExit: vi.fn(), tapSessionState: vi.fn(),
}));
vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: (owner: WebContents) => facts.rendererScopes.get(owner.id),
  onRendererWorkspaceScopeChange: vi.fn(),
  requireLiveRendererWorkspaceScope: (owner: WebContents, expected?: ProjectExecutionScope) => {
    const scope = facts.rendererScopes.get(owner.id);
    if (owner.isDestroyed() || owner.isCrashed() || !scope || (expected && JSON.stringify(scope) !== JSON.stringify(expected))) {
      throw new Error('renderer scope changed');
    }
    return scope;
  },
}));
vi.mock('./gate', () => ({ getContextBySession: (id: string) => facts.contexts.get(id) }));
vi.mock('./main-owned-pane-runtime', () => ({
  deleteMainOwnedPane: vi.fn(), fallbackPendingSpawnToMain: vi.fn(),
  findMainOwnedPaneAuthz: (id: string) => facts.headless.has(id) ? [facts.headless.get(id)] : [],
  findMainOwnedPaneEntries: () => [],
  findMainOwnedRuntimeAuthority: (id: string) => facts.headless.has(id) ? [{ ...facts.headless.get(id), owner: null }] : [],
  getMainOwnedPane: (id: string) => facts.owned.get(id), hasMainOwnedPaneReference: vi.fn(), hasMainOwnedPaneSession: vi.fn(),
  listMainOwnedPaneSnapshots: () => [], mainOwnedPaneValues: () => [], listVisibleMainOwnedPaneSnapshots: () => [],
  retainClaimedPendingSpawn: vi.fn(), setMainOwnedPane: vi.fn(), spawnMainOwnedMissionPane: vi.fn(), spawnMainOwnedMissionPaneAsync: vi.fn(),
}));
vi.mock('./pane-session-output', () => ({
  paneSessionStateForEntry: () => 'idle', recordPaneSessionData: vi.fn(), recordPaneSessionExit: vi.fn(), recordPaneSessionState: vi.fn(),
  newOutputSince: vi.fn(), readSessionOutput: vi.fn(), sessionOutputExitedAt: vi.fn(), stripAnsi: vi.fn(), waitForIdle: vi.fn(), waitForNextIdle: vi.fn(),
}));
vi.mock('./dev-server-registry', () => ({ createDevServerScanner: () => ({ get: vi.fn() }) }));
vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: vi.fn() }));
vi.mock('./squad-store', () => ({ listSquads: () => [] }));
vi.mock('./mission-pane-authority', () => ({ resolveMissionPaneAuthoritySeal: vi.fn(), sameMissionPaneAuthoritySeal: vi.fn() }));
vi.mock('./mission-pane-store', () => ({ isAutomatedReviewerCompositionPane: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../acp/acp-harness-driver', () => ({ getAcpDriverSession: (id: string) => facts.acp.get(id) ?? null }));
vi.mock('./agent-identity-spawn', () => ({ issueAgentIdentityBestEffort: vi.fn() }));
vi.mock('./worker-mortality', () => ({ shouldTripWorkerMortalityBreaker: vi.fn(), workerMortalityBreakerMessage: vi.fn(), workerMortalityCount: vi.fn() }));
vi.mock('./writer-circuit-break', () => ({ writerCircuitBlocksSeat: vi.fn(), writerCircuitBreakEvent: vi.fn(), writerCircuitBreakMessage: vi.fn(), writerCircuitBreakers: vi.fn() }));
vi.mock('../observability/main-trace', () => ({ trace: vi.fn() }));

const scope: ProjectExecutionScope = { version: 1, installationId: 'installation', projectId: 'project',
  checkoutId: 'checkout', rootRealPath: '/workspace', identitySource: 'manifest' };
function owner(id: number): WebContents {
  facts.rendererScopes.set(id, scope);
  return { id, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() } as unknown as WebContents;
}
type Registry = typeof import('./pane-registry');
let registry: Registry;
function renderSession(wc: WebContents, id: string, role: CallerCtx['role'] = 'worker', missionId = 'mission'): CallerCtx {
  const caller = { sessionId: id, role, missionId, scope };
  facts.sessions.set(id, { ownerId: wc.id, live: true, scope });
  facts.contexts.set(id, caller);
  registry.syncPanes([{ paneId: `pane-${id}`, sessionId: id, kind: 'cli-agent', title: id }], wc);
  registry.attachOrchMeta(wc, `pane-${id}`, { missionId, role: role === 'user' ? undefined : role, scope });
  return caller;
}
function headlessWorker(): CallerCtx {
  const caller: CallerCtx = { sessionId: 'headless', role: 'worker', missionId: 'mission', scope };
  facts.sessions.set('headless', { ownerId: null, live: true, scope });
  facts.headless.set('headless', { paneId: 'pane-headless', sessionId: 'headless', kind: 'cli-agent', role: 'worker', missionId: 'mission', scope });
  return caller;
}
async function finishOpen(pending: ReturnType<Registry['requestBrowserPane']>, wc: WebContents): Promise<void> {
  const request = vi.mocked(wc.send).mock.calls.at(-1)![1] as { requestId: string; paneId: string };
  registry.resolveBrowserOpen({ requestId: request.requestId, paneId: request.paneId, ok: true }, wc);
  await expect(pending).resolves.toMatchObject({ ok: true, paneId: request.paneId });
}

beforeEach(async () => {
  vi.resetModules();
  for (const map of [facts.sessions, facts.contexts, facts.rendererScopes, facts.headless, facts.acp, facts.owned]) map.clear();
  registry = await import('./pane-registry');
});

describe('Main-derived browser originating owner', () => {
  it('uses the caller session owner even when another same-workspace window registered last', async () => {
    const original = owner(1), latest = owner(2);
    const caller = renderSession(original, 'worker');
    registry.registerOrchRenderer(latest);
    expect(registry.callerWithPaneOwner({ ...caller, ownerWebContentsId: 2 }).ownerWebContentsId).toBe(1);
    const pending = registry.requestBrowserPane({ url: 'about:blank', scope, role: 'worker', caller });
    expect(latest.send).not.toHaveBeenCalled();
    await finishOpen(pending, original);
  });

  it('denies a missing, exited, reassigned or foreign-scope caller session', () => {
    const wc = owner(1), caller = renderSession(wc, 'worker');
    expect(registry.callerWithPaneOwner({ ...caller, sessionId: 'unknown', ownerWebContentsId: 1 }).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('worker')!.live = false;
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('worker')!.live = true;
    facts.sessions.get('worker')!.ownerId = 2;
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('worker')!.ownerId = 1;
    expect(registry.callerWithPaneOwner({ ...caller, scope: { ...scope, rootRealPath: '/other' } }).ownerWebContentsId).toBeUndefined();
  });

  it('lists only browser tabs owned by the originating window, including existing user tabs', () => {
    const original = owner(1), foreign = owner(2);
    const caller = renderSession(original, 'worker');
    registry.syncPanes([
      { paneId: 'pane-worker', sessionId: 'worker', kind: 'cli-agent', title: 'worker' },
      { paneId: 'browser-own', sessionId: null, kind: 'browser', title: 'own' },
      { paneId: 'shell-own', sessionId: null, kind: 'shell', title: 'shell' },
    ], original);
    registry.syncPanes([{ paneId: 'browser-foreign', sessionId: null, kind: 'browser', title: 'foreign' }], foreign);
    const ids = registry.listVisiblePaneSnapshots({ ...caller, ownerWebContentsId: 2 }).map((pane) => pane.paneId);
    expect(ids).toContain('browser-own');
    expect(ids).not.toContain('browser-foreign');
    expect(ids).not.toContain('shell-own');
    expect(registry.getPaneAuthzInfo('browser-own')?.ownerWebContentsId).toBe(1);
  });

  it('routes a proven headless worker only through its unique live mission orchestrator', async () => {
    const leaderOwner = owner(1), latest = owner(2);
    renderSession(leaderOwner, 'leader', 'orchestrator');
    registry.registerOrchRenderer(latest);
    const caller = headlessWorker();
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBe(1);
    expect(registry.callerWithPaneOwner({ ...caller, workerIncarnationId: 'stale-generation' }).ownerWebContentsId).toBeUndefined();
    const pending = registry.requestBrowserPane({ url: 'about:blank', scope, role: 'worker', caller });
    expect(latest.send).not.toHaveBeenCalled();
    await finishOpen(pending, leaderOwner);
    facts.sessions.get('leader')!.live = false;
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
  });

  it('fails closed without a unique mission owner instead of selecting the latest renderer', async () => {
    const first = owner(1), second = owner(2), caller = headlessWorker();
    registry.registerOrchRenderer(second);
    await expect(registry.requestBrowserPane({ url: 'about:blank', scope, role: 'worker', caller })).resolves.toMatchObject({ ok: false });
    renderSession(first, 'leader-one', 'orchestrator');
    renderSession(second, 'leader-two', 'orchestrator');
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
    await expect(registry.requestBrowserPane({ url: 'about:blank', scope, role: 'worker', caller })).resolves.toMatchObject({ ok: false });
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
  });

  it('supports a live ACP worker and rejects disposed or substituted ACP identity', async () => {
    const wc = owner(1);
    renderSession(wc, 'leader', 'orchestrator');
    const caller = { ...headlessWorker(), workerIncarnationId: 'generation-one' };
    // ACP owns a driver session rather than a PTY; getSessionState is null.
    facts.sessions.delete('headless');
    const authority = { ...facts.headless.get('headless')!, workerIncarnationId: 'generation-one' };
    facts.headless.set('headless', authority);
    facts.owned.set('pane-headless', { entry: { paneId: 'pane-headless', sessionId: 'headless',
      kind: 'cli-agent', title: 'ACP worker', adapterId: 'acp-provider', accountId: 'approved-account' },
      meta: { missionId: 'mission', role: 'worker', scope, workerIncarnationId: 'generation-one' } });
    const acp = { sessionId: 'headless', paneId: 'pane-headless', missionId: 'mission', role: 'worker', scope,
      agent: { sessionId: 'headless', paneId: 'pane-headless', missionId: 'mission', role: 'worker', scope,
        adapterId: 'acp-provider', accountId: 'approved-account', workerIncarnationId: 'generation-one' } } as AcpDriverSession;
    facts.acp.set('headless', acp);
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBe(1);
    await finishOpen(registry.requestBrowserPane({ url: 'about:blank', scope, role: 'worker', caller }), wc);
    const executionScope = { ...scope, checkoutId: 'worker-checkout', rootRealPath: '/worktrees/worker' };
    const boundCaller = { ...caller, executionScope };
    facts.headless.set('headless', { ...authority, executionScope });
    facts.owned.get('pane-headless')!.meta.executionScope = executionScope;
    // The pinned ACP driver retains coordination scope while its CWD uses
    // the Main-selected execution worktree; both bindings must remain exact.
    expect(registry.callerWithPaneOwner(boundCaller).ownerWebContentsId).toBe(1);
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
    for (const replacement of [
      { ...acp, agent: { ...acp.agent, accountId: 'other-account' } },
      { ...acp, agent: { ...acp.agent, workerIncarnationId: 'generation-two' } },
      { ...acp, agent: { ...acp.agent, paneId: 'other-pane' } },
      { ...acp, scope: { ...scope, rootRealPath: '/other' } },
    ]) {
      facts.acp.set('headless', replacement);
      expect(registry.callerWithPaneOwner(boundCaller).ownerWebContentsId).toBeUndefined();
    }
    facts.acp.delete('headless');
    expect(registry.callerWithPaneOwner(boundCaller).ownerWebContentsId).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { CallerCtx, PaneAuthzInfo } from './pane-authz';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AcpDriverSession } from '../acp/acp-harness-driver';
import type { MainOwnedPane } from './main-owned-pane-runtime';
import type { AgentGateContext } from './gate';

const facts = vi.hoisted(() => ({
  sessions: new Map<string, { ownerId: number | null; live: boolean; scope: ProjectExecutionScope;
    sessionId?: string; paneId?: string; missionId?: string; role?: CallerCtx['role']; adapterId?: string;
    accountId?: string; source?: 'direct-user' | 'orchestrator' | 'pending'; workerIncarnationId?: string;
    authoritySeal?: typeof seal; operatorOpened?: true; promotedFromUser?: true }>(),
  releasePhysical: true,
  contexts: new Map<string, CallerCtx & { promotedFromUserSession?: true }>(),
  rendererScopes: new Map<number, ProjectExecutionScope>(),
  headless: new Map<string, PaneAuthzInfo>(),
  acp: new Map<string, AcpDriverSession>(),
  owned: new Map<string, MainOwnedPane>(),
  specs: new Map<string, MainOwnedPane>(),
  scopeChange: undefined as undefined | ((owner: { id: number }, previous: ProjectExecutionScope | null, next: ProjectExecutionScope | null) => void),
}));
const seal = vi.hoisted(() => ({ intentVersion: 1, intentContractHash: 'intent', contextRevision: 'revision',
  contractHash: 'contract', squadRevisionHash: 'squad' }));
vi.mock('../license-enforcement', () => ({ assertLicensedAgentCapacity: vi.fn() }));
vi.mock('./operator-spawn-route', () => ({ parentPaneIdFor: vi.fn() }));
vi.mock('../connectors/app-events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('../persistence/provider-session-store', () => ({ copyProviderPaneSession: vi.fn() }));
vi.mock('../adapters/mimo-session-owner', () => ({ currentMimoSessionOwnerKey: vi.fn() }));
vi.mock('../persistence/provider-config-store', () => ({ providerAuthStrategy: vi.fn(), resolveRuntimeApiKey: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({
  detachOwnedMissionAgentSession: vi.fn((owner: WebContents, id: string) => {
    const session = facts.sessions.get(id);
    if (!session?.live || session.ownerId !== owner.id) return false;
    session.ownerId = null;
    return true;
  }), getAgentSessionInfo: (id: string) => facts.sessions.get(id),
  getSessionState: (id: string) => facts.sessions.get(id)?.live ? 'idle' : null,
  isOneShotSessionRunning: () => false,
  isSessionOwnedBy: (owner: WebContents, id: string) => facts.sessions.get(id)?.ownerId === owner.id,
  isSessionDetached: (id: string) => facts.sessions.get(id)?.live === true && facts.sessions.get(id)?.ownerId === null,
  listAgentSessions: () => [...facts.sessions.values()],
  releaseOperatorOpenedAgentSession: vi.fn((id: string, missionId: string) => {
    const session = facts.sessions.get(id);
    if (!facts.releasePhysical || !session?.operatorOpened || session.missionId !== missionId) return false;
    const { missionId: _mission, workerIncarnationId: _worker, authoritySeal: _seal, operatorOpened: _opened, ...rest } = session;
    facts.sessions.set(id, { ...rest, role: 'user' });
    return true;
  }),
  adoptUserAgentSessionAsMissionOrchestrator: (id: string, missionId: string) => {
    const session = facts.sessions.get(id);
    if (!session || session.role !== 'user' || session.missionId) return false;
    Object.assign(session, { role: 'orchestrator', missionId, promotedFromUser: true }); return true;
  },
  returnAdoptedAgentSessionToUser: (id: string, missionId: string) => {
    const session = facts.sessions.get(id);
    if (!session?.promotedFromUser || session.missionId !== missionId) return false;
    const { missionId: _mission, promotedFromUser: _promoted, workerIncarnationId: _worker, ...rest } = session;
    facts.sessions.set(id, { ...rest, role: 'user' }); return true;
  },
  listAgentSessionsForPane: () => [], orchTerminateSession: vi.fn(async () => true),
  reattachDetachedMissionAgentSession: vi.fn(), tapSessionData: vi.fn(), tapSessionExit: vi.fn(), tapSessionState: vi.fn(),
}));
vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: (owner: WebContents) => facts.rendererScopes.get(owner.id),
  onRendererWorkspaceScopeChange: (callback: typeof facts.scopeChange) => { facts.scopeChange = callback; },
  requireLiveRendererWorkspaceScope: (owner: WebContents, expected?: ProjectExecutionScope) => {
    const scope = facts.rendererScopes.get(owner.id);
    if (owner.isDestroyed() || owner.isCrashed() || !scope || (expected && JSON.stringify(scope) !== JSON.stringify(expected))) {
      throw new Error('renderer scope changed');
    }
    return scope;
  },
}));
vi.mock('./gate', async (importOriginal) => ({ ...await importOriginal<typeof import('./gate')>(),
  getContextBySession: (id: string) => facts.contexts.get(id) }));
vi.mock('./mission-lifecycle-lock', () => ({ withMissionLifecycleLock: vi.fn() }));
vi.mock('./mission-event-emit', () => ({ emitMissionEvent: vi.fn() }));
vi.mock('./mission-orchestrator-exit-policy', () => ({ sanitizeMissionOrchestratorExitOutput: vi.fn() }));
vi.mock('./main-owned-pane-runtime', () => ({
  deleteMainOwnedPane: (id: string) => facts.owned.delete(id), fallbackPendingSpawnToMain: vi.fn(),
  findMainOwnedPaneAuthz: (id: string) => facts.headless.has(id) ? [facts.headless.get(id)] : [],
  findMainOwnedPaneEntries: (id: string) => [...facts.owned.values()].filter(pane => pane.entry.paneId === id || pane.entry.sessionId === id).map(pane => pane.entry),
  findMainOwnedRuntimeAuthority: (id: string) => facts.headless.has(id) ? [{ ...facts.headless.get(id), owner: null }] :
    [...facts.owned.values()].filter(pane => pane.entry.sessionId === id).map(pane => ({ ...pane.entry, ...pane.meta, owner: null })),
  getMainOwnedPane: (id: string) => facts.owned.get(id), hasMainOwnedPaneReference: vi.fn(), hasMainOwnedPaneSession: vi.fn(),
  listMainOwnedPaneSnapshots: () => [...facts.owned.values()].map(pane => ({ ...pane.entry, ...pane.meta })), mainOwnedPaneValues: () => [...facts.owned.values()], listVisibleMainOwnedPaneSnapshots: () => [],
  retainClaimedPendingSpawn: vi.fn(), setMainOwnedPane: (id: string, pane: MainOwnedPane) => facts.owned.set(id, pane), spawnMainOwnedMissionPane: vi.fn(), spawnMainOwnedMissionPaneAsync: vi.fn(),
}));
vi.mock('./pane-session-output', () => ({
  paneSessionStateForEntry: () => 'idle', recordPaneSessionData: vi.fn(), recordPaneSessionExit: vi.fn(), recordPaneSessionState: vi.fn(),
  newOutputSince: vi.fn(), readSessionOutput: vi.fn(), sessionOutputExitedAt: vi.fn(), stripAnsi: vi.fn(), waitForIdle: vi.fn(), waitForNextIdle: vi.fn(),
}));
vi.mock('./dev-server-registry', () => ({ createDevServerScanner: () => ({ get: vi.fn() }) }));
vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: () => ({
  missions: { get: (id: string) => ({ id }) },
  missionPanes: { findByPaneId: (id: string) => {
    const pane = facts.specs.get(id);
    return pane ? { ...pane.entry, ...pane.meta } : null;
  } },
}) }));
vi.mock('./squad-store', () => ({ listSquads: () => [] }));
vi.mock('./mission-pane-authority', () => ({ resolveMissionPaneAuthoritySeal: () => seal,
  sameMissionPaneAuthoritySeal: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }));
vi.mock('./mission-pane-store', () => ({ isAutomatedReviewerCompositionPane: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../acp/acp-harness-driver', () => ({ getAcpDriverSession: (id: string) => facts.acp.get(id) ?? null,
  listAcpDriverAgentSessions: () => [...facts.acp.values()].map(session => session.agent) }));
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
  facts.sessions.set(id, { ownerId: wc.id, live: true, scope, sessionId: id, paneId: `pane-${id}`,
    missionId, role, adapterId: 'provider', accountId: 'account', source: 'direct-user' });
  facts.contexts.set(id, caller);
  registry.syncPanes([{ paneId: `pane-${id}`, sessionId: id, kind: 'cli-agent', title: id,
    adapterId: 'provider', accountId: 'account' }], wc);
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
  for (const map of [facts.sessions, facts.contexts, facts.rendererScopes, facts.headless, facts.acp, facts.owned, facts.specs]) map.clear();
  facts.scopeChange = undefined;
  facts.releasePhysical = true;
  registry = await import('./pane-registry');
});

describe('Main-derived browser originating owner', () => {
  it.each([
    { source: 'direct-user' as const, physicalReturned: false },
    { source: 'direct-user' as const, physicalReturned: true },
    { source: 'pending' as const, physicalReturned: false },
    { source: 'pending' as const, physicalReturned: true },
  ])('keeps a parked operator-opened browser after real runtime release ($source, physical metadata returned=$physicalReturned)', async ({ source, physicalReturned }) => {
    const wc = owner(1), latest = owner(2);
    const previousCaller = renderSession(wc, 'opened', 'worker');
    const gate = await import('./gate');
    gate.releaseSession('opened');
    const context = gate.mintToken({ label: 'opened', role: 'worker', missionId: 'mission',
      scope, workerIncarnationId: 'opened-generation', allowedTools: [], allowedSkills: [] });
    gate.bindTokenToSession(context.token, 'opened');
    facts.contexts.set('opened', context);
    Object.assign(facts.sessions.get('opened')!, { source, operatorOpened: true,
      workerIncarnationId: 'opened-generation', authoritySeal: seal });
    registry.attachOrchMeta(wc, 'pane-opened', { missionId: 'mission', role: 'worker', scope,
      operatorOpened: true, workerIncarnationId: 'opened-generation', authoritySeal: seal });
    registry.syncPanes([
      { paneId: 'pane-opened', sessionId: 'opened', kind: 'cli-agent', title: 'opened',
        adapterId: 'provider', accountId: 'account' },
      { paneId: 'parked-opened-browser', sessionId: null, kind: 'browser', title: 'old project' },
    ], wc);
    const nextScope = { ...scope, projectId: 'another-project', rootRealPath: '/another' };
    facts.rendererScopes.set(wc.id, nextScope);
    facts.scopeChange!(wc, scope, nextScope);
    registry.syncPanes([], wc);
    registry.registerOrchRenderer(latest);
    if (source === 'pending') {
      // Real workspace retention follows the production pending-spawn source,
      // transfers the pane to Main, and detaches the physical PTY boundary.
      const pty = await import('../pty/pty-manager');
      expect(pty.detachOwnedMissionAgentSession).toHaveBeenCalledWith(wc, 'opened');
      expect(facts.sessions.get('opened')!.ownerId).toBeNull();
      expect(facts.owned.get('pane-opened')).toMatchObject({
        entry: { sessionId: 'opened', adapterId: 'provider', accountId: 'account' },
        meta: { missionId: 'mission', role: 'worker', workerIncarnationId: 'opened-generation', operatorOpened: true },
      });
    }
    facts.releasePhysical = physicalReturned;
    // Use the real runtime teardown and gate token store; only physical PTY
    // inventory/lifetime and renderer effects are controlled boundaries here.
    const runtime = await import('./mission-runtime-termination');
    const suite = { missions: { get: () => ({ id: 'mission', status: 'done' }) },
      missionPanes: { list: () => [] } };
    await expect(runtime.terminateMissionRuntime({ scope, missionId: 'mission', suite: suite as never,
      reason: 'operator-close' })).resolves.toMatchObject({ ok: true, terminatedSessionIds: ['opened'] });
    expect(context.role).toBe('user');
    expect(facts.sessions.get('opened')!.role).toBe(physicalReturned ? 'user' : 'worker');
    expect(context.missionId).toBeUndefined();
    expect(context.allowedTools).toBeNull();
    expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBe(wc.id);
    expect(registry.listVisiblePaneSnapshots(context).map(pane => pane.paneId)).toContain('parked-opened-browser');
    if (source === 'pending') {
      expect(facts.owned.get('pane-opened')!.meta.missionId).toBeUndefined();
      expect(facts.owned.get('pane-opened')!.meta.role).toBeUndefined();
      expect(facts.owned.get('pane-opened')!.meta.workerIncarnationId).toBeUndefined();
      const retained = facts.owned.get('pane-opened')!;
      for (const invalid of [
        { ...retained, entry: { ...retained.entry, accountId: 'another-account' } },
        { ...retained, entry: { ...retained.entry, adapterId: 'another-provider' } },
        { ...retained, meta: { ...retained.meta, missionId: 'another-mission' } },
        { ...retained, meta: { ...retained.meta, workerIncarnationId: 'another-generation' } },
        { ...retained, meta: { ...retained.meta, scope: { ...scope, installationId: 'foreign-installation' } } },
        { ...retained, meta: { ...retained.meta, executionScope: { ...scope, rootRealPath: '/foreign-checkout' } } },
      ]) {
        facts.owned.set('pane-opened', invalid);
        expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
      }
      facts.owned.set('pane-opened', retained);
      facts.owned.set('duplicate', { ...retained, entry: { ...retained.entry, paneId: 'duplicate' } });
      expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
      facts.owned.delete('duplicate');
      facts.owned.delete('pane-opened');
      expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
      facts.owned.set('pane-opened', retained);
    }
    expect(registry.callerWithPaneOwner(previousCaller).ownerWebContentsId).toBeUndefined();
    for (const invalid of [
      { ...context, scope: { ...scope, installationId: 'foreign-installation' } },
      { ...context, executionScope: { ...scope, rootRealPath: '/foreign-checkout' } },
      { ...context, workerIncarnationId: 'another-generation' },
      { ...context, missionId: 'another-mission' },
    ]) {
      facts.contexts.set('opened', invalid);
      expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
    }
    facts.contexts.set('opened', context);
    facts.sessions.get('opened')!.ownerId = latest.id;
    expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('opened')!.ownerId = source === 'pending' ? null : wc.id;
    facts.sessions.get('opened')!.accountId = 'another-account';
    expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
    gate.releaseSession('opened');
  });

  it.each([false, true])('keeps a parked operator browser after Main returns the hand (physical metadata returned=%s)', async (physicalReturned) => {
    const wc = owner(1), latest = owner(2);
    const promoted = renderSession(wc, 'operator', 'orchestrator');
    const context: AgentGateContext = { ...promoted, token: 'test-token', label: 'operator',
      allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
      promotedFromUserSession: true };
    facts.contexts.set('operator', context);
    registry.attachOrchMeta(wc, 'pane-operator', { missionId: 'mission', role: 'orchestrator', scope });
    registry.syncPanes([
      { paneId: 'pane-operator', sessionId: 'operator', kind: 'cli-agent', title: 'operator' },
      { paneId: 'parked-operator-browser', sessionId: null, kind: 'browser', title: 'old project' },
    ], wc);
    const nextScope = { ...scope, projectId: 'another-project', rootRealPath: '/another' };
    facts.rendererScopes.set(wc.id, nextScope);
    facts.scopeChange!(wc, scope, nextScope);
    registry.syncPanes([], wc);
    registry.registerOrchRenderer(latest);
    const gate = await vi.importActual<typeof import('./gate')>('./gate');
    expect(gate.returnOperatorHandFromEndedMission(context)).toBe(true);
    if (physicalReturned) Object.assign(facts.sessions.get('operator')!, { role: 'user', missionId: undefined });
    expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBe(wc.id);
    expect(registry.listVisiblePaneSnapshots(context).map(pane => pane.paneId)).toContain('parked-operator-browser');
    expect(registry.callerWithPaneOwner(promoted).ownerWebContentsId).toBeUndefined();
    expect(registry.callerWithPaneOwner(headlessWorker()).ownerWebContentsId).toBeUndefined();
    for (const invalid of [
      { ...context, scope: { ...scope, installationId: 'foreign-installation' } },
      { ...context, executionScope: { ...scope, rootRealPath: '/foreign-checkout' } },
      { ...context, workerIncarnationId: 'another-generation' },
      { ...context, missionId: 'another-mission' },
    ]) {
      facts.contexts.set('operator', invalid);
      expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
    }
    facts.contexts.set('operator', context);
    facts.sessions.get('operator')!.ownerId = latest.id;
    expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('operator')!.ownerId = wc.id;
    facts.sessions.get('operator')!.accountId = 'another-account';
    expect(registry.callerWithPaneOwner(context).ownerWebContentsId).toBeUndefined();
  });

  it('retains the Main-presented ACP coordinator owner when the renderer snapshot has no session or role', () => {
    const original = owner(1), latest = owner(2);
    const pane: MainOwnedPane = { entry: { paneId: 'pane-acp-leader', sessionId: 'acp-leader', kind: 'cli-agent',
      title: 'ACP coordinator', adapterId: 'acp-provider', accountId: 'approved-account' },
      meta: { missionId: 'mission', role: 'orchestrator', scope, authoritySeal: seal } };
    facts.owned.set(pane.entry.paneId, pane);
    facts.specs.set(pane.entry.paneId, pane);
    const acp = { sessionId: 'acp-leader', paneId: pane.entry.paneId, missionId: 'mission', role: 'orchestrator', scope,
      agent: { sessionId: 'acp-leader', paneId: pane.entry.paneId, missionId: 'mission', role: 'orchestrator', scope,
        adapterId: 'acp-provider', accountId: 'approved-account', authoritySeal: seal } } as AcpDriverSession;
    facts.acp.set('acp-leader', acp);
    // This is the actual ACP renderer shape: its terminal host has no PTY,
    // and the snapshot omits the Main-owned mission role.
    const snapshot = [{ paneId: pane.entry.paneId, sessionId: null, kind: 'cli-agent' as const, title: 'ACP coordinator' }];
    registry.syncPanes(snapshot, original);
    expect(original.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId: 'acp-leader', transport: 'acp' }));
    registry.syncPanes([], latest);
    const coordinator: CallerCtx = { sessionId: 'acp-leader', missionId: 'mission', role: 'orchestrator', scope };
    expect(registry.callerWithPaneOwner(coordinator).ownerWebContentsId).toBe(1);
    expect(registry.callerWithPaneOwner(headlessWorker()).ownerWebContentsId).toBe(1);
    for (const replacement of [
      { ...acp, agent: { ...acp.agent, accountId: 'substituted-account' } },
      { ...acp, agent: { ...acp.agent, adapterId: 'substituted-provider' } },
      { ...acp, agent: { ...acp.agent, paneId: 'substituted-pane' } },
      { ...acp, agent: { ...acp.agent, workerIncarnationId: 'substituted-generation' } },
      { ...acp, scope: { ...scope, rootRealPath: '/another' } },
    ]) {
      facts.acp.set('acp-leader', replacement);
      expect(registry.callerWithPaneOwner(coordinator).ownerWebContentsId).toBeUndefined();
      expect(registry.callerWithPaneOwner(headlessWorker()).ownerWebContentsId).toBeUndefined();
    }
    facts.acp.set('acp-leader', acp);
    registry.unregisterOrchRenderer(original);
    expect(registry.callerWithPaneOwner(coordinator).ownerWebContentsId).toBeUndefined();
    facts.acp.delete('acp-leader');
    expect(registry.callerWithPaneOwner(coordinator).ownerWebContentsId).toBeUndefined();
  });

  it('keeps the exact direct-user owner after workspace parking and the following empty pane sync', () => {
    const original = owner(1), latest = owner(2);
    // A direct operator pane adopted by a mission keeps the operator's reach.
    const caller: CallerCtx = { ...renderSession(original, 'direct', 'orchestrator'), promotedFromUserSession: true };
    registry.syncPanes([
      { paneId: 'pane-direct', sessionId: 'direct', kind: 'cli-agent', title: 'direct' },
      { paneId: 'parked-browser', sessionId: null, kind: 'browser', title: 'old project' },
    ], original);
    const nextScope = { ...scope, projectId: 'another-project', checkoutId: 'another-checkout', rootRealPath: '/another' };
    facts.rendererScopes.set(original.id, nextScope);
    facts.scopeChange!(original, scope, nextScope);
    registry.syncPanes([], original);
    registry.registerOrchRenderer(latest);
    expect(facts.sessions.get('direct')!.ownerId).toBe(1);
    expect(registry.callerWithPaneOwner({ ...caller, ownerWebContentsId: 2 }).ownerWebContentsId).toBe(1);
    expect(registry.listVisiblePaneSnapshots(caller).map(pane => pane.paneId)).toContain('parked-browser');
    for (const substitutedScope of [
      { ...scope, version: 2 } as unknown as ProjectExecutionScope, { ...scope, installationId: 'other-installation' },
      { ...scope, projectId: 'other-project' }, { ...scope, checkoutId: 'other-checkout' },
      { ...scope, rootRealPath: '/other' }, { ...scope, identitySource: 'provisional' as const },
    ]) expect(registry.callerWithPaneOwner({ ...caller, scope: substitutedScope }).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('direct')!.ownerId = 2;
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
  });

  it('keeps the mission owner after Main retains its detached coordinator during workspace parking', () => {
    const original = owner(1), latest = owner(2);
    const caller = renderSession(original, 'leader', 'orchestrator');
    Object.assign(facts.sessions.get('leader')!, { source: 'orchestrator', authoritySeal: seal });
    registry.attachOrchMeta(original, 'pane-leader', { missionId: 'mission', role: 'orchestrator', scope, authoritySeal: seal });
    const nextScope = { ...scope, projectId: 'another-project', rootRealPath: '/another' };
    facts.rendererScopes.set(original.id, nextScope);
    facts.scopeChange!(original, scope, nextScope);
    registry.syncPanes([], original);
    registry.registerOrchRenderer(latest);
    expect(facts.sessions.get('leader')!.ownerId).toBeNull();
    expect(facts.owned.get('pane-leader')?.entry.sessionId).toBe('leader');
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBe(1);
    expect(registry.callerWithPaneOwner(headlessWorker()).ownerWebContentsId).toBe(1);
    // Adoption can precede this renderer's first pane sync. A stale Main-owned
    // record must not retain the old origin after physical ownership changes.
    facts.sessions.get('leader')!.ownerId = 999;
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
    expect(registry.callerWithPaneOwner(headlessWorker()).ownerWebContentsId).toBeUndefined();
    facts.sessions.get('leader')!.ownerId = null;
    facts.sessions.get('leader')!.live = false;
    expect(registry.callerWithPaneOwner(caller).ownerWebContentsId).toBeUndefined();
    expect(registry.callerWithPaneOwner(headlessWorker()).ownerWebContentsId).toBeUndefined();
  });

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

  it("lists only the caller's mission browser tabs owned by the originating window, never the operator's", () => {
    const original = owner(1), foreign = owner(2);
    const caller = renderSession(original, 'worker');
    registry.syncPanes([
      { paneId: 'pane-worker', sessionId: 'worker', kind: 'cli-agent', title: 'worker' },
      { paneId: 'browser-own', sessionId: null, kind: 'browser', title: 'own' },
      { paneId: 'browser-operator', sessionId: null, kind: 'browser', title: 'operator' },
      { paneId: 'shell-own', sessionId: null, kind: 'shell', title: 'shell' },
    ], original);
    registry.attachOrchMeta(original, 'browser-own', { missionId: 'mission', role: 'worker', scope });
    registry.syncPanes([{ paneId: 'browser-foreign', sessionId: null, kind: 'browser', title: 'foreign' }], foreign);
    registry.attachOrchMeta(foreign, 'browser-foreign', { missionId: 'mission', role: 'worker', scope });
    const ids = registry.listVisiblePaneSnapshots({ ...caller, ownerWebContentsId: 2 }).map((pane) => pane.paneId);
    expect(ids).toContain('browser-own');
    expect(ids).not.toContain('browser-operator');
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


describe('F-1143 — operator MCP adoption metadata publication', () => {
  function adoption() {
    const wc = owner(41);
    const context = { sessionId: 'creator', role: 'orchestrator', missionId: 'created', scope,
      promotedFromUserSession: true, readOnly: true, allowedTools: ['nexus_pane_read'], allowedSkills: ['review'] } as AgentGateContext;
    facts.contexts.set('creator', context);
    facts.sessions.set('creator', { ownerId: wc.id, live: true, sessionId: 'creator', paneId: 'pane-creator',
      adapterId: 'provider', source: 'direct-user', scope, role: 'orchestrator', missionId: 'created' });
    registry.syncPanes([{ paneId: 'pane-creator', sessionId: 'creator', kind: 'cli-agent', title: 'Creator', adapterId: 'provider' }], wc);
    const origin = registry.captureOperatorPaneAdoptionOrigin('creator')!;
    return { wc, context, origin };
  }

  async function releasedMainOwned(mirror = false) {
    const gate = await import('./gate');
    const pty = await import('../pty/pty-manager');
    gate.releaseSession('headless-creator');
    const context = gate.mintToken({ label: 'operator-opened', role: 'worker', missionId: 'old', scope, allowedTools: [], allowedSkills: [] });
    gate.bindTokenToSession(context.token, 'headless-creator');
    facts.contexts.set('headless-creator', context);
    facts.sessions.set('headless-creator', { ownerId: null, live: true, sessionId: 'headless-creator', paneId: 'headless-pane',
      adapterId: 'provider', source: 'pending', scope, role: 'worker', missionId: 'old', operatorOpened: true });
    facts.owned.set('headless-pane', { entry: { paneId: 'headless-pane', sessionId: 'headless-creator', kind: 'cli-agent', title: 'Operator hand', adapterId: 'provider' },
      meta: { missionId: 'old', role: 'worker', operatorOpened: true, scope, executionScope: scope, allowedTools: [], allowedSkills: [] } });
    expect(gate.returnOperatorOpenedSessionToUser('headless-creator', 'old')).toBe(true);
    expect(pty.releaseOperatorOpenedAgentSession('headless-creator', 'old')).toBe(true);
    registry.detachOperatorOpenedPaneMission('headless-pane', 'old');
    expect(registry.getOwnedPaneAuthzInfoBySession('headless-creator')).toBeNull();
    if (mirror) {
      const retained = facts.owned.get('headless-pane')!;
      const wc = owner(52);
      facts.sessions.get('headless-creator')!.ownerId = wc.id;
      registry.syncPanes([{ paneId: 'headless-pane', sessionId: 'headless-creator', kind: 'cli-agent', title: 'Operator hand', adapterId: 'provider' }], wc);
      // F-927: a Main runtime publication can overlap its existing mirror.
      // Seed the exact retained record through the Main producer boundary.
      const runtime = await import('./main-owned-pane-runtime');
      runtime.setMainOwnedPane('headless-pane', retained);
      expect(registry.findPane('headless-creator')).toBeNull();
    }
    const origin = registry.captureOperatorPaneAdoptionOrigin('headless-creator')!;
    expect(origin.authority).toMatchObject({ owner: null, paneId: 'headless-pane' });
    expect(gate.adoptUserContextAsMissionOrchestrator(context, 'created')).toBe(true);
    expect(pty.adoptUserAgentSessionAsMissionOrchestrator('headless-creator', 'created')).toBe(true);
    return { context, origin };
  }

  it.each([false, true])('publishes the released Main-owned hand (presentation mirror=%s)', async mirror => {
    const { context, origin } = await releasedMainOwned(mirror);
    expect(registry.publishAdoptedOperatorMissionPane(origin, context, 'created')).toBe(true);
    expect(registry.getPaneRuntimeAuthorityBySession('headless-creator')).toMatchObject({ owner: null, role: 'orchestrator', missionId: 'created' });
    const published = registry.listPaneSnapshots().filter(pane => pane.missionId === 'created');
    expect(published).toHaveLength(mirror ? 2 : 1);
    expect(new Set(published.map(pane => `${pane.paneId}:${pane.sessionId}`)).size).toBe(1);
    for (const pane of published) expect(pane).toMatchObject({
      paneId: 'headless-pane', sessionId: 'headless-creator', role: 'orchestrator', allowedTools: null, allowedSkills: null,
    });
    if (mirror) {
      registry.syncPanes([{ ...origin.entry }], origin.physicalOwner!);
      expect(registry.getPaneRuntimeAuthorityBySession('headless-creator')).toMatchObject({
        owner: origin.physicalOwner, paneId: 'headless-pane', sessionId: 'headless-creator', missionId: 'created', role: 'orchestrator', scope, executionScope: scope,
      });
      expect(registry.listPaneSnapshots().filter(pane => pane.missionId === 'created')).toMatchObject([{
        paneId: 'headless-pane', sessionId: 'headless-creator', role: 'orchestrator', scope, executionScope: scope,
      }]);
    }
  });

  it.each(['metadata', 'replacement-session'] as const)('refuses changed presentation %s without overwriting it', async changed => {
    const { context, origin } = await releasedMainOwned(true);
    const owner = origin.physicalOwner!;
    if (changed === 'metadata') registry.attachOrchMeta(owner, 'headless-pane', { missionId: 'newer', role: 'worker', scope });
    else {
      facts.sessions.set('replacement', { ownerId: owner.id, live: true, scope, sessionId: 'replacement', paneId: 'headless-pane', role: 'user' });
      registry.syncPanes([{ paneId: 'headless-pane', sessionId: 'replacement', kind: 'cli-agent', adapterId: 'provider', title: 'Replacement' }], owner);
    }
    const retained = facts.owned.get('headless-pane');
    expect(registry.publishAdoptedOperatorMissionPane(origin, context, 'created')).toBe(false);
    expect(facts.owned.get('headless-pane')).toBe(retained);
    const presentation = registry.listPaneSnapshots().find(pane => changed === 'metadata' ? pane.missionId === 'newer' : pane.sessionId === 'replacement');
    expect(presentation).toBeDefined();
    expect(presentation?.missionId).not.toBe('created');
  });

  it('retains manual ownership through a later mission teardown', async () => {
    const { context, origin } = await releasedMainOwned();
    expect(registry.publishAdoptedOperatorMissionPane(origin, context, 'created')).toBe(true);
    expect.soft(registry.getPaneRuntimeAuthorityBySession('headless-creator')?.operatorOpened).toBe(true);
    const pty = await import('../pty/pty-manager');
    vi.mocked(pty.orchTerminateSession).mockClear();
    const runtime = await import('./mission-runtime-termination');
    const suite = { missions: { get: () => ({ id: 'created', status: 'done' }) }, missionPanes: { list: () => [] } };
    await expect(runtime.terminateMissionRuntime({ scope, missionId: 'created', suite: suite as never, reason: 'operator-close' })).resolves.toMatchObject({ ok: true });
    expect(pty.orchTerminateSession).not.toHaveBeenCalled();
    expect(context.role).toBe('user');
    expect(facts.sessions.get('headless-creator')?.live).toBe(true);
    expect(facts.sessions.get('headless-creator')?.role).toBe('user');
    expect(facts.sessions.get('headless-creator')?.missionId).toBeUndefined();
    expect(facts.owned.get('headless-pane')?.meta.missionId).toBeUndefined();
  });

  it.each(['record-replaced', 'session-replaced', 'owner-claimed', 'foreign-shadow', 'scope-drift'] as const)(
    'refuses changed Main-owned %s without altering the record', async kind => {
      const { context, origin } = await releasedMainOwned();
      if (kind === 'record-replaced') facts.owned.set('headless-pane', { ...origin.mainOwned! });
      if (kind === 'session-replaced') facts.owned.set('headless-pane', { ...origin.mainOwned!, entry: { ...origin.entry, sessionId: 'replacement' } });
      if (kind === 'owner-claimed') facts.sessions.get('headless-creator')!.ownerId = 99;
      if (kind === 'scope-drift') facts.sessions.get('headless-creator')!.scope = { ...scope, checkoutId: 'foreign' };
      if (kind === 'foreign-shadow') facts.headless.set('headless-creator', { paneId: 'foreign-pane', sessionId: 'headless-creator', kind: 'cli-agent', scope });
      const unchanged = facts.owned.get('headless-pane');
      expect(registry.publishAdoptedOperatorMissionPane(origin, context, 'created')).toBe(false);
      expect(facts.owned.get('headless-pane')).toBe(unchanged);
      expect(facts.owned.get('headless-pane')!.meta.missionId).toBeUndefined();
    });

  it('publishes the exact adopted creator and preserves capabilities through normal sync', () => {
    const { wc, context, origin } = adoption();
    registry.publishAdoptedOperatorMissionPane(origin, context, 'created');
    expect(registry.getPaneRuntimeAuthorityBySession('creator')).toMatchObject({ missionId: 'created', role: 'orchestrator', owner: wc });
    expect(registry.listPaneSnapshots()[0]).toMatchObject({ readOnly: true, allowedTools: ['nexus_pane_read'], allowedSkills: ['review'] });
    registry.syncPanes([{ paneId: 'pane-creator', sessionId: 'creator', kind: 'cli-agent', title: 'Creator', adapterId: 'provider' }], wc);
    expect(registry.getPaneRuntimeAuthorityBySession('creator')).toMatchObject({ missionId: 'created', role: 'orchestrator', owner: wc });
  });

  it('refuses metadata changed after the captured origin', () => {
    const { wc, context, origin } = adoption();
    registry.attachOrchMeta(wc, 'pane-creator', { missionId: 'newer', role: 'worker', scope });
    expect(registry.publishAdoptedOperatorMissionPane(origin, context, 'created')).toBe(false);
    expect(registry.listPaneSnapshots()[0]).toMatchObject({ missionId: 'newer', role: 'worker' });
  });

  it.each([false, true])('publication failure compensates only its own metadata (newer=%s)', newer => {
    const { wc, context, origin } = adoption();
    let checks = 0;
    wc.isDestroyed = () => {
      if (++checks === 2) {
        if (newer) registry.attachOrchMeta(wc, 'pane-creator', { missionId: 'newer', role: 'worker', scope });
        throw new Error('origin publication failed');
      }
      return false;
    };
    expect(() => registry.publishAdoptedOperatorMissionPane(origin, context, 'created')).toThrow('origin publication failed');
    const snapshot = registry.listPaneSnapshots()[0]!;
    expect(snapshot.missionId).toBe(newer ? 'newer' : undefined);
    expect(snapshot.role).toBe(newer ? 'worker' : undefined);
  });

  it.each(['missing', 'foreign-owner', 'replaced-session', 'physical-pane', 'coordination-scope', 'execution-scope', 'stale-gate', 'dead-owner', 'filesystem-identity'] as const)(
    'refuses %s without overwriting existing metadata', kind => {
      const { wc, context, origin } = adoption();
      if (kind === 'missing') facts.sessions.delete('creator');
      if (kind === 'foreign-owner') facts.sessions.get('creator')!.ownerId = 42;
      if (kind === 'replaced-session') { facts.sessions.set('replacement', { ownerId: wc.id, live: true, sessionId: 'replacement', paneId: 'pane-creator', scope, role: 'user' }); registry.syncPanes([{ paneId: 'pane-creator', sessionId: 'replacement', kind: 'cli-agent', title: 'Replacement' }], wc); }
      if (kind === 'physical-pane') facts.sessions.get('creator')!.paneId = 'foreign-pane';
      if (kind === 'coordination-scope') facts.rendererScopes.set(wc.id, { ...scope, rootRealPath: '/foreign' });
      if (kind === 'execution-scope') facts.sessions.get('creator')!.scope = { ...scope, checkoutId: 'foreign' };
      if (kind === 'stale-gate') facts.contexts.set('creator', { ...context });
      if (kind === 'dead-owner') wc.isDestroyed = () => true;
      if (kind === 'filesystem-identity') facts.sessions.get('creator')!.scope = { ...scope, workspaceRootDevice: 'foreign', workspaceRootInode: 'foreign' };
      registry.publishAdoptedOperatorMissionPane(origin, context, 'created');
      const snapshot = registry.listPaneSnapshots().find(pane => pane.paneId === 'pane-creator')!;
      expect(snapshot.missionId).toBeUndefined();
      expect(snapshot.role).toBeUndefined();
    });
});

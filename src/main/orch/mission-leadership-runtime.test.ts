import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { PaneSessionState } from '../../shared/types';
import { synthesizeImmediateDispatchContract } from '../../shared/mission-intent';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { bindResolvedRendererWorkspaceScope, clearRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { testProjectScope } from './__tests__/scope-fixture';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry, getProjectDomainStores } from './project-domain-store-registry';
import * as gate from './gate';
import { MissionLeadership } from './mission-leadership';
import { createMissionLeadershipPorts, getMissionLeadership, MISSION_LEADERSHIP_CHANGED_CHANNEL } from './mission-leadership-runtime';

const physical = vi.hoisted(() => ({
  sessions: new Map<string, OwnedAgentSessionInfo>(),
  states: new Map<string, PaneSessionState>(),
  renderers: [] as WebContents[],
  fastLane: vi.fn((): ReturnType<typeof import('./mission-fast-lane').fastLaneOrchestratorPaneSummary> => null),
  manager: null as ProjectRuntimeManager | null,
}));
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => physical.renderers } }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => physical.sessions.get(id) ?? null,
  getSessionState: (id: string) => physical.states.get(id) ?? null,
  listAgentSessions: () => [...physical.sessions.values()],
  registeredOrchestratorSessionsForMission: (missionId: string) => [...physical.sessions.values()]
    .filter((s) => s.missionId === missionId && s.role === 'orchestrator')
    .map((s) => ({ sessionId: s.sessionId, state: physical.states.get(s.sessionId), adapterId: s.adapterId })),
}));
vi.mock('./mission-fast-lane', () => ({ fastLaneOrchestratorPaneSummary: physical.fastLane }));
vi.mock('./mission-event-emit', () => ({ getMissionEventRuntimeManager: () => physical.manager }));

const scope = testProjectScope();
let baseDir: string;
let missionId: string;
const renderer = {
  id: 811, send: vi.fn(), isDestroyed: () => false, isCrashed: () => false,
} as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
const foreignRenderer = { ...renderer, id: 812, send: vi.fn() } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };

function stores() { return getProjectDomainStores(scope); }
function addSession(id: string, state: PaneSessionState = 'idle', role: 'worker' | 'orchestrator' = 'worker') {
  const info: OwnedAgentSessionInfo = {
    sessionId: id, paneId: `pane-${id}`, adapterId: 'codex', role,
    scope, missionId, cwd: scope.rootRealPath, source: 'persisted-pane',
    allowedTools: ['pane_read'], allowedSkills: ['review'], readOnly: true,
    ...(role === 'worker' ? { workerIncarnationId: `incarnation-${id}` } : {}),
  };
  physical.sessions.set(id, info);
  physical.states.set(id, state);
  const ctx = gate.mintToken({
    label: id, scope, missionId, role, readOnly: true,
    allowedTools: ['pane_read'], allowedSkills: ['review'],
    workerIncarnationId: info.workerIncarnationId,
  });
  gate.bindTokenToSession(ctx.token, id);
  return ctx;
}
function apply(sessionId: string, origin: 'spawn' | 'promote' | 'adopt' = 'spawn') {
  return getMissionLeadership().applyLeadership(scope, missionId, { sessionId, paneId: `pane-${sessionId}`, origin });
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-leadership-runtime-'));
  physical.manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureProjectDomainStoreRegistry(physical.manager);
  const mission = stores().missions.create({
    title: 'Runtime leadership', intentVersion: 1, intentState: 'executing',
    intentContract: synthesizeImmediateDispatchContract({ title: 'Runtime leadership', now: 100 }),
  });
  missionId = mission.id;
  stores().missions.setStatus(missionId, 'running');
  physical.renderers = [renderer, foreignRenderer];
  bindResolvedRendererWorkspaceScope(renderer, scope);
  bindResolvedRendererWorkspaceScope(foreignRenderer, { ...scope, checkoutId: 'elsewhere' });
});
afterEach(() => {
  vi.restoreAllMocks();
  physical.fastLane.mockReset();
  physical.sessions.clear();
  physical.states.clear();
  renderer.send.mockClear();
  foreignRenderer.send.mockClear();
  clearRendererWorkspaceScope(renderer);
  clearRendererWorkspaceScope(foreignRenderer);
  gate.resetGateForTests();
  disposeProjectDomainStoreRegistry();
  physical.manager?.closeAll();
  physical.manager = null;
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('real mission leadership runtime ports', () => {
  it('uses one lazy Main singleton and commits spawn to real A+C+D before sending F', () => {
    expect(getMissionLeadership()).toBe(getMissionLeadership());
    const ctx = addSession('new');
    renderer.send.mockImplementation(() => {
      expect(physical.manager!.open(scope).db.inTransaction).toBe(false);
      expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('new');
      expect(stores().missionPanes.findByPaneId('pane-new')?.role).toBe('orchestrator');
      expect(ctx.role).toBe('orchestrator');
    });
    expect(apply('new').rendererNotified).toBe(true);
    expect(ctx.readOnly).toBe(true);
    expect(ctx.workerIncarnationId).toBeUndefined();
    expect(renderer.send).toHaveBeenCalledExactlyOnceWith(MISSION_LEADERSHIP_CHANGED_CHANNEL,
      expect.objectContaining({ type: 'mission-leadership-changed', missionId, sessionId: 'new', paneId: 'pane-new', origin: 'spawn' }));
    expect(foreignRenderer.send).not.toHaveBeenCalled();
    expect(getMissionLeadership().resolveMissionLeader(scope, missionId)).toMatchObject({ sessionId: 'new', proven: true });
  });

  it('promotes over exited authority, revokes every previous gate and re-emits', () => {
    const previous = addSession('old');
    apply('old');
    physical.states.set('old', 'exited');
    const next = addSession('new');
    const states = [...physical.states];
    const rebind = vi.spyOn(stores().missions, 'rebindOrchestratorSession');
    apply('new', 'promote');
    expect(rebind).toHaveBeenCalledWith(missionId, 'new');
    expect(previous).toMatchObject({ role: 'worker', allowedTools: [], handoffSubmitted: false });
    expect(next).toMatchObject({ role: 'orchestrator', allowedTools: null, readOnly: true });
    expect(stores().missionPanes.list(missionId).filter((p) => p.role === 'orchestrator').map((p) => p.paneId)).toEqual(['pane-new']);
    expect([...physical.states]).toEqual(states);
    expect(renderer.send).toHaveBeenCalledTimes(2);
    expect(() => getMissionLeadership().assertSingleLeader(scope, missionId)).not.toThrow();
  });

  it('detects A ≠ C without a renderer or gate claim', () => {
    addSession('a');
    addSession('c');
    stores().missions.setOrchestratorSession(missionId, 'a');
    stores().missionPanes.record({ missionId, paneId: 'pane-c', adapterId: 'codex', role: 'orchestrator' });
    expect(() => getMissionLeadership().assertSingleLeader(scope, missionId)).toThrow('leadership_split_brain');
  });

  it('rolls back A and the newly recorded C when C promotion fails', () => {
    addSession('new');
    const before = stores().missions.get(missionId);
    vi.spyOn(stores().missionPanes, 'promotePaneToOrchestrator').mockImplementation(() => { throw new Error('C failed'); });
    expect(() => apply('new')).toThrow('C failed');
    expect(stores().missions.get(missionId)).toEqual(before);
    expect(stores().missionPanes.list(missionId)).toEqual([]);
    expect(gate.getContextBySession('new')?.role).toBe('worker');
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it('restores exactly the gate fields changed by promotion after a partial D failure', () => {
    const old = addSession('old');
    apply('old');
    physical.states.set('old', 'exited');
    const next = addSession('new');
    old.handoffSubmitted = true;
    const before = [structuredClone(old), structuredClone(next)];
    const missionBefore = stores().missions.get(missionId);
    const panesBefore = stores().missionPanes.list(missionId);
    const promote = gate.promoteMissionSessionAuthority;
    vi.spyOn(gate, 'promoteMissionSessionAuthority').mockImplementation((input) => {
      promote(input);
      throw new Error('D failed');
    });
    expect(() => apply('new', 'promote')).toThrow('D failed');
    expect([old, next]).toEqual(before);
    expect(stores().missions.get(missionId)).toEqual(missionBefore);
    expect(stores().missionPanes.list(missionId)).toEqual(panesBefore);
    expect(renderer.send).toHaveBeenCalledTimes(1);
  });

  it('never includes gate tokens in claims, events or rollback snapshots', () => {
    const ctx = addSession('new');
    const ports = createMissionLeadershipPorts(scope);
    const snapshot = ports.captureRuntime(missionId, { sessionId: 'new', paneId: 'pane-new' });
    apply('new');
    const data = JSON.stringify([ports.readClaims(missionId), snapshot, renderer.send.mock.calls]);
    expect(data).not.toContain(ctx.token);
    expect(data).not.toContain('"token"');
  });

  it('rejects a foreign scope or unapproved mission before writing', () => {
    const ctx = addSession('new');
    ctx.scope = { ...scope, checkoutId: 'foreign' };
    expect(() => apply('new')).toThrow('leadership_runtime_scope_mismatch');
    ctx.scope = scope;
    stores().missions.setStatus(missionId, 'blocked');
    expect(() => apply('new')).toThrow('leadership_dispatch_unavailable');
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it('keeps missing or exited physical authority unproven', () => {
    addSession('old', 'exited', 'orchestrator');
    stores().missions.setOrchestratorSession(missionId, 'old');
    expect(getMissionLeadership().resolveMissionLeader(scope, missionId)?.proven).toBe(false);
    physical.sessions.delete('old');
    physical.states.delete('old');
    expect(getMissionLeadership().resolveMissionLeader(scope, missionId)?.proven).toBe(false);
  });

  it('uses real transaction ports with an isolated engine too', () => {
    addSession('new');
    const engine = new MissionLeadership({ forScope: createMissionLeadershipPorts });
    engine.applyLeadership(scope, missionId, { sessionId: 'new', paneId: 'pane-new', origin: 'adopt' });
    expect(() => engine.assertSingleLeader(scope, missionId)).not.toThrow();
  });

  it('detects B disagreement and rolls back instead of silently bypassing the cache', () => {
    addSession('old', 'exited');
    const next = addSession('new');
    physical.fastLane.mockReturnValue({
      paneId: 'pane-old', sessionId: 'old', role: 'orchestrator',
      title: 'Old', agentName: 'Old', adapterId: 'codex', cwd: scope.rootRealPath,
    });
    const ports = createMissionLeadershipPorts(scope);
    expect(ports.readClaims(missionId)).toContainEqual({ source: 'fast-lane', paneId: 'pane-old', sessionId: 'old' });
    expect(() => apply('new', 'promote')).toThrow('leadership_split_brain');
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    expect(stores().missionPanes.list(missionId)).toEqual([]);
    expect(next.role).toBe('worker');
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it('ignores another checkout returned by the unscoped B accessor', () => {
    addSession('old', 'idle', 'orchestrator');
    const old = physical.sessions.get('old')!;
    physical.sessions.set('old', { ...old, scope: { ...scope, checkoutId: 'foreign' } });
    gate.getContextBySession('old')!.scope = { ...scope, checkoutId: 'foreign' };
    physical.fastLane.mockReturnValue({
      paneId: 'pane-old', sessionId: 'old', role: 'orchestrator',
      title: 'Old', agentName: 'Old', adapterId: 'codex', cwd: '/foreign',
    });
    addSession('new');
    expect(apply('new').leader.sessionId).toBe('new');
  });

  it('does not steal a persisted pane from another mission and rolls A back', () => {
    addSession('new');
    const other = stores().missions.create({ title: 'Other mission' });
    const spec = stores().missionPanes.record({ missionId: other.id, paneId: 'pane-new', adapterId: 'codex' });
    expect(() => apply('new')).toThrow('leadership_runtime_pane_mismatch');
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    expect(stores().missionPanes.findByPaneId('pane-new')).toEqual(spec);
  });

  it('uses rebind even with an empty A so old handoff transport is not bypassed', () => {
    addSession('new');
    const rebind = vi.spyOn(stores().missions, 'rebindOrchestratorSession');
    const simpleSet = vi.spyOn(stores().missions, 'setOrchestratorSession');
    apply('new');
    expect(rebind).toHaveBeenCalledExactlyOnceWith(missionId, 'new');
    expect(simpleSet).not.toHaveBeenCalled();
  });

  it('restores absent missionId on an adopted gate when its promotion fails', () => {
    const ctx = addSession('new');
    delete ctx.missionId;
    const info = physical.sessions.get('new')!;
    physical.sessions.set('new', { ...info, missionId: undefined });
    const before = structuredClone(ctx);
    const promote = gate.promoteMissionSessionAuthority;
    vi.spyOn(gate, 'promoteMissionSessionAuthority').mockImplementation((input) => {
      promote(input);
      throw new Error('adoption failed');
    });
    expect(() => apply('new', 'adopt')).toThrow('adoption failed');
    expect(ctx).toEqual(before);
    expect(Object.hasOwn(ctx, 'missionId')).toBe(false);
    expect(physical.states.get('new')).toBe('idle');
  });

  it('revokes all exited gate leaders including one not in durable A', () => {
    const first = addSession('old', 'exited', 'orchestrator');
    const second = addSession('other', 'exited', 'orchestrator');
    stores().missions.setOrchestratorSession(missionId, 'old');
    addSession('new');
    apply('new', 'promote');
    expect(first.role).toBe('worker');
    expect(second.role).toBe('worker');
    expect(() => getMissionLeadership().assertSingleLeader(scope, missionId)).not.toThrow();
  });

  it('rejects missing transaction initialization without writing A or C', () => {
    addSession('new');
    const manager = physical.manager;
    physical.manager = null;
    try {
      expect(() => apply('new')).toThrow('leadership_runtime_not_initialized');
      expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    } finally {
      physical.manager = manager;
    }
  });

  it('refuses an outer transaction that could publish F before durable commit', () => {
    addSession('new');
    physical.manager!.open(scope).db.transaction(() => {
      expect(() => apply('new')).toThrow('leadership_runtime_transaction_nested');
    })();
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it('reports a failed broadcast as committed and can retry the event', () => {
    addSession('new');
    renderer.send.mockImplementationOnce(() => { throw new Error('renderer gone'); });
    const result = apply('new');
    expect(result.rendererNotified).toBe(false);
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('new');
    createMissionLeadershipPorts(scope).emitLeadershipChanged(result.event);
    expect(renderer.send).toHaveBeenCalledTimes(2);
  });

  it('restores the new gate even when an old context disappears during compensation', () => {
    addSession('old');
    apply('old');
    physical.states.set('old', 'exited');
    const next = addSession('new');
    const promote = gate.promoteMissionSessionAuthority;
    vi.spyOn(gate, 'promoteMissionSessionAuthority').mockImplementation((input) => {
      promote(input);
      gate.releaseSession('old');
      throw new Error('old context disappeared');
    });
    expect(() => apply('new', 'promote')).toThrow('leadership_rollback_failed');
    expect(next.role).toBe('worker');
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('old');
  });
});

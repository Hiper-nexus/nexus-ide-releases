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
import { MissionLeadership, MissionLeadershipError, type LeadershipInput } from './mission-leadership';
import { createMissionLeadershipPorts, getMissionLeadership, MISSION_LEADERSHIP_CHANGED_CHANNEL, takeoverMissionLeadershipFromRenderer } from './mission-leadership-runtime';

const physical = vi.hoisted(() => ({
  sessions: new Map<string, OwnedAgentSessionInfo>(),
  states: new Map<string, PaneSessionState>(),
  owners: new Map<string, WebContents>(),
  renderers: [] as WebContents[],
  fastLane: vi.fn((): ReturnType<typeof import('./mission-fast-lane').fastLaneOrchestratorPaneSummary> => null),
  manager: null as ProjectRuntimeManager | null,
}));
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => physical.renderers } }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => physical.sessions.get(id) ?? null,
  getOwnedAgentSessionInfo: (owner: WebContents, id: string) => physical.owners.get(id) === owner ? physical.sessions.get(id) ?? null : null,
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
  physical.owners.set(id, renderer);
  physical.states.set(id, state);
  const ctx = gate.mintToken({
    label: id, scope, missionId, role, readOnly: true,
    allowedTools: ['pane_read'], allowedSkills: ['review'],
    workerIncarnationId: info.workerIncarnationId,
  });
  gate.bindTokenToSession(ctx.token, id);
  return ctx;
}
function apply(sessionId: string, origin: Exclude<LeadershipInput['origin'], 'takeover'> = 'spawn') {
  return getMissionLeadership().applyLeadership(scope, missionId, { sessionId, paneId: `pane-${sessionId}`, origin });
}
function creator() {
  const ctx = addSession('creator');
  ctx.role = 'user';
  delete ctx.missionId;
  delete ctx.workerIncarnationId;
  physical.sessions.set('creator', { ...physical.sessions.get('creator')!, role: 'user', missionId: undefined, workerIncarnationId: undefined });
  missionId = stores().missions.create({ title: 'Created by user', orchestratorSessionId: 'creator' }).id;
  return ctx;
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
  physical.owners.clear();
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
  it('only the owned renderer entry can takeover a live leader, demoting real C+D without killing', () => {
    const old = addSession('old', 'busy');
    apply('old');
    const next = addSession('new');
    const states = [...physical.states];
    const input = { sessionId: 'new', paneId: 'pane-new', reason: 'Operador escolheu este painel' };
    expect(() => getMissionLeadership().applyLeadership(scope, missionId, { ...input, origin: 'takeover' }))
      .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    for (const origin of ['promote', 'adopt'] as const) {
      expect(() => apply('new', origin)).toThrow(expect.objectContaining({ code: 'existing_session' }));
    }
    renderer.send.mockImplementationOnce(() => {
      expect(() => getMissionLeadership().applyLeadership(scope, missionId, { ...input, origin: 'takeover' }))
        .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
      expect(() => takeoverMissionLeadershipFromRenderer(renderer, missionId, input))
        .toThrow(expect.objectContaining({ code: 'busy' }));
    });
    const result = takeoverMissionLeadershipFromRenderer(renderer, missionId, input);
    expect(result.event).toMatchObject({ origin: 'takeover', reason: input.reason, previousSessionIds: ['old'], previousPaneIds: ['pane-old'] });
    expect(old).toMatchObject({ role: 'worker', allowedTools: [] });
    expect(next.role).toBe('orchestrator');
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('new');
    expect(stores().missionPanes.findByPaneId('pane-old')?.role).toBe('worker');
    expect([...physical.states]).toEqual(states);
    expect(() => getMissionLeadership().assertSingleLeader(scope, missionId)).not.toThrow();
    expect(() => getMissionLeadership().applyLeadership(scope, missionId, { ...input, origin: 'takeover' }))
      .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
  });

  it('takeover requires a reason and exact renderer ownership even in the same scope', () => {
    addSession('new');
    const input = { sessionId: 'new', paneId: 'pane-new', reason: 'Trocar líder' };
    for (const reason of ['', ' \n ']) {
      expect(() => takeoverMissionLeadershipFromRenderer(renderer, missionId, { ...input, reason }))
        .toThrow(expect.objectContaining({ code: 'write_incomplete' }));
    }
    bindResolvedRendererWorkspaceScope(foreignRenderer, scope);
    expect(() => takeoverMissionLeadershipFromRenderer(foreignRenderer, missionId, input))
      .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    expect(renderer.send).not.toHaveBeenCalled();
    // A failed authorization/validation must not strand the single-use grant.
    expect(takeoverMissionLeadershipFromRenderer(renderer, missionId, input).leader.sessionId).toBe('new');
  });

  it('rejects takeover from a destroyed renderer with a typed error', () => {
    addSession('new');
    const destroyed = { ...renderer, isDestroyed: () => true } as unknown as WebContents;
    expect(() => takeoverMissionLeadershipFromRenderer(destroyed, missionId, {
      sessionId: 'new', paneId: 'pane-new', reason: 'Trocar líder',
    })).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it('failed takeover compensates C+D, preserves the old leader and revokes the operator grant', () => {
    const old = addSession('old');
    apply('old');
    const next = addSession('new');
    const before = { old: structuredClone(old), next: structuredClone(next), panes: stores().missionPanes.list(missionId) };
    const promote = gate.promoteMissionSessionAuthority;
    vi.spyOn(gate, 'promoteMissionSessionAuthority').mockImplementation((input) => {
      promote(input);
      throw new Error('takeover D failed');
    });
    const input = { sessionId: 'new', paneId: 'pane-new', reason: 'Troca solicitada' };
    expect(() => takeoverMissionLeadershipFromRenderer(renderer, missionId, input)).toThrow('takeover D failed');
    expect(old).toEqual(before.old);
    expect(next).toEqual(before.next);
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('old');
    expect(stores().missionPanes.list(missionId)).toEqual(before.panes);
    expect(renderer.send).toHaveBeenCalledTimes(1);
    expect(() => getMissionLeadership().applyLeadership(scope, missionId, { ...input, origin: 'takeover' }))
      .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
  });

  it('creates leadership for a pending mission already bound to its user creator', () => {
    const ctx = creator();
    const before = { tools: ctx.allowedTools, skills: ctx.allowedSkills, readOnly: ctx.readOnly };
    const result = apply('creator', 'create');
    expect(result.leader).toMatchObject({ sessionId: 'creator', proven: true });
    expect(ctx).toMatchObject({ role: 'orchestrator', missionId, promotedFromUserSession: true });
    expect({ tools: ctx.allowedTools, skills: ctx.allowedSkills, readOnly: ctx.readOnly }).toEqual(before);
    expect(stores().missionPanes.list(missionId)).toMatchObject([{
      role: 'orchestrator', paneId: 'pane-creator', allowedTools: before.tools, allowedSkills: before.skills,
    }]);
    expect(stores().missions.get(missionId)?.status).toBe('pending');
    expect(apply('creator', 'create').rendererNotified).toBe(true);
  });

  it('rejects create from a worker and other origins from an unbound user', () => {
    addSession('new');
    expect(() => apply('new', 'create')).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    creator();
    expect(() => apply('creator', 'adopt')).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it('restores a user creator exactly if create fails after D changes', () => {
    const ctx = creator();
    const before = structuredClone(ctx);
    const ports = createMissionLeadershipPorts(scope);
    const write = ports.replaceRuntimeLeader;
    ports.replaceRuntimeLeader = (...args) => { write(...args); throw new Error('create failed'); };
    const engine = new MissionLeadership({ forScope: () => ports });
    expect(() => engine.applyLeadership(scope, missionId, { sessionId: 'creator', paneId: 'pane-creator', origin: 'create' })).toThrow('create failed');
    expect(ctx).toEqual(before);
    expect(stores().missionPanes.list(missionId)).toEqual([]);
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('creator');
  });

  it.each(['spawn', 'respawn'] as const)('%s can replace exited registered authority', (origin) => {
    const old = addSession('old', 'exited', 'orchestrator');
    stores().missions.setOrchestratorSession(missionId, 'old');
    addSession('new');
    expect(apply('new', origin).leader.sessionId).toBe('new');
    expect(old.role).toBe('worker');
    expect(physical.states.get('old')).toBe('exited');
  });

  it('release uses real CAS, preserves C rows and revokes D after physical exit', () => {
    const ctx = addSession('new');
    apply('new');
    const original = stores().missionPanes.findByPaneId('pane-new')!;
    const cas = vi.spyOn(stores().missions, 'clearOrchestratorSessionIfMatches');
    physical.states.set('new', 'exited');
    const result = getMissionLeadership().releaseLeadership(scope, missionId, { sessionId: 'new', reason: 'teardown' });
    expect(result).toMatchObject({ released: true, rendererNotified: true });
    expect(cas).toHaveBeenCalledExactlyOnceWith(missionId, 'new');
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBeUndefined();
    expect(stores().missionPanes.findByPaneId('pane-new')).toMatchObject({ id: original.id, role: 'worker', allowedTools: [] });
    expect(ctx).toMatchObject({ role: 'worker', allowedTools: [], readOnly: true });
    expect(ctx.missionId).toBeUndefined();
    expect(renderer.send).toHaveBeenLastCalledWith(MISSION_LEADERSHIP_CHANGED_CHANNEL, expect.objectContaining({ type: 'mission-leadership-released', sessionId: 'new', reason: 'teardown' }));
    expect(getMissionLeadership().resolveMissionLeader(scope, missionId)).toBeNull();
  });

  it('release returns the creator to user and does not let B re-elect a released live session', () => {
    const ctx = creator();
    apply('creator', 'create');
    physical.fastLane.mockReturnValue({ paneId: 'pane-creator', sessionId: 'creator', role: 'orchestrator', title: 'Creator', agentName: 'Creator', adapterId: 'codex', cwd: scope.rootRealPath });
    expect(getMissionLeadership().releaseLeadership(scope, missionId, { sessionId: 'creator', reason: 'discarded' }).released).toBe(true);
    expect(ctx.role).toBe('user');
    expect(ctx.promotedFromUserSession).toBeUndefined();
    expect(ctx.missionId).toBeUndefined();
    expect(physical.states.get('creator')).toBe('idle');
    expect(getMissionLeadership().resolveMissionLeader(scope, missionId)).toBeNull();
  });

  it('CAS loss does not demote C or revoke D', () => {
    const ctx = addSession('new');
    apply('new');
    const panesBefore = stores().missionPanes.list(missionId);
    vi.spyOn(stores().missions, 'clearOrchestratorSessionIfMatches').mockImplementation(() => {
      stores().missions.setOrchestratorSession(missionId, 'successor');
      return null;
    });
    expect(getMissionLeadership().releaseLeadership(scope, missionId, { sessionId: 'new', reason: 'late-exit' })).toEqual({ released: false });
    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('successor');
    expect(stores().missionPanes.list(missionId)).toEqual(panesBefore);
    expect(ctx.role).toBe('orchestrator');
    expect(renderer.send).toHaveBeenCalledTimes(1);
  });

  it.each(['releasePaneLeader', 'releaseRuntimeLeader'] as const)('rolls back real A+C+D when %s fails', (method) => {
    const ctx = addSession('new');
    apply('new');
    ctx.contextRevision = 'revision-preserved';
    const before = { mission: stores().missions.get(missionId), panes: stores().missionPanes.list(missionId), ctx: structuredClone(ctx) };
    const ports = createMissionLeadershipPorts(scope);
    const release = ports[method];
    ports[method] = (...args) => { release(...args); throw new Error('release failed'); };
    const engine = new MissionLeadership({ forScope: () => ports });
    expect(() => engine.releaseLeadership(scope, missionId, { sessionId: 'new', reason: 'teardown' })).toThrow('release failed');
    expect(stores().missions.get(missionId)).toEqual(before.mission);
    expect(stores().missionPanes.list(missionId)).toEqual(before.panes);
    expect(ctx).toEqual(before.ctx);
    expect(renderer.send).toHaveBeenCalledTimes(1);
  });

  it('accepts legacy partial scope through the real registry, gate and PTY ports', () => {
    const ctx = addSession('new');
    ctx.scope = { ...scope, workspaceRootDevice: '1', workspaceRootInode: '2' };
    physical.sessions.set('new', { ...physical.sessions.get('new')!, scope: ctx.scope });
    expect(getMissionLeadership().applyLeadership({ ...scope, workspaceRootDevice: '1' }, missionId, {
      sessionId: 'new', paneId: 'pane-new', origin: 'spawn',
    }).leader.proven).toBe(true);
    ctx.scope = { ...ctx.scope, checkoutId: 'foreign' };
    expect(() => createMissionLeadershipPorts(scope).captureRuntime(missionId, { sessionId: 'new', paneId: 'pane-new' })).toThrow(MissionLeadershipError);
  });
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

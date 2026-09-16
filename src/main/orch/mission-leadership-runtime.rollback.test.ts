/**
 * Prova/refuta o risco nº 1 do review adversarial: a transação do adaptador
 * (getMissionEventRuntimeManager().acquire(scope).runtime.db.transaction)
 * pode estar numa conexão SQLite diferente da que A (suite.missions) e C
 * (suite.missionPanes) escrevem, deixando um throw dentro de commit() sem
 * desfazer A+C. Prova com SQLite real (sem mocks nos stores de domínio),
 * lendo o banco DIRETO (missions.get / missionPanes.list) depois da falha.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { PaneSessionState } from '../../shared/types';
import { synthesizeImmediateDispatchContract } from '../../shared/mission-intent';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import * as gate from './gate';
import { MissionLeadership } from './mission-leadership';
import { createMissionLeadershipPorts, getMissionLeadership } from './mission-leadership-runtime';

// Mesma configuração de physical.manager que mission-leadership-runtime.test.ts:
// getMissionEventRuntimeManager() devolve o MESMO ProjectRuntimeManager que
// configureProjectDomainStoreRegistry recebe — é isso que main.ts faz de
// verdade (projectRuntimeManager passado para configureRendererMissionAuthority
// em main.ts:457 e para configureMissionEventEmit em main.ts:506).
const physical = vi.hoisted(() => ({
  sessions: new Map<string, OwnedAgentSessionInfo>(),
  states: new Map<string, PaneSessionState>(),
  manager: null as ProjectRuntimeManager | null,
}));
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => [] } }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => physical.sessions.get(id) ?? null,
  getSessionState: (id: string) => physical.states.get(id) ?? null,
  listAgentSessions: () => [...physical.sessions.values()],
  registeredOrchestratorSessionsForMission: (missionId: string) => [...physical.sessions.values()]
    .filter((s) => s.missionId === missionId && s.role === 'orchestrator')
    .map((s) => ({ sessionId: s.sessionId, state: physical.states.get(s.sessionId), adapterId: s.adapterId })),
}));
vi.mock('./mission-fast-lane', () => ({ fastLaneOrchestratorPaneSummary: () => null }));
vi.mock('./mission-event-emit', () => ({ getMissionEventRuntimeManager: () => physical.manager }));

const scope = testProjectScope();
let baseDir: string;
let missionId: string;

function stores() { return getProjectDomainStores(scope); }

function addSession(id: string): void {
  const info: OwnedAgentSessionInfo = {
    sessionId: id, paneId: `pane-${id}`, adapterId: 'codex', role: 'worker',
    scope, missionId, cwd: scope.rootRealPath, source: 'persisted-pane',
    allowedTools: ['pane_read'], allowedSkills: ['review'], readOnly: true,
    workerIncarnationId: `incarnation-${id}`,
  };
  physical.sessions.set(id, info);
  physical.states.set(id, 'idle');
  const ctx = gate.mintToken({
    label: id, scope, missionId, role: 'worker', readOnly: true,
    allowedTools: ['pane_read'], allowedSkills: ['review'],
    workerIncarnationId: info.workerIncarnationId,
  });
  gate.bindTokenToSession(ctx.token, id);
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-leadership-rollback-'));
  physical.manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureProjectDomainStoreRegistry(physical.manager);
  const mission = stores().missions.create({
    title: 'Rollback probe', intentVersion: 1, intentState: 'executing',
    intentContract: synthesizeImmediateDispatchContract({ title: 'Rollback probe', now: 100 }),
  });
  missionId = mission.id;
  stores().missions.setStatus(missionId, 'running');
});
afterEach(() => {
  vi.restoreAllMocks();
  physical.sessions.clear();
  physical.states.clear();
  gate.resetGateForTests();
  disposeProjectDomainStoreRegistry();
  physical.manager?.closeAll();
  physical.manager = null;
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('mission-leadership-runtime — A/C compartilham a conexão SQLite da transação', () => {
  it('replaceRuntimeLeader falhando reverte A e C no banco de verdade (leitura direta)', () => {
    addSession('new');
    const missionBefore = stores().missions.get(missionId);
    const panesBefore = stores().missionPanes.list(missionId);
    expect(missionBefore?.orchestratorSessionId).toBeUndefined();
    expect(panesBefore).toEqual([]);

    const ports = createMissionLeadershipPorts(scope);
    ports.replaceRuntimeLeader = () => { throw new Error('forced replaceRuntimeLeader failure'); };
    const engine = new MissionLeadership({ forScope: () => ports });

    expect(() =>
      engine.applyLeadership(scope, missionId, { sessionId: 'new', paneId: 'pane-new', origin: 'spawn' }),
    ).toThrow('forced replaceRuntimeLeader failure');

    // Leitura DIRETA no store de domínio — sem mock, sem spy: SQLite real.
    expect(stores().missions.get(missionId)).toEqual(missionBefore);
    expect(stores().missionPanes.list(missionId)).toEqual(panesBefore);
  });

  it('replacePaneLeader falhando reverte A no banco de verdade (leitura direta)', () => {
    addSession('new');
    const missionBefore = stores().missions.get(missionId);

    const ports = createMissionLeadershipPorts(scope);
    ports.replacePaneLeader = () => { throw new Error('forced replacePaneLeader failure'); };
    const engine = new MissionLeadership({ forScope: () => ports });

    expect(() =>
      engine.applyLeadership(scope, missionId, { sessionId: 'new', paneId: 'pane-new', origin: 'spawn' }),
    ).toThrow('forced replacePaneLeader failure');

    expect(stores().missions.get(missionId)).toEqual(missionBefore);
    expect(stores().missionPanes.list(missionId)).toEqual([]);
  });

  it('em sucesso, A, C e D concordam no banco/gate de verdade', () => {
    addSession('new');

    getMissionLeadership().applyLeadership(scope, missionId, { sessionId: 'new', paneId: 'pane-new', origin: 'spawn' });

    expect(stores().missions.get(missionId)?.orchestratorSessionId).toBe('new');
    expect(stores().missionPanes.list(missionId).find((p) => p.paneId === 'pane-new')?.role).toBe('orchestrator');
    expect(gate.getContextBySession('new')?.role).toBe('orchestrator');
    expect(() => getMissionLeadership().assertSingleLeader(scope, missionId)).not.toThrow();
  });
});

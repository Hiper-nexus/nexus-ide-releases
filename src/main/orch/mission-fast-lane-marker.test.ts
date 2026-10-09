import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSessionState } from '../../shared/surface-payload-types';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry, getProjectDomainStores } from './project-domain-store-registry';
import { createScopedMissionStore } from './mission-store';
import { missionEngineForScope } from './mission-engine-registry';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { resolveMissionPaneAuthoritySeal } from './mission-pane-authority';
import { getMissionLeadership } from './mission-leadership-runtime';
import { mintToken, bindTokenToSession, resetGateForTests } from './gate';
import { stopPeriodicTask } from '../observability/periodic-task';
import './mission-engine-production';

/**
 * Via Rápida no modelo PULL: o motor não lê PRONTO/BLOQUEADO do PTY e não
 * recutuca o pane. Pane vazio após o turno NÃO conclui nem bloqueia —
 * Overclock: só o operador para a missão.
 */

const harness = vi.hoisted(() => ({
  physical: new Map<string, OwnedAgentSessionInfo>(),
  sessionStates: new Map<string, PaneSessionState | null>(),
  snapshots: [] as Array<{
    missionId: string;
    paneId: string;
    sessionId: string;
    role: 'orchestrator' | 'worker';
    agentName: string;
  }>,
  deliverAgentPrompt: vi.fn(async () => true),
  completeVerified: vi.fn(),
  blockTechnical: vi.fn(),
  resumeTechnical: vi.fn(),
  spawnCount: 0,
  recordKickoffAcceptance: vi.fn(),
}));

vi.mock('../pty/pty-manager', async importOriginal => ({
  ...await importOriginal<typeof import('../pty/pty-manager')>(),
  getAgentSessionInfo: (id: string) => harness.physical.get(id) ?? null,
  getSessionState: (id: string) => harness.sessionStates.get(id) ?? null,
  getSessionCwd: (id: string) => harness.physical.get(id)?.cwd ?? null,
  isPtySessionConnectedAndWritable: (id: string) => ['idle', 'busy'].includes(harness.sessionStates.get(id) ?? ''),
  registeredOrchestratorSessionsForMission: (id: string) => [...harness.physical.values()]
    .filter(info => info.missionId === id && info.role === 'orchestrator' && harness.sessionStates.get(info.sessionId) !== 'exited')
    .map(info => ({ sessionId: info.sessionId, state: harness.sessionStates.get(info.sessionId), adapterId: info.adapterId })),
  listAgentSessions: () => [...harness.physical.values()],
  orchTerminateSession: async () => true,
}));

vi.mock('../pty/pre-spawn-probe', () => ({
  assertPreSpawnProbe: async () => {},
  PreSpawnProbeError: class PreSpawnProbeError extends Error {},
}));

// Fail-closed do bootstrap (0.60): Maestro exige adapter cli-pty com rota
// Nexus MCP; o registry real não carrega builtins no vitest.
vi.mock('../adapters/adapter-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../adapters/adapter-registry')>(),
  getAdapter: (id: string) => ({
    id,
    label: id,
    kind: 'cli-pty',
    bin: 'claude',
    quirks: { nexusMcp: 'flag' },
    spawn: { initialPrompt: 'positional' },
  }),
}));

vi.mock('./tool-util', async importOriginal => ({
  ...await importOriginal<typeof import('./tool-util')>(),
  deliverAgentPrompt: (...args: unknown[]) =>
    harness.deliverAgentPrompt(...(args as [])),
  proveNativeArgvBriefAccepted: async () => {},
  withProjectContextBlocks: (options: { prompt?: string }) => options.prompt,
  withProjectContextBlocksAsync: async (options: { prompt?: string }) => options.prompt,
}));

vi.mock('./pane-registry', async importOriginal => ({
  ...await importOriginal<typeof import('./pane-registry')>(),
  readSessionOutput: () => '',
  wasOrchestratorOperatorDismissed: () => false,
  clearOperatorDismissedPanes: () => {},
  listPaneSnapshots: () =>
    harness.snapshots.map((pane) => ({
      ...pane,
      state: harness.sessionStates.get(pane.sessionId) ?? 'idle',
    })),
  getPaneRuntimeAuthorityBySession: (id: string) => {
    const info = harness.physical.get(id);
    return info ? { sessionId: id, paneId: info.paneId, kind: 'cli-agent', missionId: info.missionId,
      role: info.role, scope: info.coordinationScope ?? info.scope, owner: null } : null;
  },
  requestPaneSpawn: async (options: { missionId: string; role: 'orchestrator' | 'worker'; agentName: string;
    adapterId: string; scope: ReturnType<typeof testProjectScope>; executionScope?: ReturnType<typeof testProjectScope>;
    readOnly?: boolean; model?: string; effort?: string }) => {
    harness.spawnCount += 1;
    const sessionId = `session-${harness.spawnCount}`;
    const paneId = `pane-${harness.spawnCount}`;
    harness.sessionStates.set(sessionId, 'idle');
    harness.snapshots.push({
      missionId: options.missionId,
      paneId,
      sessionId,
      role: options.role,
      agentName: options.agentName,
    });
    const scope = options.executionScope ?? options.scope;
    const current = getProjectDomainStores(options.scope).missions.get(options.missionId)!;
    const info: OwnedAgentSessionInfo = { sessionId, paneId, adapterId: options.adapterId, cwd: scope.rootRealPath,
      scope, ...(scope !== options.scope ? { coordinationScope: options.scope } : {}), source: 'pending',
      role: options.role, missionId: options.missionId, agentName: options.agentName,
      requestedModel: options.model, effort: options.effort, readOnly: options.readOnly === true,
      nativeReadOnly: options.readOnly === true, allowedTools: null, allowedSkills: null,
      authoritySeal: resolveMissionPaneAuthoritySeal(options.scope, current, fixtureSquad)! };
    harness.physical.set(sessionId, info);
    const gate = mintToken({ label: 'controlled spawned agent', role: options.role, missionId: options.missionId,
      scope: options.scope, readOnly: info.readOnly, allowedTools: null, allowedSkills: null });
    bindTokenToSession(gate.token, sessionId);
    return { requestId: 'r', ok: true, paneId, sessionId };
  },
}));

let mission: Mission;
function liveMission(): Mission { return getProjectDomainStores(scope).missions.get(mission.id)!; }

const squadAgents: SquadAgent[] = [
  {
    id: 'coord',
    agentName: 'Coordenar e revisar',
    category: 'orchestrator',
    cli: 'agy',
  } as SquadAgent,
  {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'agy',
  } as SquadAgent,
];

vi.mock('./squad-store', () => ({
  getSquad: () => fixtureSquad,
  listSquads: () => [fixtureSquad],
}));

const fixtureSquad = { id: 'squad-1', name: 'Fixture squad', createdAt: '1', builtin: false,
  orchestratorInstructions: '', agents: squadAgents } as Squad;

type FastLaneModule = typeof import('./mission-fast-lane');
type MarkerModule = typeof import('./mission-completion-marker');

let fastLane: FastLaneModule;
let marker: MarkerModule;

let scope: ReturnType<typeof testProjectScope>;
let root: string;
let runtimeRoot: string;
let manager: ProjectRuntimeManager;

async function bootOrchestratorIdle(): Promise<string> {
  await fastLane.fastLaneBootstrap(scope, mission.id);
  const sessionId = 'session-1';
  expect(getMissionLeadership().resolveMissionLeader(scope, mission.id)).toMatchObject({ sessionId, paneId: 'pane-1', proven: true });
  expect(getProjectDomainStores(scope).missions.hasCurrentKickoffAcceptance(mission.id)).toBe(true);
  expect(liveMission().orchestratorSessionId).toBe(sessionId);
  harness.sessionStates.set(sessionId, 'idle');
  return sessionId;
}

async function ticks(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(15_000 * count);
}

beforeEach(async () => {
  vi.useFakeTimers();
  harness.sessionStates.clear();
  harness.physical.clear();
  resetGateForTests();
  harness.snapshots.length = 0;
  harness.deliverAgentPrompt.mockClear();
  harness.completeVerified.mockClear();
  harness.blockTechnical.mockClear();
  harness.resumeTechnical.mockClear();
  harness.recordKickoffAcceptance.mockClear();
  harness.spawnCount = 0;
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-marker-project-')));
  runtimeRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-marker-runtime-')));
  const stat = fs.statSync(root);
  scope = testProjectScope({ rootRealPath: root, projectId: path.basename(root), checkoutId: path.basename(root),
    workspaceRootDevice: String(stat.dev), workspaceRootInode: String(stat.ino) });
  manager = new ProjectRuntimeManager({ baseDir: runtimeRoot, appVersion: 'marker-test' });
  configureProjectDomainStoreRegistry(manager).forScope(scope);
  mission = createScopedMissionStore(manager, scope, { assertCreateAccess: () => {} }).create({
    title: 'Prova', description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.', squadId: fixtureSquad.id,
    intentState: 'ready_to_start', intentVersion: 1, intentContract: { version: 1, source: 'typed',
      goal: 'Leia brief.txt e escreva a primeira frase em resumo.txt.', acceptanceCriteria: ['Resumo'],
      risk: 'normal', executionMode: 'autopilot', contextPolicy: 'on-demand', intentVersion: 1,
      approvedAt: Date.now(), dispatchedAt: Date.now(), squadRevisionHash: snapshotSquadAuthority(fixtureSquad).hash,
      orchestratorRuntime: { adapterId: 'agy', readOnly: false, nativeReadOnly: false },
      budgets: { planningTokens: 1000, executionTokens: 1000, maxWorkers: 1 } } });
  const stores = getProjectDomainStores(scope);
  const record = stores.missions.recordKickoffAcceptance.bind(stores.missions);
  vi.spyOn(stores.missions, 'recordKickoffAcceptance').mockImplementation(input => {
    harness.recordKickoffAcceptance(input); return record(input);
  });
  const engine = missionEngineForScope(scope);
  const completeVerified = engine.completeVerified.bind(engine);
  vi.spyOn(engine, 'completeVerified').mockImplementation((...args) => {
    harness.completeVerified(...args); return completeVerified(...args);
  });
  const blockTechnical = engine.blockTechnical.bind(engine);
  vi.spyOn(engine, 'blockTechnical').mockImplementation((...args) => {
    harness.blockTechnical(...args); return blockTechnical(...args);
  });
  const resumeTechnical = engine.resumeTechnical.bind(engine);
  vi.spyOn(engine, 'resumeTechnical').mockImplementation((...args) => {
    harness.resumeTechnical(...args); return resumeTechnical(...args);
  });
  fastLane = await import('./mission-fast-lane');
  marker = await import('./mission-completion-marker');
});

afterEach(async () => {
  await stopPeriodicTask(`mission-fast-lane:${scope.rootRealPath}::${mission.id}`);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGateForTests();
  await disposeProjectDomainStoreRegistry();
  manager.closeAll();
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Via Rápida × modelo PULL', () => {
  it('spawna só o orquestrador; pane idle não é recutucado nem concluído', async () => {
    await bootOrchestratorIdle();
    expect(harness.spawnCount).toBe(1);
    // 0.60: o recibo nasce no spawn e o idle confirma via kickoff-direct
    // queue — pode registrar mais de uma vez, nunca zero.
    expect(harness.recordKickoffAcceptance).toHaveBeenCalled();

    await ticks(4);

    expect(harness.deliverAgentPrompt).not.toHaveBeenCalled();
    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
  });

  it('orquestrador morto com handoff de sucesso NÃO conclui a missão', async () => {
    await bootOrchestratorIdle();
    getProjectDomainStores(scope).handoffs.submit({
      missionId: mission.id, status: 'success',
      summary: 'Primeira frase do brief.txt gravada em resumo.txt.',
      fromAgent: 'Implementar motor', sessionId: 'session-2',
    });
    harness.sessionStates.set('session-1', 'exited');

    await ticks(1);

    // 0.60 (A3): Maestro morto em missão running é RESPAWNADO uma vez com o
    // briefing re-entregue — o que continua proibido é concluir/bloquear.
    expect(harness.blockTechnical).not.toHaveBeenCalled();
    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(liveMission().status).toBe('running');
  });

  it('PRONTO no PTY não arma observador nem conclui — entrega é handoff', async () => {
    const sessionId = await bootOrchestratorIdle();
    expect(marker.missionMarkerObserver.isWatching(sessionId)).toBe(false);
    marker.missionMarkerObserver.observe(
      sessionId,
      'PRONTO: Primeira frase do brief.txt gravada em resumo.txt.\n',
    );
    expect(marker.missionMarkerObserver.markerOf(sessionId)).toBeNull();

    await ticks(2);

    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
  });

  it('orquestrador morto sem handoff NÃO bloqueia — missão segue running', async () => {
    await bootOrchestratorIdle();
    harness.sessionStates.set('session-1', 'exited');

    await ticks(1);

    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
    expect(liveMission().status).toBe('running');
  });

  it('pane morto sem handoff continua não sendo sucesso', async () => {
    await bootOrchestratorIdle();
    harness.sessionStates.set('session-1', 'exited');
    await ticks(2);

    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
  });

  it('retry-kickoff respawna o Maestro quando running sem sessão viva', async () => {
    await bootOrchestratorIdle();
    harness.sessionStates.set('session-1', 'exited');
    await ticks(1);
    const spawnedBefore = harness.spawnCount;

    expect(liveMission().status).toBe('running');
    await fastLane.resumeFastLaneMission(scope, mission.id);

    expect(harness.spawnCount).toBe(spawnedBefore + 1);
    expect(harness.blockTechnical).not.toHaveBeenCalled();
    expect(harness.completeVerified).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'running'] as const)('F-429: explicit resume clears both stop markers from a %s row', async status => {
    const store = getProjectDomainStores(scope).missions;
    const current = store.get(mission.id)!;
    store.transitionLifecycle(mission.id, { updatedAt: current.updatedAt, intentVersion: current.intentVersion! }, {
      status, intentState: status === 'blocked' ? 'blocked_user' : 'executing',
      description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.\n\n' +
        '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.\n\n<!-- nexus:leftover-parked -->\n[NEXUS_LEFTOVER_PARKED] Encerrada.',
    });

    await fastLane.resumeFastLaneMission(scope, mission.id);

    expect(harness.resumeTechnical).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
      }),
    );
    expect(liveMission().description).not.toContain('runtime-closed');
  });
});

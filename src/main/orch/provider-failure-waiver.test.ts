import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';
import { createTaskDispatchStore } from './task-dispatch-store';
import { createScopedHandoffStore } from './handoff-store';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

const registryMocks = vi.hoisted(() => ({
  requestMissionWorkerPaneRetirement: vi.fn(async () => true),
}));

const driverMocks = vi.hoisted(() => ({
  requestMissionDriverTick: vi.fn(() => true),
}));

vi.mock('./pane-registry', () => ({
  requestMissionWorkerPaneRetirement:
    registryMocks.requestMissionWorkerPaneRetirement,
}));

vi.mock('./mission-driver-runtime', () => ({
  requestMissionDriverTick: driverMocks.requestMissionDriverTick,
}));

import {
  configureProviderFailureWaiver,
  handleMissionWorkerProviderNoRoute,
  providerWaiverLearning,
  providerWaiverNeverExecutedReason,
} from './provider-failure-waiver';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.19.27-test',
  });
  managers.push(value);
  return value;
}

function approvedIntentContract(
  input: Parameters<typeof compileIntentContract>[0],
): ReturnType<typeof compileIntentContract> {
  return {
    ...compileIntentContract(input),
    approvedAt: 1,
    dispatchedAt: 1,
  };
}

let fixtureSequence = 0;
let physicalReceiptSequence = 0;

/**
 * Réplica mínima do helper do task-dispatch-store.test.ts: ancora o handoff ao
 * recibo físico MCP + audit intent que a autoridade de aceitação re-prova.
 */
function insertPhysicalHandoffAuthority(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly handoffId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
}): void {
  const db = input.runtime.open(input.scope).db;
  const handoff = db
    .prepare(`SELECT created_at FROM handoffs WHERE id = ?`)
    .get(input.handoffId) as { created_at: number };
  const receiptId = `physical-waiver-${++physicalReceiptSequence}`;
  db.prepare(
    `INSERT INTO audit_events
       (id, mission_id, actor, action, outcome, payload_json, occurred_at)
     VALUES (?, ?, ?, 'nexus_handoff_submit', 'intent', ?, ?)`,
  ).run(
    `audit-${receiptId}`,
    input.missionId,
    input.sessionId,
    JSON.stringify({
      schema: 'nexus.mcp-audit/v1',
      timestamp: new Date(handoff.created_at).toISOString(),
      project_id: input.scope.projectId,
      checkout_id: input.scope.checkoutId,
      source: 'http-mcp',
      invocation_id: receiptId,
      args: {},
      duration_ms: 0,
      user_authorized: false,
    }),
    handoff.created_at,
  );
  db.prepare(
    `INSERT INTO handoff_mcp_receipts
       (receipt_id, handoff_id, tool_call_id, tool_name, source,
        mission_id, session_id, worker_incarnation_id,
        authority_sha256, worktree_head_sha, issued_at)
     VALUES (?, ?, ?, 'nexus_handoff_submit', 'http-mcp', ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    input.handoffId,
    receiptId,
    input.missionId,
    input.sessionId,
    input.workerIncarnationId,
    createHash('sha256').update(receiptId).digest('hex'),
    null,
    handoff.created_at,
  );
}

function runningWorkerFixture(
  options: { executor?: boolean; extraGlmAgent?: boolean } = {},
) {
  const suffix = `glue-${++fixtureSequence}`;
  const paneId = `pane-${suffix}`;
  const sessionId = `session-${suffix}`;
  const runtime = manager();
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const executor = options.executor === true;
  const agentCategory = executor
    ? ('executor' as const)
    : ('architect' as const);
  const executionMode = executor
    ? ('isolated_worktree' as const)
    : ('read_only' as const);
  const ownership = {
    files: ['src'],
    symbols: [],
    domains: executor ? [] : ['guided-advisory', 'sequential-only'],
  };
  const mission = missions.create({
    title: 'Worker sem provider',
    squadId: 'agentic-guided-squad',
    intentVersion: 4,
    intentState: 'executing',
    intentContract: approvedIntentContract({
      goal: 'Mapear riscos antes da execução principal',
      intentVersion: 4,
    }),
    orchestratorSessionId: 'orchestrator-guided-advisor',
  });
  missions.setStatus(mission.id, 'running');
  const [task] = tasks.createPlanAtomically({
    missionId: mission.id,
    intentVersion: 4,
    squad: {
      id: 'agentic-guided-squad',
      agents: [
        {
          id: 'advisor',
          agentName: 'Advisor independente',
          category: agentCategory,
          cli: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
        ...(options.extraGlmAgent === true
          ? [
              {
                id: 'advisor-glm',
                agentName: 'Advisor GLM',
                category: agentCategory,
                cli: 'glm',
                model: 'glm-4.7',
                effort: 'high' as const,
              },
            ]
          : []),
      ],
    },
    rows: [
      {
        plannerId: 'guided-advisory-1-advisor',
        title: 'Mapear riscos',
        detail: encodeTaskScheduleDetail('Inspecione sem editar.', {
          dependsOn: [],
          ownership,
          merged: false,
          agentRef: 'advisor',
          agentCategory,
          executionMode,
        }),
        agentRef: 'advisor',
        agentCategory,
      },
    ],
  });
  const planReceipt = tasks.getPlanReceipt(mission.id, 4)!;
  const route = missions.reserveRouteDecision(mission.id, task!.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'rota selada',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task!.id,
    intentVersion: 4,
    workerId: 'Advisor independente',
    leaseOwner: 'main',
    leaseMs: 30_000,
    ownership,
    executionMode,
    agentRef: 'advisor',
    agentCategory,
    rosterHash: planReceipt.rosterHash,
    routeContract: {
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
  });
  const routed = dispatches.attachRoute({
    taskId: task!.id,
    revision: claim.revision,
    leaseToken: claim.leaseToken,
    routeReservationId: route.id,
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  missions.consumeRouteReservation(
    {
      reservationId: route.id,
      missionId: mission.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
    `dispatch:${claim.id}`,
  );
  dispatches.bindSpawn({
    taskId: task!.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    workerIncarnationId: claim.workerIncarnationId,
    paneId,
    sessionId,
  });
  return {
    runtime,
    scope,
    missions,
    tasks,
    dispatches,
    mission,
    task: task!,
    claim,
    paneId,
    sessionId,
    ownership,
    executionMode,
    agentCategory,
    planReceipt,
  };
}

function noRouteInputFor(
  fixture: ReturnType<typeof runningWorkerFixture>,
) {
  return {
    scope: fixture.scope,
    missionId: fixture.mission.id,
    paneId: fixture.paneId,
    sessionId: fixture.sessionId,
    workerIncarnationId: fixture.claim.workerIncarnationId,
    adapterId: 'codex',
    hit: {
      kind: 'rate-limit' as const,
      reason: 'rate limit',
      cooldownMs: 60_000,
    },
  };
}

const rosterCandidate = {
  id: 'advisor-glm',
  agentName: 'Advisor GLM',
  category: 'architect',
  cli: 'glm',
  model: 'glm-4.7',
  effort: 'high',
} as const;

function authHitInputFor(fixture: ReturnType<typeof runningWorkerFixture>) {
  return {
    ...noRouteInputFor(fixture),
    hit: {
      kind: 'auth' as const,
      reason: 'Error: 401 OAuth access token has been revoked',
      cooldownMs: 60_000,
    },
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-provider-waiver-'));
  registryMocks.requestMissionWorkerPaneRetirement.mockClear();
  driverMocks.requestMissionDriverTick.mockClear();
});

afterEach(() => {
  configureProviderFailureWaiver({ runtimeManager: null });
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('provider failure waiver glue (Main-owned)', () => {
  it('waives a sealed root advisory: receipt persisted, exact close requested, scheduler tick requested', () => {
    const fixture = runningWorkerFixture();
    configureProviderFailureWaiver({ runtimeManager: fixture.runtime });

    const outcome = handleMissionWorkerProviderNoRoute(
      noRouteInputFor(fixture),
    );

    expect(outcome).toBe('waived');
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'completed',
      handoffId: undefined,
      integrationReceipt: {
        kind: 'advisory_provider_unavailable',
        waiver: {
          missionId: fixture.mission.id,
          sessionId: fixture.sessionId,
          workerIncarnationId: fixture.claim.workerIncarnationId,
          adapterId: 'codex',
          hitKind: 'rate-limit',
        },
      },
    });
    // A tabela `tasks` sozinha distingue dispensa de trabalho: sem esta marca
    // qualquer superfície que não faça join com o dispatch mostra a task
    // dispensada idêntica a uma entregue.
    expect(fixture.tasks.list(fixture.mission.id)[0]).toMatchObject({
      status: 'done',
    });
    expect(
      fixture.tasks.list(fixture.mission.id)[0]?.providerWaiverReason,
    ).toContain('nunca executou');
    expect(
      fixture.tasks.list(fixture.mission.id)[0]?.providerWaiverReason,
    ).toContain('codex');
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    expect(driverMocks.requestMissionDriverTick).toHaveBeenCalled();
  });

  it('required task: terminates the exact stuck session, never marks success, no scheduler wake from the waiver lane', () => {
    const fixture = runningWorkerFixture({ executor: true });
    configureProviderFailureWaiver({ runtimeManager: fixture.runtime });

    const outcome = handleMissionWorkerProviderNoRoute(
      noRouteInputFor(fixture),
    );

    expect(outcome).toBe('retry');
    // Nada de sucesso sintético: o dispatch segue running e sem receipt; a
    // recuperação limitada existente (retry do failover + session-exit do
    // scheduler) decide o destino da task.
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'running',
      integrationReceipt: undefined,
    });
    expect(fixture.tasks.list(fixture.mission.id)[0]).toMatchObject({
      status: 'running',
    });
    // Task que não foi dispensada nunca carrega a marca de dispensa.
    expect(
      fixture.tasks.list(fixture.mission.id)[0]?.providerWaiverReason,
    ).toBeUndefined();
    // Escolha documentada (requisito 10): o encerramento vai pela mesma
    // função authority-sealed do retirement (identidade exata re-provada pelo
    // registry); se for recusado, apenas o retry limitado permanece.
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    expect(driverMocks.requestMissionDriverTick).not.toHaveBeenCalled();
  });

  it('keeps the limited retry when no exact dispatch exists or the runtime is not configured', () => {
    const fixture = runningWorkerFixture();
    configureProviderFailureWaiver({ runtimeManager: fixture.runtime });

    expect(
      handleMissionWorkerProviderNoRoute({
        ...noRouteInputFor(fixture),
        sessionId: 'session-desconhecida',
      }),
    ).toBe('retry');
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).not.toHaveBeenCalled();
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('running');

    configureProviderFailureWaiver({ runtimeManager: null });
    expect(
      handleMissionWorkerProviderNoRoute(noRouteInputFor(fixture)),
    ).toBe('retry');
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('running');
  });
});

describe('reroute dentro do roster ANTES do waiver', () => {
  it('re-rota em vez de dispensar quando o roster tem um agente vivo', () => {
    const fixture = runningWorkerFixture();
    const attemptLiveReroute = vi.fn(() => rosterCandidate);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    const outcome = handleMissionWorkerProviderNoRoute(
      authHitInputFor(fixture),
    );

    expect(outcome).toBe('rerouted');
    expect(attemptLiveReroute).toHaveBeenCalledTimes(1);
    expect(attemptLiveReroute).toHaveBeenCalledWith(fixture.scope, {
      missionId: fixture.mission.id,
      taskId: fixture.task.id,
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      deadAdapterId: 'codex',
    });
    // A vitória inteira: NENHUM waiver foi persistido — a task pertence a
    // outro agente, não foi dispensada. NUNCA done por este caminho.
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      integrationReceipt: undefined,
    });
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).not.toBe('done');
    // Sessão física morta fechada pela identidade exata + scheduler acordado.
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    expect(driverMocks.requestMissionDriverTick).toHaveBeenCalled();
  });

  it('nunca consulta o reroute por um soluço curto: rate-limit segue a política antiga', () => {
    const fixture = runningWorkerFixture();
    const attemptLiveReroute = vi.fn(() => rosterCandidate);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    // noRouteInputFor usa rate-limit — que se resolve em minutos pela
    // espera-pela-irmã; re-rotear por ele jogaria fora um agente saudável.
    const outcome = handleMissionWorkerProviderNoRoute(
      noRouteInputFor(fixture),
    );

    expect(attemptLiveReroute).not.toHaveBeenCalled();
    expect(outcome).toBe('waived');
  });

  it('sem candidato vivo no roster, o waiver volta a ser o último recurso', () => {
    const fixture = runningWorkerFixture();
    const attemptLiveReroute = vi.fn(() => null);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    const outcome = handleMissionWorkerProviderNoRoute(
      authHitInputFor(fixture),
    );

    expect(attemptLiveReroute).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('waived');
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'completed',
      integrationReceipt: { kind: 'advisory_provider_unavailable' },
    });
  });

  it('um reroute que explode NÃO dispensa a task: fail-closed para o retry limitado', () => {
    const fixture = runningWorkerFixture();
    const attemptLiveReroute = vi.fn(() => {
      throw new Error('registry de stores indisponível');
    });
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = handleMissionWorkerProviderNoRoute(
      authHitInputFor(fixture),
    );

    // Não saber se existe substituto NUNCA pode virar "dispensa a task": o
    // lado seguro é o retry limitado, que ainda pode re-consultar o roster.
    expect(outcome).toBe('retry');
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'running',
      integrationReceipt: undefined,
    });
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).toBe('running');
    // A sessão física morta continua sendo encerrada pela identidade exata.
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sem mecanismo de reroute instalado, o waiver continua sendo o último recurso', () => {
    const fixture = runningWorkerFixture();
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute: null,
    });

    // Ausência declarada do resolvedor não é falha de consulta: é a política
    // antiga (sem roster para consultar), e ela continua valendo.
    expect(handleMissionWorkerProviderNoRoute(authHitInputFor(fixture))).toBe(
      'waived',
    );
    const receipt = fixture.dispatches.get(fixture.task.id)?.integrationReceipt;
    expect(receipt?.kind).toBe('advisory_provider_unavailable');
    expect(receipt?.waiver?.reason).toContain('reroute não instalado');
  });
});

describe('reply guard do waiver: evidência, orçamento e reason explícito', () => {
  it('roster esgotado: o waiver grava reason durável de que a task nunca executou', () => {
    const fixture = runningWorkerFixture();
    const attemptLiveReroute = vi.fn(() => null);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    const outcome = handleMissionWorkerProviderNoRoute(
      authHitInputFor(fixture),
    );

    expect(outcome).toBe('waived');
    expect(attemptLiveReroute).toHaveBeenCalledTimes(1);
    const receipt = fixture.dispatches.get(fixture.task.id)?.integrationReceipt;
    expect(receipt?.kind).toBe('advisory_provider_unavailable');
    // Nada de done silencioso: o registro durável diz que a task nunca rodou
    // e por quê o roster não a resgatou.
    expect(receipt?.waiver?.reason).toContain('nunca executou');
    expect(receipt?.waiver?.reason).toContain('roster esgotado');
  });

  it('task com evidência de execução: caminho atual intocado — nem reroute nem waiver', () => {
    const fixture = runningWorkerFixture();
    // O worker PUBLICOU: handoff físico aceito ancorado ao dispatch exato.
    const handoffs = createScopedHandoffStore(fixture.runtime, fixture.scope);
    const handoff = handoffs.submit({
      missionId: fixture.mission.id,
      sessionId: fixture.sessionId,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      fromAgent: 'Advisor independente',
      status: 'success',
      summary: 'Análise publicada antes do provider morrer.',
    });
    insertPhysicalHandoffAuthority({
      runtime: fixture.runtime,
      scope: fixture.scope,
      missionId: fixture.mission.id,
      handoffId: handoff.id,
      sessionId: fixture.sessionId,
      workerIncarnationId: fixture.claim.workerIncarnationId,
    });
    fixture.dispatches.acceptHandoff({
      sessionId: fixture.sessionId,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    const attemptLiveReroute = vi.fn(() => rosterCandidate);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    const outcome = handleMissionWorkerProviderNoRoute(
      authHitInputFor(fixture),
    );

    // Evidência presente = o "reply" já foi publicado: o guard não intervém.
    // O retry limitado + a cadeia de entrega existente seguem donos do destino.
    expect(outcome).toBe('retry');
    expect(attemptLiveReroute).not.toHaveBeenCalled();
    const dispatch = fixture.dispatches.get(fixture.task.id);
    expect(dispatch?.state).toBe('handoff_ready');
    expect(dispatch?.handoffId).toBe(handoff.id);
    expect(dispatch?.integrationReceipt).toBeUndefined();
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).toBe('running');
    // "Intocado" nunca significou deixar a sessão morta viva: a CLI que levou
    // o hit de provider continua sendo encerrada pela identidade exata — é o
    // que o caminho anterior ao reply guard fazia e o que libera o slot de
    // maxWorkers para a recuperação limitada seguir.
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    // Sem tick do scheduler: a entrega em andamento é dona do destino.
    expect(driverMocks.requestMissionDriverTick).not.toHaveBeenCalled();
  });

  it('orçamento 1: dispatch já re-roteado nunca consulta o reroute de novo e o waiver nomeia o orçamento', () => {
    const fixture = runningWorkerFixture({ extraGlmAgent: true });
    // 1º hit real: diretiva durável commitada pelo coordenador (mecanismo da
    // 0.19.42) — o orçamento do guard para esta task fica consumido.
    const bound = fixture.dispatches.get(fixture.task.id)!;
    fixture.dispatches.rerouteLiveProviderDeadWorkerByCoordinator({
      taskId: fixture.task.id,
      revision: bound.revision,
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      directive: {
        version: 1,
        fromAgentRef: 'advisor',
        toAgentRef: 'advisor-glm',
        exhaustedAdapterIds: ['codex'],
        reason: 'codex morreu com 401 no primeiro spawn',
        reroutedAt: Date.now(),
      },
      note: '[NEXUS_PROVIDER_REROUTE] codex 401; re-roteado para Advisor GLM',
    });
    // O substituto reclama a task (claim honra a diretiva) e sobe fisicamente.
    // O lease do reroute expira em +1s; um relógio adiantado dispensa sleep.
    const futureDispatches = createTaskDispatchStore(
      fixture.runtime,
      fixture.scope,
      { now: () => Date.now() + 5_000 },
    );
    const claim2 = futureDispatches.claim({
      missionId: fixture.mission.id,
      taskId: fixture.task.id,
      intentVersion: 4,
      workerId: 'Advisor GLM',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: fixture.ownership,
      executionMode: fixture.executionMode,
      agentRef: 'advisor-glm',
      agentCategory: fixture.agentCategory,
      rosterHash: fixture.planReceipt.rosterHash,
      routeContract: { adapterId: 'glm', model: 'glm-4.7', effort: 'high' },
    });
    const route2 = fixture.missions.reserveRouteDecision(
      fixture.mission.id,
      fixture.task.title,
      {
        tier: 'hard',
        adapterId: 'glm',
        model: 'glm-4.7',
        effort: 'high',
        reason: 'rota do substituto do roster',
        alternatives: [],
      },
    );
    const routed2 = futureDispatches.attachRoute({
      taskId: fixture.task.id,
      revision: claim2.revision,
      leaseToken: claim2.leaseToken,
      routeReservationId: route2.id,
      adapterId: 'glm',
      model: 'glm-4.7',
      effort: 'high',
    });
    fixture.missions.consumeRouteReservation(
      {
        reservationId: route2.id,
        missionId: fixture.mission.id,
        adapterId: 'glm',
        model: 'glm-4.7',
        effort: 'high',
      },
      `dispatch:${claim2.id}`,
    );
    futureDispatches.bindSpawn({
      taskId: fixture.task.id,
      revision: routed2.revision,
      leaseToken: claim2.leaseToken,
      workerIncarnationId: claim2.workerIncarnationId,
      paneId: 'pane-substituto',
      sessionId: 'session-substituto',
    });
    const attemptLiveReroute = vi.fn(() => rosterCandidate);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    // 2º hit de provider, agora no substituto: orçamento 1 já foi gasto.
    const outcome = handleMissionWorkerProviderNoRoute({
      scope: fixture.scope,
      missionId: fixture.mission.id,
      paneId: 'pane-substituto',
      sessionId: 'session-substituto',
      workerIncarnationId: claim2.workerIncarnationId,
      adapterId: 'glm',
      hit: {
        kind: 'auth' as const,
        reason: 'Error: 401 token do substituto também revogado',
        cooldownMs: 60_000,
      },
    });

    expect(attemptLiveReroute).not.toHaveBeenCalled();
    expect(outcome).toBe('waived');
    const receipt = fixture.dispatches.get(fixture.task.id)?.integrationReceipt;
    expect(receipt?.kind).toBe('advisory_provider_unavailable');
    expect(receipt?.waiver?.reason).toContain('nunca executou');
    expect(receipt?.waiver?.reason).toContain('orçamento');
  });

  it('diretiva emitida pelo SWEEP de esgotamento não consome o orçamento do guard', () => {
    const fixture = runningWorkerFixture({ extraGlmAgent: true });
    // O sweep de esgotamento físico (mission-scheduler-reconciliation) grava a
    // MESMA coluna durável. Ela prova que o coordenador re-roteou — nunca que
    // este guard já teve sua chance de correção.
    fixture.runtime
      .open(fixture.scope)
      .db.prepare(
        `UPDATE task_dispatch_queue SET provider_reroute_json = ?
          WHERE task_id = ?`,
      )
      .run(
        JSON.stringify({
          version: 1,
          fromAgentRef: 'advisor',
          toAgentRef: 'advisor-glm',
          exhaustedAdapterIds: ['claude'],
          reason: 'claude esgotou o spawn físico; sweep re-roteou',
          reroutedAt: Date.now(),
          emittedBy: 'exhaustion-sweep',
        }),
        fixture.task.id,
      );
    const attemptLiveReroute = vi.fn(() => rosterCandidate);
    configureProviderFailureWaiver({
      runtimeManager: fixture.runtime,
      attemptLiveReroute,
    });

    const outcome = handleMissionWorkerProviderNoRoute(
      authHitInputFor(fixture),
    );

    // O guard ainda tem a sua única chance: consulta o roster e re-rota.
    expect(attemptLiveReroute).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('rerouted');
    expect(fixture.dispatches.get(fixture.task.id)?.integrationReceipt).toBe(
      undefined,
    );
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).not.toBe('done');
  });
});

describe('providerWaiverNeverExecutedReason', () => {
  it('nomeia causa, CLI e o desfecho da consulta ao roster', () => {
    const exhausted = providerWaiverNeverExecutedReason({
      hitKind: 'auth',
      adapterId: 'claude',
      rosterConsult: 'exhausted',
    });
    expect(exhausted).toContain('nunca executou');
    expect(exhausted).toContain('claude');
    expect(exhausted).toContain('roster esgotado');

    const budget = providerWaiverNeverExecutedReason({
      hitKind: 'auth',
      adapterId: 'glm',
      rosterConsult: 'budget-spent',
    });
    expect(budget).toContain('orçamento');

    // O reason descreve o que DE FATO aconteceu: a task está sendo dispensada
    // agora, então prometer "espera-pela-irmã" seria mentir no registro
    // durável. O que a consulta não fez foi olhar o roster — e o motivo é o
    // kind curto, fora do conjunto durável que autoriza substituição.
    const shortWindow = providerWaiverNeverExecutedReason({
      hitKind: 'rate-limit',
      adapterId: 'codex',
      rosterConsult: 'not-consulted',
    });
    expect(shortWindow).not.toContain('espera-pela-irmã');
    expect(shortWindow).toContain('falha curta');
    expect(shortWindow).toContain('auth/quota');
  });

  it('nunca estoura o orçamento durável do reason', () => {
    const reason = providerWaiverNeverExecutedReason({
      hitKind: 'transient',
      adapterId: 'x'.repeat(4_000),
      rosterConsult: 'not-installed',
    });
    expect(reason.length).toBeLessThanOrEqual(2_000);
  });
});

describe('providerWaiverLearning', () => {
  it('states plainly that the task did not run, and names the CLI', () => {
    const learning = providerWaiverLearning({
      taskTitle: 'Mapear com E2E Advisor Claude',
      adapterId: 'claude',
      hitKind: 'auth',
    });

    expect(learning).toContain('Mapear com E2E Advisor Claude');
    expect(learning).toContain('**não foi executada**');
    expect(learning).toContain('claude');
    expect(learning).toContain('a credencial expirou ou foi revogada');
  });

  it('only prescribes a new login when the cause is authentication', () => {
    const auth = providerWaiverLearning({
      taskTitle: 'Mapear',
      adapterId: 'claude',
      hitKind: 'auth',
    });
    const quota = providerWaiverLearning({
      taskTitle: 'Mapear',
      adapterId: 'codex',
      hitKind: 'quota',
    });

    expect(auth).toContain('Refaça o login');
    // Cota esgotada não se resolve com login: prescrever isso mandaria o
    // operador para o caminho errado.
    expect(quota).not.toContain('Refaça o login');
    expect(quota).toContain('a cota do provider acabou');
  });

  it('never lets a long task title blow the durable learning budget', () => {
    const learning = providerWaiverLearning({
      taskTitle: 'x'.repeat(8_000),
      adapterId: 'grok',
      hitKind: 'transient',
    });

    expect(learning.length).toBeLessThanOrEqual(4_000);
  });
});

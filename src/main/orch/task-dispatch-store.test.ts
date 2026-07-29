import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { compileIntentContract, hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';
import {
  createTaskDispatchStore,
  TASK_DISPATCH_QUALITY_REPAIR_MARKER,
} from './task-dispatch-store';
import { EMPTY_GIT_DIFF_SHA256 } from './task-dispatch-codec';
import {
  TASK_DISPATCH_BLOCK_MARKER,
  TASK_DISPATCH_SESSION_EXIT_REASON,
} from './task-dispatch-persistence';
import { createScopedHandoffStore } from './handoff-store';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';
import { compileMissionContract } from '../context/contract-compiler';
import { createContextWorkflowStore } from '../context/context-workflow-store';
import { createWorkflowState } from '../context/prevc-engine';
import { ReviewCouncil } from '../context/review-council';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];
let physicalReceiptSequence = 0;

function repositoryHead(): string {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.19.27-test',
  });
  managers.push(value);
  return value;
}

function insertPhysicalHandoffAuthority(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly handoffId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly source?: 'http-mcp' | 'pty-stream';
  readonly worktreeHeadSha?: string;
  readonly receiptId?: string;
}): string {
  const db = input.runtime.open(input.scope).db;
  const handoff = db
    .prepare(`SELECT created_at FROM handoffs WHERE id = ?`)
    .get(input.handoffId) as { created_at: number };
  const receiptId = input.receiptId ?? `physical-task-${++physicalReceiptSequence}`;
  const source = input.source ?? 'http-mcp';
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
      source,
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
     VALUES (?, ?, ?, 'nexus_handoff_submit', ?,
             ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    input.handoffId,
    receiptId,
    source,
    input.missionId,
    input.sessionId,
    input.workerIncarnationId,
    createHash('sha256').update(receiptId).digest('hex'),
    input.worktreeHeadSha ?? null,
    handoff.created_at,
  );
  return receiptId;
}

function seedIntegratedQualityAuthority(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly headSha: string;
  readonly label: string;
}): readonly string[] {
  const qualityContract = compileMissionContract(
    {
      schemaVersion: 1,
      scope: input.scope,
      missionId: input.missionId,
      baseCommit: input.headSha,
      contextRevision: createHash('sha256')
        .update(`context:${input.label}`)
        .digest('hex'),
      goal: `Validar integração ${input.label}`,
      acceptanceCriteria: [
        {
          id: 'quality-green',
          statement: 'A revisão independente aprovou o candidato integrado.',
        },
      ],
    },
    {
      invariantRefs: new Set(),
      availableSensorIds: new Set(),
      blockingConflictIds: [],
    },
  );
  const binding = {
    projectId: input.scope.projectId,
    checkoutId: input.scope.checkoutId,
    missionId: input.missionId,
    contractHash: qualityContract.contractHash,
    contextHash: qualityContract.contextRevision,
    baseSha: input.headSha,
    headSha: input.headSha,
    diffHash: EMPTY_GIT_DIFF_SHA256,
  };
  const store = createContextWorkflowStore(input.runtime, input.scope);
  store.freeze(
    qualityContract,
    createWorkflowState(qualityContract.risk, binding),
    {
      id: `author-${input.label}`,
      sessionId: `session-author-${input.label}`,
      provider: 'codex',
    },
  );
  const reviewId = `integrated-${input.label}`;
  const review = new ReviewCouncil(qualityContract.risk, binding).submit({
    reviewId,
    reviewerId: `reviewer-${input.label}`,
    reviewerSessionId: `session-reviewer-${input.label}`,
    reviewerProvider: 'codex',
    authorId: `author-${input.label}`,
    authorSessionId: `session-author-${input.label}`,
    authorProvider: 'codex',
    binding,
    findings: [],
  });
  store.recordMergeReviewReport(review);
  return Object.freeze([`review:${reviewId}`]);
}

function mergingDispatchFixture() {
  const runtime = manager();
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: 'Projetar falha terminal de merge',
    intentVersion: 1,
  });
  const mission = missions.create({
    title: 'Merge terminal',
    intentVersion: 1,
    intentState: 'executing',
    intentContract: contract,
  });
  missions.setStatus(mission.id, 'running');
  const task = tasks.create({
    missionId: mission.id,
    title: 'Integrar candidato',
  });
  const route = missions.reserveRouteDecision(mission.id, task.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'rota selada para o merge terminal',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task.id,
    intentVersion: 1,
    workerId: 'worker-merge-terminal',
    leaseOwner: 'main',
    leaseMs: 30_000,
    executionMode: 'isolated_worktree',
  });
  const routed = dispatches.attachRoute({
    taskId: task.id,
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
    taskId: task.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    workerIncarnationId: claim.workerIncarnationId,
    paneId: 'pane-merge-terminal',
    sessionId: 'session-merge-terminal',
  });
  const handoff = handoffs.submit({
    missionId: mission.id,
    sessionId: 'session-merge-terminal',
    workerIncarnationId: claim.workerIncarnationId,
    fromAgent: 'worker-merge-terminal',
    status: 'success',
    summary: 'Candidato entregue com commit local para validação do coordenador.',
  });
  insertPhysicalHandoffAuthority({
    runtime,
    scope,
    missionId: mission.id,
    handoffId: handoff.id,
    sessionId: 'session-merge-terminal',
    workerIncarnationId: claim.workerIncarnationId,
  });
  const ready = dispatches.acceptHandoff({
    sessionId: 'session-merge-terminal',
    workerIncarnationId: claim.workerIncarnationId,
    handoffId: handoff.id,
  });
  const merging = dispatches.beginMerge({
    taskId: task.id,
    revision: ready.revision,
  });
  return {
    runtime,
    scope,
    missions,
    tasks,
    dispatches,
    mission,
    task,
    merging,
  };
}

function claimedDispatchFixture() {
  const runtime = manager();
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: 'Recuperar reserva interrompida de worktree',
    intentVersion: 1,
  });
  const mission = missions.create({
    title: 'Reserva interrompida',
    intentVersion: 1,
    intentState: 'executing',
    intentContract: contract,
  });
  missions.setStatus(mission.id, 'running');
  const task = tasks.create({
    missionId: mission.id,
    title: 'Materializar worktree',
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task.id,
    intentVersion: 1,
    workerId: 'worker-reserved-crash',
    leaseOwner: 'main',
    leaseMs: 30_000,
    executionMode: 'isolated_worktree',
  });
  return { missions, tasks, dispatches, mission, task, claim };
}

/**
 * Full golden path up to a completable state: sealed plan + route reservation
 * + spawn bind + success handoff accepted + worktree integration receipt +
 * delivery attempt accepted by the exact orchestrator session.
 */
function verifiedPlanFixture(
  label: string,
  options: {
    domains?: readonly string[];
    squadId?: string;
  } = {},
) {
  const runtime = manager();
  const scope = testProjectScope({ rootRealPath: process.cwd() });
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: `Completar pelo motor (${label})`,
    intentVersion: 7,
  });
  const squadId = options.squadId ?? 'golden-squad';
  const mission = missions.create({
    title: `Golden path ${label}`,
    squadId,
    intentVersion: 7,
    intentState: 'executing',
    intentContract: contract,
    orchestratorSessionId: 'orchestrator-golden',
  });
  missions.setStatus(mission.id, 'running');
  const ownership = {
    files: ['src/golden.ts'],
    symbols: [],
    domains: [...(options.domains ?? [])],
  };
  const [task] = tasks.createPlanAtomically({
    missionId: mission.id,
    intentVersion: 7,
    squad: {
      id: squadId,
      agents: [
        {
          id: 'worker',
          agentName: 'Golden Worker',
          category: 'executor',
          cli: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
      ],
    },
    rows: [
      {
        plannerId: 'implement',
        title: 'Implementar golden path',
        detail: encodeTaskScheduleDetail('Implementar e testar.', {
          dependsOn: [],
          ownership,
          merged: false,
          agentRef: 'worker',
          agentCategory: 'executor',
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'worker',
        agentCategory: 'executor',
      },
    ],
  });
  const receipt = tasks.getPlanReceipt(mission.id, 7)!;
  const route = missions.reserveRouteDecision(mission.id, task!.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'roster selado',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task!.id,
    intentVersion: 7,
    workerId: 'Golden Worker',
    leaseOwner: 'main',
    leaseMs: 30_000,
    ownership,
    executionMode: 'isolated_worktree',
    agentRef: 'worker',
    agentCategory: 'executor',
    rosterHash: receipt.rosterHash,
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
    paneId: 'pane-golden',
    sessionId: 'session-golden',
  });
  const handoff = handoffs.submit({
    missionId: mission.id,
    sessionId: 'session-golden',
    workerIncarnationId: claim.workerIncarnationId,
    fromAgent: 'Golden Worker',
    status: 'success',
    summary: 'Implementação integrada com testes e commit local verificados.',
  });
  insertPhysicalHandoffAuthority({
    runtime,
    scope,
    missionId: mission.id,
    handoffId: handoff.id,
    sessionId: 'session-golden',
    workerIncarnationId: claim.workerIncarnationId,
    worktreeHeadSha: repositoryHead(),
  });
  const ready = dispatches.acceptHandoff({
    sessionId: 'session-golden',
    workerIncarnationId: claim.workerIncarnationId,
    handoffId: handoff.id,
  });
  const integratedHeadSha = repositoryHead();
  const qualityEvidenceIds = seedIntegratedQualityAuthority({
    runtime,
    scope,
    missionId: mission.id,
    headSha: integratedHeadSha,
    label,
  });
  dispatches.completeByCoordinator({
    taskId: task!.id,
    revision: ready.revision,
    receipt: {
      kind: 'worktree_integrated',
      reference: integratedHeadSha,
      completedAt: Date.now(),
      evidenceIds: [...qualityEvidenceIds],
    },
  });
  const attempt = handoffs.reserveDeliveryAttempt({
    handoffId: handoff.id,
    missionId: mission.id,
    orchestratorSessionId: 'orchestrator-golden',
    maxAttempts: 2,
  });
  handoffs.markDeliveryAttemptPasted({
    attemptId: attempt.id,
    handoffId: handoff.id,
    acceptDeadlineAt: Date.now() + 10_000,
  });
  handoffs.acceptDeliveryAttempt({
    attemptId: attempt.id,
    handoffId: handoff.id,
  });
  handoffs.markConsumedAfterAcceptedDelivery(handoff.id, mission.id, 'orchestrator-golden');
  return {
    runtime,
    scope,
    missions,
    tasks,
    handoffs,
    dispatches,
    mission,
    task: task!,
    handoff,
  };
}

function guidedNoChangeDispatchFixture(
  options: {
    agentCategory?: 'executor' | 'reviewer';
    domains?: readonly string[];
    agentModel?: string;
    routeModel?: string;
  } = {},
) {
  const runtime = manager();
  const scope = testProjectScope({ rootRealPath: process.cwd() });
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const agentCategory = options.agentCategory ?? 'reviewer';
  const routeModel = options.routeModel ?? 'gpt-5.6-sol';
  const ownership = {
    files: ['src'],
    symbols: [],
    domains: [...(options.domains ?? ['guided-quality-gate', 'sequential-only'])],
  };
  const contract = approvedIntentContract({
    goal: 'Validar a entrega guiada sem fabricar alteração',
    intentVersion: 3,
  });
  const mission = missions.create({
    title: 'QA guiado',
    squadId: 'agentic-guided-squad',
    intentVersion: 3,
    intentState: 'executing',
    intentContract: contract,
  });
  missions.setStatus(mission.id, 'running');
  const qualityHeadSha = repositoryHead();
  const qualityDiffHash = EMPTY_GIT_DIFF_SHA256;
  const qualityContract = compileMissionContract(
    {
      schemaVersion: 1,
      scope,
      missionId: mission.id,
      baseCommit: qualityHeadSha,
      contextRevision: 'c'.repeat(64),
      goal: 'Validar entrega local',
      acceptanceCriteria: [
        {
          id: 'quality-green',
          statement: 'O typecheck e a revisão independente permanecem verdes.',
          requiredSensorIds: ['typecheck'],
        },
      ],
    },
    {
      invariantRefs: new Set(),
      availableSensorIds: new Set(['typecheck']),
      blockingConflictIds: [],
    },
  );
  const qualityBinding = {
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId: mission.id,
    contractHash: qualityContract.contractHash,
    contextHash: qualityContract.contextRevision,
    baseSha: qualityHeadSha,
    headSha: qualityHeadSha,
    diffHash: qualityDiffHash,
  };
  const qualityStore = createContextWorkflowStore(runtime, scope);
  qualityStore.freeze(
    qualityContract,
    createWorkflowState(qualityContract.risk, qualityBinding),
    {
      id: 'author-implementation',
      sessionId: 'session-author-implementation',
      provider: 'codex',
    },
  );
  qualityStore.recordMergeSensorEvidence({
    id: 'sensor:typecheck',
    producer: 'nexus',
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId: mission.id,
    sensorId: 'typecheck',
    baseSha: qualityBinding.baseSha,
    headSha: qualityBinding.headSha,
    diffHash: qualityBinding.diffHash,
    contextHash: qualityBinding.contextHash,
    contractHash: qualityBinding.contractHash,
    sensorConfigHash: 'f'.repeat(64),
    command: ['npm', 'run', 'typecheck'],
    exitCode: 0,
    stdoutHash: '1'.repeat(64),
    stderrHash: '2'.repeat(64),
    timedOut: false,
    truncated: false,
    startedAt: '2026-07-28T12:00:00.000Z',
    finishedAt: '2026-07-28T12:00:01.000Z',
  });
  const review = new ReviewCouncil(qualityContract.risk, qualityBinding).submit({
    reviewId: 'independent',
    reviewerId: 'reviewer-independent',
    reviewerSessionId: 'session-reviewer-independent',
    reviewerProvider: 'codex',
    authorId: 'author-implementation',
    authorSessionId: 'session-author-implementation',
    authorProvider: 'codex',
    binding: qualityBinding,
    findings: [],
  });
  qualityStore.recordMergeReviewReport(review);
  const [task] = tasks.createPlanAtomically({
    missionId: mission.id,
    intentVersion: 3,
    squad: {
      id: 'agentic-guided-squad',
      agents: [
        {
          id: 'qa',
          agentName: 'QA independente',
          category: agentCategory,
          cli: 'codex',
          ...(options.agentModel ? { model: options.agentModel } : {}),
          effort: 'high',
        },
      ],
    },
    rows: [
      {
        plannerId: 'guided-quality-gate',
        title: 'Validar entrega',
        detail: encodeTaskScheduleDetail('Validar sem fabricar diff.', {
          dependsOn: [],
          ownership,
          merged: false,
          agentRef: 'qa',
          agentCategory,
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'qa',
        agentCategory,
      },
    ],
  });
  const planReceipt = tasks.getPlanReceipt(mission.id, 3)!;
  const route = missions.reserveRouteDecision(mission.id, task!.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: routeModel,
    effort: 'high',
    reason: 'rota selada para QA independente',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task!.id,
    intentVersion: 3,
    workerId: 'QA independente',
    leaseOwner: 'main',
    leaseMs: 30_000,
    ownership,
    executionMode: 'isolated_worktree',
    agentRef: 'qa',
    agentCategory,
    rosterHash: planReceipt.rosterHash,
    routeContract: {
      adapterId: 'codex',
      model: routeModel,
      effort: 'high',
    },
  });
  const routed = dispatches.attachRoute({
    taskId: task!.id,
    revision: claim.revision,
    leaseToken: claim.leaseToken,
    routeReservationId: route.id,
    adapterId: 'codex',
    model: routeModel,
    effort: 'high',
  });
  missions.consumeRouteReservation(
    {
      reservationId: route.id,
      missionId: mission.id,
      adapterId: 'codex',
      model: routeModel,
      effort: 'high',
    },
    `dispatch:${claim.id}`,
  );
  dispatches.bindSpawn({
    taskId: task!.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    workerIncarnationId: claim.workerIncarnationId,
    paneId: 'pane-guided-qa',
    sessionId: 'session-guided-qa',
  });
  const handoff = handoffs.submit({
    missionId: mission.id,
    sessionId: 'session-guided-qa',
    workerIncarnationId: claim.workerIncarnationId,
    fromAgent: 'QA independente',
    status: 'success',
    summary: 'Todos os critérios e checks permaneceram verdes sem correção.',
  });
  insertPhysicalHandoffAuthority({
    runtime,
    scope,
    missionId: mission.id,
    handoffId: handoff.id,
    sessionId: 'session-guided-qa',
    workerIncarnationId: claim.workerIncarnationId,
    worktreeHeadSha: repositoryHead(),
  });
  const ready = dispatches.acceptHandoff({
    sessionId: 'session-guided-qa',
    workerIncarnationId: claim.workerIncarnationId,
    handoffId: handoff.id,
  });
  return { runtime, scope, dispatches, task: task!, ready };
}

function readOnlyPhysicalHandoffFixture(
  options: {
    executionMode?: 'read_only' | 'isolated_worktree';
    worktreeHeadSha?: string;
  } = {},
) {
  const runtime = manager();
  const scope = testProjectScope({ rootRealPath: process.cwd() });
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const executionMode = options.executionMode ?? 'read_only';
  const ownership = {
    files: ['src'],
    symbols: [],
    domains: [
      executionMode === 'read_only' ? 'guided-advisory' : 'guided-isolated-advisory',
      'sequential-only',
    ],
  };
  const contract = approvedIntentContract({
    goal: 'Mapear riscos antes da execução principal',
    intentVersion: 4,
  });
  const mission = missions.create({
    title: 'Advisory guiado',
    squadId: 'agentic-guided-squad',
    intentVersion: 4,
    intentState: 'executing',
    intentContract: contract,
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
          category: 'architect',
          cli: 'codex',
          effort: 'high',
        },
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
          agentCategory: 'architect',
          executionMode,
        }),
        agentRef: 'advisor',
        agentCategory: 'architect',
      },
    ],
  });
  const planReceipt = tasks.getPlanReceipt(mission.id, 4)!;
  const route = missions.reserveRouteDecision(mission.id, task!.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'rota selada para advisory',
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
    agentCategory: 'architect',
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
    paneId: 'pane-guided-advisor',
    sessionId: 'session-guided-advisor',
  });
  const handoff = handoffs.submit({
    missionId: mission.id,
    sessionId: 'session-guided-advisor',
    workerIncarnationId: claim.workerIncarnationId,
    fromAgent: 'Advisor independente',
    status: 'success',
    summary: 'Mapeamento concluído sem mutação.',
  });
  const physicalReceiptId = insertPhysicalHandoffAuthority({
    runtime,
    scope,
    missionId: mission.id,
    handoffId: handoff.id,
    sessionId: 'session-guided-advisor',
    workerIncarnationId: claim.workerIncarnationId,
    source: options.executionMode === 'isolated_worktree' ? 'pty-stream' : 'http-mcp',
    worktreeHeadSha: options.worktreeHeadSha ?? repositoryHead(),
    receiptId: `${
      options.executionMode === 'isolated_worktree'
        ? 'tool-call-guided-isolated-advisor'
        : 'tool-call-guided-advisor'
    }-${++physicalReceiptSequence}`,
  });
  const ready = dispatches.acceptHandoff({
    sessionId: 'session-guided-advisor',
    workerIncarnationId: claim.workerIncarnationId,
    handoffId: handoff.id,
  });
  return {
    runtime,
    scope,
    dispatches,
    mission,
    task: task!,
    handoff,
    claim,
    physicalReceiptId,
    ready,
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-dispatch-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('durable task dispatcher authority', () => {
  it('completes a guided read-only identity only from its exact physical handoff', () => {
    const missing = readOnlyPhysicalHandoffFixture();

    missing.runtime
      .open(missing.scope)
      .db.prepare(`DELETE FROM handoff_mcp_receipts WHERE handoff_id = ?`)
      .run(missing.handoff.id);
    expect(() =>
      missing.dispatches.completeReadOnlyFromTrustedHandoff({
        taskId: missing.task.id,
        revision: missing.ready.revision,
      }),
    ).toThrow(/physical|receipt|recibo/i);
    expect(missing.dispatches.get(missing.task.id)?.state).toBe('handoff_ready');
    missing.dispatches.blockUnvalidatedByCoordinator({
      taskId: missing.task.id,
      revision: missing.ready.revision,
      reason: 'Recibo físico removido durante o teste de corrupção.',
    });

    const fixture = readOnlyPhysicalHandoffFixture();
    const completed = fixture.dispatches.completeReadOnlyFromTrustedHandoff({
      taskId: fixture.task.id,
      revision: fixture.ready.revision,
    });
    expect(completed).toMatchObject({
      state: 'completed',
      integrationReceipt: {
        kind: 'read_only_validated',
        evidenceIds: [fixture.physicalReceiptId],
      },
    });
  });

  it('completes an isolated advisory from the exact physical HEAD without bypassing PREVC', () => {
    const headSha = repositoryHead();
    const fixture = readOnlyPhysicalHandoffFixture({
      executionMode: 'isolated_worktree',
      worktreeHeadSha: headSha,
    });
    const diffHash = EMPTY_GIT_DIFF_SHA256;
    const merging = fixture.dispatches.beginMerge({
      taskId: fixture.task.id,
      revision: fixture.ready.revision,
    });

    expect(() =>
      fixture.dispatches.completeIsolatedAdvisoryFromPhysicalHandoff({
        taskId: fixture.task.id,
        revision: merging.revision,
        reference: `advisory-no-change:${headSha}:${'e'.repeat(64)}`,
      }),
    ).toThrow(/hash canônico.*diff vazio/i);
    expect(() =>
      fixture.dispatches.completeIsolatedAdvisoryFromPhysicalHandoff({
        taskId: fixture.task.id,
        revision: merging.revision,
        reference: `advisory-no-change:${'c'.repeat(40)}:${diffHash}`,
      }),
    ).toThrow(/no-change|physical|HEAD/i);
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('merging');

    expect(() =>
      fixture.dispatches.completeByCoordinator({
        taskId: fixture.task.id,
        revision: merging.revision,
        receipt: {
          kind: 'isolated_advisory_validated',
          reference: `advisory-no-change:${headSha}:${diffHash}`,
          completedAt: Date.now(),
          evidenceIds: [fixture.physicalReceiptId],
        },
      }),
    ).toThrow(/inválido.*isolated_worktree/i);

    const completed = fixture.dispatches.completeIsolatedAdvisoryFromPhysicalHandoff({
      taskId: fixture.task.id,
      revision: merging.revision,
      reference: `advisory-no-change:${headSha}:${diffHash}`,
    });
    expect(completed).toMatchObject({
      state: 'completed',
      integrationReceipt: {
        kind: 'isolated_advisory_validated',
        reference: `advisory-no-change:${headSha}:${diffHash}`,
        evidenceIds: [fixture.physicalReceiptId],
      },
    });

    const deliveryStore = createScopedHandoffStore(fixture.runtime, fixture.scope);
    const attempt = deliveryStore.reserveDeliveryAttempt({
      handoffId: fixture.handoff.id,
      missionId: fixture.mission.id,
      orchestratorSessionId: 'orchestrator-guided-advisor',
      maxAttempts: 2,
    });
    deliveryStore.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: fixture.handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      deliveryStore.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: fixture.handoff.id,
      }),
    ).toBe(true);
    expect(
      deliveryStore.markConsumedAfterAcceptedDelivery(
        fixture.handoff.id,
        fixture.mission.id,
        'orchestrator-guided-advisor',
      ),
    ).toBe(true);
    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
    expect(
      createScopedMissionStore(fixture.runtime, fixture.scope).get(fixture.mission.id),
    ).toMatchObject({ status: 'running', intentState: 'executing' });
  });

  it('rejects an isolated advisory receipt whose physical HEAD differs', () => {
    const physicalHead = repositoryHead();
    const fixture = readOnlyPhysicalHandoffFixture({
      executionMode: 'isolated_worktree',
      worktreeHeadSha: physicalHead,
    });
    const merging = fixture.dispatches.beginMerge({
      taskId: fixture.task.id,
      revision: fixture.ready.revision,
    });

    expect(() =>
      fixture.dispatches.completeIsolatedAdvisoryFromPhysicalHandoff({
        taskId: fixture.task.id,
        revision: merging.revision,
        reference: `advisory-no-change:${'c'.repeat(40)}:${EMPTY_GIT_DIFF_SHA256}`,
      }),
    ).toThrow(/no-change|physical|HEAD/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'merging',
      integrationReceipt: undefined,
    });
  });

  it('accepts the no-change receipt only for the sealed guided reviewer with evidence', () => {
    const { dispatches, task, ready } = guidedNoChangeDispatchFixture();
    const headSha = repositoryHead();
    const diffHash = EMPTY_GIT_DIFF_SHA256;

    const completed = dispatches.completeByCoordinator({
      taskId: task.id,
      revision: ready.revision,
      receipt: {
        kind: 'worktree_validated_no_change',
        reference: `no-change:${headSha}:${diffHash}`,
        completedAt: Date.now(),
        evidenceIds: ['sensor:typecheck', 'review:independent'],
      },
    });

    expect(completed).toMatchObject({
      state: 'completed',
      integrationReceipt: {
        kind: 'worktree_validated_no_change',
        reference: `no-change:${headSha}:${diffHash}`,
        evidenceIds: ['sensor:typecheck', 'review:independent'],
        qualityProof: {
          projectId: expect.any(String),
          checkoutId: expect.any(String),
          missionId: expect.any(String),
          contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          baseSha: headSha,
          workerHeadSha: headSha,
          headSha,
          integrationHeadSha: headSha,
          diffHash,
          workflowRevision: 1,
          sensorEvidenceIds: ['sensor:typecheck'],
          reviewEvidenceIds: ['review:independent'],
          reviewerIds: ['reviewer-independent'],
          advisories: [],
        },
      },
    });
  });

  it('rejects a QA receipt whose sensor/review labels have no bound PREVC evidence', () => {
    const { dispatches, task, ready } = guidedNoChangeDispatchFixture();

    expect(() =>
      dispatches.completeByCoordinator({
        taskId: task.id,
        revision: ready.revision,
        receipt: {
          kind: 'worktree_validated_no_change',
          reference: `no-change:${repositoryHead()}:${'e'.repeat(64)}`,
          completedAt: Date.now(),
          evidenceIds: ['sensor:invented', 'review:invented'],
        },
      }),
    ).toThrow(/quality|sensor|review|evidence|evidência/i);
    expect(dispatches.get(task.id)).toMatchObject({
      state: 'handoff_ready',
      integrationReceipt: undefined,
    });
  });

  it('completes a sealed model family through its exact release-pinned routed variant', () => {
    const { dispatches, task, ready } = guidedNoChangeDispatchFixture({
      agentModel: 'gpt-5.6',
      routeModel: 'gpt-5.6-sol',
    });

    const completed = dispatches.completeByCoordinator({
      taskId: task.id,
      revision: ready.revision,
      receipt: {
        kind: 'worktree_validated_no_change',
        reference: `no-change:${repositoryHead()}:${EMPTY_GIT_DIFF_SHA256}`,
        completedAt: Date.now(),
        evidenceIds: ['sensor:typecheck', 'review:independent'],
      },
    });

    expect(completed).toMatchObject({
      state: 'completed',
      integrationReceipt: {
        kind: 'worktree_validated_no_change',
      },
    });
  });

  it('rejects completion when the live route projection diverges from the sealed roster and consumed reservation', () => {
    const fixture = guidedNoChangeDispatchFixture();
    const db = fixture.runtime.open(fixture.scope).db;
    db.prepare(`UPDATE task_dispatch_queue SET model = ? WHERE task_id = ?`).run(
      'tampered-model',
      fixture.task.id,
    );

    expect(() =>
      fixture.dispatches.completeByCoordinator({
        taskId: fixture.task.id,
        revision: fixture.ready.revision,
        receipt: {
          kind: 'worktree_validated_no_change',
          reference: `no-change:${repositoryHead()}:${'e'.repeat(64)}`,
          completedAt: Date.now(),
          evidenceIds: ['sensor:typecheck', 'review:independent'],
        },
      }),
    ).toThrow(/sealed task route authority/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'handoff_ready',
      integrationReceipt: undefined,
    });
  });

  it('rejects an arbitrary suffix that only prefix-matches the sealed model family', () => {
    expect(() =>
      guidedNoChangeDispatchFixture({
        agentModel: 'gpt-5.6',
        routeModel: 'gpt-5.6-malicious',
      }),
    ).toThrow(/modelo diverge da família do roster selado/i);
  });

  it.each([
    {
      label: 'executor',
      fixture: {
        agentCategory: 'executor' as const,
      },
      evidenceIds: ['sensor:typecheck', 'review:independent'],
      reference: `no-change:${'a'.repeat(40)}:${'e'.repeat(64)}`,
    },
    {
      label: 'reviewer sem domínio guiado',
      fixture: {
        agentCategory: 'reviewer' as const,
        domains: ['sequential-only'],
      },
      evidenceIds: ['sensor:typecheck', 'review:independent'],
      reference: `no-change:${'a'.repeat(40)}:${'e'.repeat(64)}`,
    },
    {
      label: 'reviewer sem evidência',
      fixture: {
        agentCategory: 'reviewer' as const,
      },
      evidenceIds: [],
      reference: `no-change:${'a'.repeat(40)}:${'e'.repeat(64)}`,
    },
    {
      label: 'reviewer com referência não física',
      fixture: {
        agentCategory: 'reviewer' as const,
      },
      evidenceIds: ['sensor:typecheck', 'review:independent'],
      reference: 'handoff-only',
    },
  ])('rejects a no-change receipt from $label', ({ fixture, evidenceIds, reference }) => {
    const { dispatches, task, ready } = guidedNoChangeDispatchFixture(fixture);

    expect(() =>
      dispatches.completeByCoordinator({
        taskId: task.id,
        revision: ready.revision,
        receipt: {
          kind: 'worktree_validated_no_change',
          reference,
          completedAt: Date.now(),
          evidenceIds,
        },
      }),
    ).toThrow(/no-change|inválido|evidência|scheduler contract/i);
    expect(dispatches.get(task.id)).toMatchObject({
      state: 'handoff_ready',
      integrationReceipt: undefined,
    });
  });

  it('projects a failed interrupted worktree reservation immediately with one PT-BR CTA', () => {
    const { missions, tasks, dispatches, mission, task, claim } = claimedDispatchFixture();

    const blocked = dispatches.blockWorktreeCreationFailureByCoordinator({
      taskId: task.id,
      revision: claim.revision,
      reason:
        'A reserva persistiu, mas o worktree materializado não provou identidade exata após restart.',
    });

    expect(blocked).toMatchObject({
      state: 'blocked',
      integrationReceipt: undefined,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.status).toBe('blocked');
    expect(blockedMission.description.match(/NEXUS_TASK_DISPATCH_BLOCKED/g)).toHaveLength(1);
    expect(blockedMission.description.match(/Clique em “Retomar missão”/g)).toHaveLength(1);
  });

  it('projects a terminal runtime merge failure to dispatch, task and one PT-BR CTA', () => {
    const { missions, tasks, dispatches, mission, task, merging } = mergingDispatchFixture();

    const blocked = dispatches.blockMergeFailureByCoordinator({
      taskId: task.id,
      revision: merging.revision,
      reason: 'A validação obrigatória do merge não foi executada; nenhuma integração foi aceita.',
    });

    expect(blocked).toMatchObject({
      state: 'blocked',
      integrationReceipt: undefined,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.status).toBe('blocked');
    expect(blockedMission.description.match(/NEXUS_TASK_DISPATCH_BLOCKED/g)).toHaveLength(1);
    expect(blockedMission.description.match(/Clique em “Retomar missão”/g)).toHaveLength(1);
  });

  it('requeues a quality-rejected merge only after the exact worker exit is proven', () => {
    const { missions, tasks, dispatches, mission, task, merging } =
      mergingDispatchFixture();

    const blocked = dispatches.blockQualityRepairByCoordinator({
      taskId: task.id,
      revision: merging.revision,
      reason: 'candidate review failed: review:finding-1',
    });

    expect(blocked).toMatchObject({
      state: 'blocked',
      sessionId: 'session-merge-terminal',
      workerIncarnationId: expect.any(String),
      integrationReceipt: undefined,
      lastError: expect.stringContaining(TASK_DISPATCH_QUALITY_REPAIR_MARKER),
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
    expect(missions.get(mission.id)?.status).toBe('running');

    expect(() =>
      dispatches.requeueQualityRepairAfterWorkerExit({
        taskId: task.id,
        revision: blocked.revision,
        sessionId: 'wrong-session',
        workerIncarnationId: blocked.workerIncarnationId!,
      }),
    ).toThrow(/worker.*exato|identidade.*exata/i);

    const queued = dispatches.requeueQualityRepairAfterWorkerExit({
      taskId: task.id,
      revision: blocked.revision,
      sessionId: blocked.sessionId!,
      workerIncarnationId: blocked.workerIncarnationId!,
    });

    expect(queued).toMatchObject({
      state: 'superseded',
      integrationReceipt: undefined,
      lastError: expect.stringContaining(TASK_DISPATCH_QUALITY_REPAIR_MARKER),
    });
    expect(queued.paneId).toBeUndefined();
    expect(queued.sessionId).toBeUndefined();
    expect(queued.workerIncarnationId).toBeUndefined();
    expect(queued.handoffId).toBeUndefined();
    expect(tasks.list(mission.id)[0]?.status).toBe('pending');
    expect(missions.get(mission.id)?.status).toBe('running');
  });

  it('projects an interrupted merge after restart idempotently without minting a receipt', () => {
    const { runtime, scope, mission, task, merging } = mergingDispatchFixture();
    runtime.close(scope);
    const restartedMissions = createScopedMissionStore(runtime, scope);
    const restartedTasks = createScopedTaskStore(runtime, scope);
    const restartedDispatches = createTaskDispatchStore(runtime, scope);

    const blocked = restartedDispatches.blockMergeFailureByCoordinator({
      taskId: task.id,
      revision: merging.revision,
      reason: 'O Nexus reiniciou durante o merge; a integração exige revisão explícita.',
    });
    const replay = restartedDispatches.blockMergeFailureByCoordinator({
      taskId: task.id,
      revision: blocked.revision,
      reason: 'replay de reconciliação após restart',
    });

    expect(replay).toMatchObject({
      state: 'blocked',
      integrationReceipt: undefined,
    });
    expect(restartedTasks.list(mission.id)[0]?.status).toBe('failed');
    expect(restartedMissions.get(mission.id)).toMatchObject({
      status: 'blocked',
    });
    expect(
      restartedMissions.get(mission.id)?.description.match(/NEXUS_TASK_DISPATCH_BLOCKED/g),
    ).toHaveLength(1);
    expect(
      restartedMissions.get(mission.id)?.description.match(/Clique em “Retomar missão”/g),
    ).toHaveLength(1);
  });

  it('claims task + marks running atomically and fences a second dispatcher', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => 1_000,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => 1_000 });
    let id = 0;
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => 1_000,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Corrigir auth',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Auth',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Implementar fix',
    });

    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: `nexus-scheduler-${task.id}`,
      leaseOwner: 'main-coordinator',
      leaseMs: 30_000,
    });

    expect(claim).toMatchObject({
      taskId: task.id,
      missionId: mission.id,
      state: 'claimed',
      attempt: 1,
      revision: 1,
      workerIncarnationId: expect.stringMatching(/^worker-incarnation-/),
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: `nexus-scheduler-${task.id}`,
        leaseOwner: 'other-loop',
        leaseMs: 30_000,
      }),
    ).toThrow(/já (?:foi )?reservad|dispatch ativo/i);
  });

  it('persists route/spawn identity and rejects a stale fencing token', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 2_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Adicionar teste',
      intentVersion: 3,
    });
    const mission = missions.create({
      title: 'Teste',
      intentVersion: 3,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Teste de regressão',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      reason: 'rota autoritativa para o dispatcher durável',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 3,
      workerId: 'worker-stable',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });

    expect(() =>
      dispatches.attachRoute({
        taskId: task.id,
        revision: claim.revision,
        leaseToken: 'stale-token',
        routeReservationId: route.id,
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }),
    ).toThrow(/fencing|lease/i);

    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    const running = dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: 'pane-1',
      sessionId: 'session-1',
    });
    expect(running).toMatchObject({
      state: 'running',
      paneId: 'pane-1',
      sessionId: 'session-1',
    });

    runtime.close(scope);
    expect(createTaskDispatchStore(runtime, scope).get(task.id)).toMatchObject({
      state: 'running',
      routeReservationId: route.id,
      paneId: 'pane-1',
      sessionId: 'session-1',
      workerIncarnationId: claim.workerIncarnationId,
    });
  });

  it('fences a sealed plan to the exact roster agent and route contract', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const contract = approvedIntentContract({
      goal: 'Roster exato',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Roster',
      squadId: 'squad-a',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: {
        id: 'squad-a',
        agents: [
          {
            id: 'backend',
            agentName: 'Backend',
            category: 'executor',
            cli: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
            allowedTools: ['nexus_handoff_submit'],
          },
        ],
      },
      rows: [
        {
          plannerId: 'backend-fix',
          title: 'Backend fix',
          detail: encodeTaskScheduleDetail('Corrigir backend', {
            dependsOn: [],
            ownership: { files: ['src/backend.ts'], symbols: [], domains: [] },
            merged: false,
            agentRef: 'backend',
            agentCategory: 'executor',
            executionMode: 'isolated_worktree',
          }),
          agentRef: 'backend',
          agentCategory: 'executor',
        },
      ],
    });
    const receipt = tasks.getPlanReceipt(mission.id, 1)!;
    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task!.id,
        intentVersion: 1,
        workerId: 'Backend',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/plano selado exige/i);

    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task!.id,
        intentVersion: 1,
        workerId: 'Backend',
        leaseOwner: 'main',
        leaseMs: 30_000,
        agentRef: 'backend',
        agentCategory: 'executor',
        rosterHash: receipt.rosterHash,
        routeContract: {
          adapterId: 'agy',
          model: 'gemini-3.6-flash-high',
          effort: 'high',
        },
        ownership: { files: ['src/backend.ts'], symbols: [], domains: [] },
      }),
    ).toThrow(/provider.*roster/i);

    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 1,
      workerId: 'Backend',
      leaseOwner: 'main',
      leaseMs: 30_000,
      agentRef: 'backend',
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
      routeContract: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      ownership: { files: ['src/backend.ts'], symbols: [], domains: [] },
    });
    const route = missions.reserveRouteDecision(mission.id, task!.title, {
      tier: 'hard',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      reason: 'rota selada',
      alternatives: [],
    });
    expect(() =>
      dispatches.attachRoute({
        taskId: task!.id,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: 'agy',
        model: 'gemini-3.6-pro',
        effort: 'high',
      }),
    ).toThrow(/route contract|provider substituto/i);
    const routed = dispatches.attachRoute({
      taskId: task!.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(routed).toMatchObject({
      agentRef: 'backend',
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
      routeContract: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    });
    missions.update(mission.id, {
      intentVersion: 2,
      intentContract: approvedIntentContract({
        goal: 'Roster exato revisado',
        intentVersion: 2,
      }),
      intentState: 'executing',
      status: 'running',
    });
    expect(tasks.getPlanReceipt(mission.id, 1)).toMatchObject({
      planHash: receipt.planHash,
      tasks: [{ taskId: task!.id }],
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
  });

  it('blocks an unavailable sealed worker before claim without corrupting its receipt', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const contract = approvedIntentContract({
      goal: 'Falhar fechado',
      intentVersion: 4,
    });
    const mission = missions.create({
      title: 'Roster indisponível',
      squadId: 'squad-sealed',
      intentVersion: 4,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 4,
      squad: {
        id: 'squad-sealed',
        agents: [
          {
            id: 'reviewer',
            agentName: 'Reviewer',
            category: 'reviewer',
            cli: 'claude',
            model: 'claude-sonnet-5',
          },
        ],
      },
      rows: [
        {
          plannerId: 'review',
          title: 'Revisar',
          detail: 'Receipt imutável',
          agentRef: 'reviewer',
          agentCategory: 'reviewer',
        },
      ],
    });
    const original = tasks.getPlanReceipt(mission.id, 4)!;

    expect(
      dispatches.blockBeforeClaim({
        missionId: mission.id,
        taskId: task!.id,
        intentVersion: 4,
        reason: 'A CLI exata do reviewer não está instalada.',
      }),
    ).toBe(true);
    expect(dispatches.get(task!.id)).toBeNull();
    expect(missions.get(mission.id)).toMatchObject({ status: 'blocked' });
    expect(tasks.getPlanReceipt(mission.id, 4)).toMatchObject({
      planHash: original.planHash,
      tasks: [{ taskId: task!.id, detail: 'Receipt imutável' }],
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({
      status: 'failed',
      detail: 'Receipt imutável',
    });
    expect(
      dispatches.blockBeforeClaim({
        missionId: mission.id,
        taskId: task!.id,
        intentVersion: 4,
        reason: 'Replay do mesmo bloqueio.',
      }),
    ).toBe(false);
  });

  it('marks an unfrozen mission done only after integration and accepted handoff delivery proof', () => {
    const runtime = manager();
    const scope = testProjectScope({ rootRealPath: process.cwd() });
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const contract = approvedIntentContract({
      goal: 'Completar pelo motor com prova real',
      intentVersion: 7,
    });
    const mission = missions.create({
      title: 'Golden path',
      squadId: 'golden-squad',
      intentVersion: 7,
      intentState: 'executing',
      intentContract: contract,
      orchestratorSessionId: 'orchestrator-golden',
    });
    missions.setStatus(mission.id, 'running');
    const ownership = { files: ['src/golden.ts'], symbols: [], domains: [] };
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 7,
      squad: {
        id: 'golden-squad',
        agents: [
          {
            id: 'worker',
            agentName: 'Golden Worker',
            category: 'executor',
            cli: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
          },
        ],
      },
      rows: [
        {
          plannerId: 'implement',
          title: 'Implementar golden path',
          detail: encodeTaskScheduleDetail('Implementar e testar.', {
            dependsOn: [],
            ownership,
            merged: false,
            agentRef: 'worker',
            agentCategory: 'executor',
            executionMode: 'isolated_worktree',
          }),
          agentRef: 'worker',
          agentCategory: 'executor',
        },
      ],
    });
    const receipt = tasks.getPlanReceipt(mission.id, 7)!;
    const route = missions.reserveRouteDecision(mission.id, task!.title, {
      tier: 'hard',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      reason: 'roster selado',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 7,
      workerId: 'Golden Worker',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership,
      executionMode: 'isolated_worktree',
      agentRef: 'worker',
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
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
      paneId: 'pane-golden',
      sessionId: 'session-golden',
    });
    const handoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-golden',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'Golden Worker',
      status: 'success',
      summary: 'Implementação integrada com testes e commit local verificados.',
    });
    insertPhysicalHandoffAuthority({
      runtime,
      scope,
      missionId: mission.id,
      handoffId: handoff.id,
      sessionId: 'session-golden',
      workerIncarnationId: claim.workerIncarnationId,
      worktreeHeadSha: repositoryHead(),
    });
    const ready = dispatches.acceptHandoff({
      sessionId: 'session-golden',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    const integratedHeadSha = repositoryHead();
    const qualityEvidenceIds = seedIntegratedQualityAuthority({
      runtime,
      scope,
      missionId: mission.id,
      headSha: integratedHeadSha,
      label: 'unfrozen-golden-path',
    });
    dispatches.completeByCoordinator({
      taskId: task!.id,
      revision: ready.revision,
      receipt: {
        kind: 'worktree_integrated',
        reference: integratedHeadSha,
        completedAt: Date.now(),
        evidenceIds: [...qualityEvidenceIds],
      },
    });

    expect(
      dispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(missions.get(mission.id)?.status).toBe('running');

    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: mission.id,
      orchestratorSessionId: 'orchestrator-golden',
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(handoff.id, mission.id, 'orchestrator-golden'),
    ).toBe(true);

    runtime.close(scope);
    const restartedMissions = createScopedMissionStore(runtime, scope);
    const restartedDispatches = createTaskDispatchStore(runtime, scope);
    const restartedHandoffs = createScopedHandoffStore(runtime, scope);
    restartedMissions.rebindOrchestratorSession(mission.id, 'orchestrator-golden-rebound');
    expect(restartedHandoffs.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: 'queued',
    });
    expect(restartedHandoffs.listDeliveryAttempts(handoff.id)).toMatchObject([
      {
        attemptNo: 1,
        state: 'accepted',
        orchestratorSessionId: 'orchestrator-golden',
      },
    ]);
    expect(
      restartedDispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(restartedMissions.get(mission.id)?.status).toBe('running');

    const reboundAttempt = restartedHandoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: mission.id,
      orchestratorSessionId: 'orchestrator-golden-rebound',
      maxAttempts: 2,
    });
    restartedHandoffs.markDeliveryAttemptPasted({
      attemptId: reboundAttempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      restartedHandoffs.acceptDeliveryAttempt({
        attemptId: reboundAttempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    expect(
      restartedHandoffs.markConsumedAfterAcceptedDelivery(
        handoff.id,
        mission.id,
        'orchestrator-golden-rebound',
      ),
    ).toBe(true);
    expect(restartedDispatches.get(task!.id)?.integrationReceipt).toMatchObject({
      kind: 'worktree_integrated',
      reference: repositoryHead(),
      completedAt: expect.any(Number),
      evidenceIds: [expect.stringMatching(/^review:/)],
      qualityProof: {
        workerHeadSha: repositoryHead(),
        headSha: repositoryHead(),
        integrationHeadSha: repositoryHead(),
        diffHash: EMPTY_GIT_DIFF_SHA256,
      },
    });
    restartedMissions.update(mission.id, {
      status: 'running',
      intentState: 'awaiting_approval',
    });
    expect(
      restartedDispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(restartedMissions.get(mission.id)?.status).toBe('running');
    restartedMissions.update(mission.id, {
      status: 'running',
      intentState: 'validating',
    });
    runtime
      .open(scope)
      .db.prepare(
        `UPDATE mission_task_plans SET roster_hash = ?
       WHERE mission_id = ? AND intent_version = ?`,
      )
      .run('0'.repeat(64), mission.id, 7);
    expect(() =>
      restartedDispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 7,
      }),
    ).toThrow(/roster hash|corrupt/i);
    expect(restartedMissions.get(mission.id)?.status).toBe('running');
    runtime
      .open(scope)
      .db.prepare(
        `UPDATE mission_task_plans SET roster_hash = ?
       WHERE mission_id = ? AND intent_version = ?`,
      )
      .run(receipt.rosterHash, mission.id, 7);
    expect(
      restartedDispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 7,
      }),
    ).toBe(true);
    expect(restartedMissions.get(mission.id)).toMatchObject({
      status: 'done',
      intentState: 'done',
    });
    expect(restartedMissions.get(mission.id)?.learnings).toMatch(
      /Conclusão automática verificada[\s\S]*handoffs entregues/i,
    );
    expect(
      restartedDispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
  });

  it('fails closed when a guided verified plan loses its PREVC quality rows', () => {
    const fixture = verifiedPlanFixture('guided-prevc-rows-missing', {
      domains: [],
      squadId: 'agentic-guided-prevc-rows-missing',
    });
    const db = fixture.runtime.open(fixture.scope).db;
    db.prepare(`DELETE FROM review_reports WHERE mission_id = ?`).run(
      fixture.mission.id,
    );
    db.prepare(`DELETE FROM workflow_states WHERE mission_id = ?`).run(
      fixture.mission.id,
    );
    db.prepare(`DELETE FROM mission_contracts WHERE mission_id = ?`).run(
      fixture.mission.id,
    );

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('replays the full guided physical authority proof after restart without completing the mission', () => {
    const fixture = verifiedPlanFixture('guided-physical-replay', {
      squadId: 'agentic-guided-physical-replay',
    });
    const input = {
      missionId: fixture.mission.id,
      intentVersion: 7,
    };

    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority(input),
    ).toBe(true);
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority(input),
    ).toBe(true);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });

    fixture.runtime.close(fixture.scope);
    const restarted = createTaskDispatchStore(
      fixture.runtime,
      fixture.scope,
    );
    expect(restarted.hasVerifiedGuidedPlanAuthority(input)).toBe(true);
    expect(
      createScopedMissionStore(fixture.runtime, fixture.scope).get(
        fixture.mission.id,
      ),
    ).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('rejects an integrated replay whose canonical quality proof was tampered', () => {
    const fixture = verifiedPlanFixture('guided-quality-proof-tamper', {
      squadId: 'agentic-guided-quality-proof-tamper',
    });
    const dispatch = fixture.dispatches.get(fixture.task.id)!;
    expect(dispatch.integrationReceipt).toMatchObject({
      kind: 'worktree_integrated',
      reference: repositoryHead(),
      qualityProof: {
        workerHeadSha: repositoryHead(),
        headSha: repositoryHead(),
        integrationHeadSha: repositoryHead(),
        diffHash: EMPTY_GIT_DIFF_SHA256,
        reviewEvidenceIds: [
          'review:integrated-guided-quality-proof-tamper',
        ],
      },
    });
    const tamperedReceipt = {
      ...dispatch.integrationReceipt!,
      qualityProof: {
        ...dispatch.integrationReceipt!.qualityProof!,
        diffHash: '0'.repeat(64),
      },
    };
    fixture.runtime
      .open(fixture.scope)
      .db.prepare(
        `UPDATE task_dispatch_queue
            SET integration_receipt_json = ?
          WHERE task_id = ?`,
      )
      .run(JSON.stringify(tamperedReceipt), fixture.task.id);

    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('rejects a guided completed replay after its physical MCP receipt is tampered', () => {
    const fixture = verifiedPlanFixture('guided-physical-tamper', {
      squadId: 'agentic-guided-physical-tamper',
    });
    fixture.runtime
      .open(fixture.scope)
      .db.prepare(`DELETE FROM handoff_mcp_receipts WHERE handoff_id = ?`)
      .run(fixture.handoff.id);

    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('refuses guided completion from the verified plan before PREVC emits its first receipt', () => {
    const fixture = verifiedPlanFixture('frozen-before-prevc', {
      domains: ['manual-specialty'],
      squadId: 'agentic-guided-frozen-before-prevc',
    });
    const db = fixture.runtime.open(fixture.scope).db;
    db.prepare(`DELETE FROM workflow_states WHERE mission_id = ?`).run(
      fixture.mission.id,
    );
    db.prepare(`DELETE FROM mission_contracts WHERE mission_id = ?`).run(
      fixture.mission.id,
    );
    db.prepare(
      `INSERT INTO mission_contracts
         (mission_id, revision, contract_hash, context_revision, contract_json,
          author_id, author_session_id, author_provider, frozen_at)
       VALUES (?, 1, ?, ?, '{}', 'author', 'session-author', 'codex', 1)`,
    ).run(fixture.mission.id, 'c'.repeat(64), 'r'.repeat(64));
    db.prepare(
      `INSERT INTO workflow_states
         (mission_id, revision, stage, workflow_json, updated_at)
       VALUES (?, 1, 'execution', '{}', 1)`,
    ).run(fixture.mission.id);

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('keeps guided completion PREVC-owned when workflow is complete but milestone receipts are absent', () => {
    const fixture = verifiedPlanFixture('complete-workflow-no-receipts', {
      domains: ['manual-specialty'],
      squadId: 'agentic-guided-complete-workflow',
    });
    const db = fixture.runtime.open(fixture.scope).db;
    db.prepare(`DELETE FROM workflow_states WHERE mission_id = ?`).run(
      fixture.mission.id,
    );
    db.prepare(`DELETE FROM mission_contracts WHERE mission_id = ?`).run(
      fixture.mission.id,
    );
    db.prepare(
      `INSERT INTO mission_contracts
         (mission_id, revision, contract_hash, context_revision, contract_json,
          author_id, author_session_id, author_provider, frozen_at)
       VALUES (?, 1, ?, ?, '{}', 'author', 'session-author', 'codex', 1)`,
    ).run(fixture.mission.id, 'e'.repeat(64), 't'.repeat(64));
    db.prepare(
      `INSERT INTO workflow_states
         (mission_id, revision, stage, workflow_json, updated_at)
       VALUES (?, 6, 'complete', '{}', 1)`,
    ).run(fixture.mission.id);

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('refuses final completion when the physical handoff lost its exact audit intent', () => {
    const fixture = verifiedPlanFixture('missing-physical-audit');
    fixture.runtime
      .open(fixture.scope)
      .db.prepare(
        `DELETE FROM audit_events
         WHERE mission_id = ? AND action = 'nexus_handoff_submit'
           AND outcome = 'intent'`,
      )
      .run(fixture.mission.id);

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('refuses final completion when the physical handoff claims another worker', () => {
    const fixture = verifiedPlanFixture('wrong-physical-worker');
    const db = fixture.runtime.open(fixture.scope).db;

    expect(() =>
      db
        .prepare('UPDATE handoffs SET from_agent = ? WHERE id = ?')
        .run('Another Worker', fixture.handoff.id),
    ).toThrow(/immutable/i);

    // Simulate a database whose schema guard was removed and whose durable row
    // was then corrupted. The completion boundary must independently re-prove
    // the exact worker identity instead of trusting an earlier acceptance.
    db.exec('DROP TRIGGER handoffs_claim_binding_immutable');
    db.prepare('UPDATE handoffs SET from_agent = ? WHERE id = ?').run(
      'Another Worker',
      fixture.handoff.id,
    );

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('refuses task-plan completion once PREVC step receipts exist (no bypass)', () => {
    const fixture = verifiedPlanFixture('prevc-owned');
    const db = fixture.runtime.open(fixture.scope).db;
    db.prepare(
      `INSERT INTO mission_step_receipts
         (mission_id, step_id, from_stage, to_stage,
          workflow_revision_before, workflow_revision_after,
          evidence_ids_json, evidence_binding_json, completed_at)
       VALUES (?, 'step-1', 'execution', 'validation-primary', 1, 2, '[]', '{}', 1)`,
    ).run(fixture.mission.id);

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)?.status).toBe('running');
  });

  it('never completes from status alone: exact-session handoff and integration receipt are required', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Entregar prova',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Prova',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      reason: 'rota autoritativa para o worker',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-1',
      leaseOwner: 'main',
      leaseMs: 30_000,
      executionMode: 'same_checkout',
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    const running = dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: 'pane-1',
      sessionId: 'session-active',
    });

    expect(() =>
      dispatches.completeByCoordinator({
        taskId: task.id,
        revision: running.revision,
        receipt: {
          kind: 'same_checkout_validated',
          reference: 'premature-receipt',
          completedAt: 10,
        },
      }),
    ).toThrow(/handoff|merge/i);
    expect(() =>
      dispatches.acceptHandoff({
        sessionId: 'session-stale',
        workerIncarnationId: claim.workerIncarnationId,
        handoffId: 'handoff-stale',
      }),
    ).toThrow(/dispatch ativo|sessão/i);

    const handoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-active',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'worker-1',
      status: 'success',
      summary: 'Implementação concluída com testes verdes e evidência durável.',
    });
    expect(() =>
      dispatches.acceptHandoff({
        sessionId: 'session-active',
        workerIncarnationId: claim.workerIncarnationId,
        handoffId: handoff.id,
      }),
    ).toThrow(/physical nexus_handoff_submit/i);
    expect(dispatches.get(task.id)).toMatchObject({ state: 'running' });
    const physicalReceiptId = insertPhysicalHandoffAuthority({
      runtime,
      scope,
      missionId: mission.id,
      handoffId: handoff.id,
      sessionId: 'session-active',
      workerIncarnationId: claim.workerIncarnationId,
    });
    const authorityDb = runtime.open(scope).db;
    const auditIntent = authorityDb
      .prepare(
        `SELECT id, mission_id, actor, action, outcome, payload_json,
                occurred_at
         FROM audit_events WHERE id = ?`,
      )
      .get(`audit-${physicalReceiptId}`) as {
      id: string;
      mission_id: string;
      actor: string;
      action: string;
      outcome: string;
      payload_json: string;
      occurred_at: number;
    };
    authorityDb.prepare(`DELETE FROM audit_events WHERE id = ?`).run(auditIntent.id);
    expect(() =>
      dispatches.acceptHandoff({
        sessionId: 'session-active',
        workerIncarnationId: claim.workerIncarnationId,
        handoffId: handoff.id,
      }),
    ).toThrow(/correlated physical audit intent/i);
    authorityDb
      .prepare(
        `INSERT INTO audit_events
           (id, mission_id, actor, action, outcome, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auditIntent.id,
        auditIntent.mission_id,
        auditIntent.actor,
        auditIntent.action,
        auditIntent.outcome,
        auditIntent.payload_json,
        auditIntent.occurred_at,
      );
    const ready = dispatches.acceptHandoff({
      sessionId: 'session-active',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
    expect(() =>
      dispatches.completeByCoordinator({
        taskId: task.id,
        revision: ready.revision,
        receipt: {
          kind: 'same_checkout_validated',
          reference: handoff.id,
          completedAt: Date.now(),
        },
      }),
    ).toThrow(/sintético|proibido/i);
    const blocked = dispatches.blockUnvalidatedByCoordinator({
      taskId: task.id,
      revision: ready.revision,
      reason:
        'same_checkout legado não possui baseline/diff atribuível; replaneje com ownership explícito.',
    });
    expect(blocked.state).toBe('blocked');
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    expect(missions.get(mission.id)).toMatchObject({ status: 'blocked' });
  });

  it('rejects an expired lease and renews only from the exact bound session', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Heartbeat',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Heartbeat',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker vivo' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      effort: 'medium',
      reason: 'rota de heartbeat',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-heartbeat',
      leaseOwner: 'main',
      leaseMs: 1_000,
    });
    now = 2_001;
    expect(() =>
      dispatches.attachRoute({
        taskId: task.id,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: 'codex',
      }),
    ).toThrow(/expirad/i);

    now = 3_000;
    const liveContract = approvedIntentContract({
      goal: 'Worker vivo',
      intentVersion: 2,
    });
    const liveMission = missions.create({
      title: 'Worker vivo',
      intentVersion: 2,
      intentState: 'dispatched',
      intentContract: liveContract,
    });
    missions.setStatus(liveMission.id, 'running');
    const liveTask = tasks.create({
      missionId: liveMission.id,
      title: 'Renovar lease',
    });
    const liveRoute = missions.reserveRouteDecision(liveMission.id, liveTask.title, {
      tier: 'medium',
      adapterId: 'codex',
      effort: 'medium',
      reason: 'rota de worker vivo',
      alternatives: [],
    });
    const liveClaim = dispatches.claim({
      missionId: liveMission.id,
      taskId: liveTask.id,
      intentVersion: 2,
      workerId: 'worker-live',
      leaseOwner: 'main',
      leaseMs: 1_000,
    });
    const routed = dispatches.attachRoute({
      taskId: liveTask.id,
      revision: liveClaim.revision,
      leaseToken: liveClaim.leaseToken,
      routeReservationId: liveRoute.id,
      adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: liveTask.id,
      revision: routed.revision,
      leaseToken: liveClaim.leaseToken,
      paneId: 'pane-live',
      sessionId: 'session-live',
      workerIncarnationId: liveClaim.workerIncarnationId,
    });
    now = 5_000;
    expect(() =>
      dispatches.heartbeat({
        sessionId: 'session-forged',
        missionId: liveMission.id,
        workerIncarnationId: liveClaim.workerIncarnationId,
        leaseMs: 30_000,
      }),
    ).toThrow(/sess[aã]o|dispatch/i);
    expect(() =>
      dispatches.heartbeat({
        sessionId: 'session-live',
        missionId: mission.id,
        workerIncarnationId: liveClaim.workerIncarnationId,
        leaseMs: 30_000,
      }),
    ).toThrow(/sess[aã]o|dispatch/i);
    expect(() =>
      dispatches.heartbeat({
        sessionId: 'session-live',
        missionId: liveMission.id,
        workerIncarnationId: 'worker-incarnation-stale',
        leaseMs: 30_000,
      }),
    ).toThrow(/sess[aã]o|dispatch/i);
    const renewed = dispatches.heartbeat({
      sessionId: 'session-live',
      missionId: liveMission.id,
      workerIncarnationId: liveClaim.workerIncarnationId,
      leaseMs: 30_000,
    });
    expect(renewed).toMatchObject({
      state: 'running',
      sessionId: 'session-live',
      leaseExpiresAt: 35_000,
      lastHeartbeatAt: 5_000,
    });
  });

  it('blocks an expired uncertain spawn durably with one PT-BR CTA', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Recuperar restart',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Restart',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Spawn incerto',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard',
      adapterId: 'codex',
      effort: 'high',
      reason: 'rota antes do crash',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-restart',
      leaseOwner: 'main',
      leaseMs: 1_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    const spawning = dispatches.markSpawning({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
    });
    now = 2_001;

    const blocked = dispatches.blockExpired({
      taskId: task.id,
      revision: spawning.revision,
      reason: 'O Nexus reiniciou antes de provar qual pane recebeu esta tarefa.',
    });
    expect(blocked.state).toBe('blocked');
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.status).toBe('blocked');
    expect(blockedMission.description).toMatch(/Retomar miss[aã]o/i);
    expect(blockedMission.description.match(/NEXUS_TASK_DISPATCH_BLOCKED/g)).toHaveLength(1);

    expect(
      dispatches.blockExpired({
        taskId: task.id,
        revision: blocked.revision,
        reason: 'replay idempotente',
      }).state,
    ).toBe('blocked');
    expect(
      missions.get(mission.id)?.description.match(/NEXUS_TASK_DISPATCH_BLOCKED/g),
    ).toHaveLength(1);
  });

  it('requeues the exact exited worker with durable backoff and no mission block', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Detectar worker morto',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Worker morto',
      description:
        `Texto legítimo do operador que cita ${TASK_DISPATCH_BLOCK_MARKER} ` +
        'sem conceder autoridade de lifecycle.',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      effort: 'medium',
      reason: 'rota de lifecycle',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-exit',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: 'pane-exit',
      sessionId: 'session-exit',
      workerIncarnationId: claim.workerIncarnationId,
    });

    expect(
      dispatches.blockSessionExit({
        sessionId: 'session-exit',
        workerIncarnationId: 'worker-incarnation-stale',
        reason: 'Saída tardia da encarnação anterior.',
      }),
    ).toBeNull();
    const blocked = dispatches.blockSessionExit({
      sessionId: 'session-exit',
      workerIncarnationId: claim.workerIncarnationId,
      reason: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
    expect(blocked).toMatchObject({
      state: 'superseded',
      sessionId: 'session-exit',
      lastError: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
    expect(blocked!.leaseExpiresAt).toBeGreaterThan(blocked!.updatedAt);
    expect(missions.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'dispatched',
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('pending');
    expect(
      dispatches.blockSessionExit({
        sessionId: 'session-exit',
        workerIncarnationId: claim.workerIncarnationId,
        reason: 'evento duplicado',
      }),
    ).toBeNull();
    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-exit',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/capacity_wait.*retry técnico/i);
  });

  it('requeues a missing runtime and atomically rebinds the same persisted worker', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const mission = missions.create({
      title: 'Retomar worker após restart',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Preservar contexto do worker após restart',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Continuar implementação',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      reason: 'rota persistida',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-restart',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    const running = dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: 'pane-persisted',
      sessionId: 'session-dead',
      workerIncarnationId: claim.workerIncarnationId,
    });

    now = 2_000;
    const queued = dispatches.requeueMissingRuntime({
      taskId: task.id,
      revision: running.revision,
    });
    expect(queued).toMatchObject({
      state: 'superseded',
      paneId: 'pane-persisted',
      sessionId: 'session-dead',
      workerIncarnationId: claim.workerIncarnationId,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('pending');
    expect(missions.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });

    now = 2_100;
    const rebound = dispatches.rebindRestartedWorker({
      missionId: mission.id,
      paneId: 'pane-persisted',
      expectedSessionId: 'session-dead',
      replacementSessionId: 'session-restarted',
      workerIncarnationId: claim.workerIncarnationId,
      leaseMs: 30_000,
    });
    expect(rebound).toMatchObject({
      state: 'running',
      taskId: task.id,
      paneId: 'pane-persisted',
      sessionId: 'session-restarted',
      workerIncarnationId: claim.workerIncarnationId,
      leaseExpiresAt: 32_100,
      lastHeartbeatAt: 2_100,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
    expect(() =>
      dispatches.rebindRestartedWorker({
        missionId: mission.id,
        paneId: 'pane-persisted',
        expectedSessionId: 'session-dead',
        replacementSessionId: 'session-forged',
        workerIncarnationId: claim.workerIncarnationId,
        leaseMs: 30_000,
      }),
    ).toThrow(/dispatch|sess[aã]o|CAS/i);
  });

  it('requeues an exact exited bootstrap attempt without blocking the mission', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    let now = 10_000;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
      now: () => now,
    });
    const mission = missions.create({
      title: 'Retry automático de bootstrap',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Tentar outro worker após exit técnico',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      reason: 'rota do primeiro bootstrap',
      alternatives: [],
    });
    const first = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-retry',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: first.revision,
      leaseToken: first.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: first.leaseToken,
      paneId: 'pane-retry',
      sessionId: 'session-retry',
      workerIncarnationId: first.workerIncarnationId,
    });
    dispatches.blockSessionExit({
      sessionId: 'session-retry',
      workerIncarnationId: first.workerIncarnationId,
      reason: TASK_DISPATCH_SESSION_EXIT_REASON,
    });

    const superseded = dispatches.requeueTechnicalBootstrapFailure({
      taskId: task.id,
      missionId: mission.id,
      leaseToken: first.leaseToken,
      workerIncarnationId: first.workerIncarnationId,
      paneId: 'pane-retry',
      sessionId: 'session-retry',
      error: 'provider exited during bootstrap',
    });

    expect(superseded).toMatchObject({
      state: 'superseded',
      attempt: 1,
      lastError: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('pending');
    expect(missions.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(missions.get(mission.id)?.description).not.toContain(
      TASK_DISPATCH_BLOCK_MARKER,
    );

    now = superseded.leaseExpiresAt;
    const second = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-retry',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    expect(second).toMatchObject({ state: 'claimed', attempt: 2 });
    expect(second.workerIncarnationId).not.toBe(first.workerIncarnationId);
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
  });

  it('supersedes a running dispatch when intent changes and rejects late worker effects', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contractV1 = approvedIntentContract({
      goal: 'Implementar contrato inicial',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Intent fence',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: contractV1,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Worker antigo',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      reason: 'rota vinculada à intenção 1',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-intent-v1',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
    });
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: 'pane-intent-v1',
      sessionId: 'session-intent-v1',
      workerIncarnationId: claim.workerIncarnationId,
    });

    const contractV2 = approvedIntentContract({
      goal: 'Contrato revisado pelo operador',
      intentVersion: 2,
    });
    const revised = missions.update(mission.id, {
      description: 'Descrição revisada para o contrato novo.',
      intentVersion: 2,
      intentContract: contractV2,
      intentState: 'executing',
      status: 'running',
    });

    expect(revised).toMatchObject({ intentVersion: 2, status: 'blocked' });
    expect(revised?.description).toContain('Descrição revisada para o contrato novo.');
    expect(revised?.description).toMatch(/Retomar miss[aã]o/i);
    expect(dispatches.get(task.id)).toMatchObject({
      intentVersion: 1,
      state: 'superseded',
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
    expect(() =>
      dispatches.heartbeat({
        sessionId: 'session-intent-v1',
        missionId: mission.id,
        workerIncarnationId: claim.workerIncarnationId,
        leaseMs: 30_000,
      }),
    ).toThrow(/dispatch|inten[cç][aã]o|running/i);

    const lateHandoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-intent-v1',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'worker-intent-v1',
      status: 'success',
      summary: 'Resultado tardio que não pode concluir a intenção revisada.',
    });
    expect(() =>
      dispatches.acceptHandoff({
        sessionId: 'session-intent-v1',
        workerIncarnationId: claim.workerIncarnationId,
        handoffId: lateHandoff.id,
      }),
    ).toThrow(/dispatch ativo|sess[aã]o|inten[cç][aã]o/i);
    expect(tasks.list(mission.id)[0]?.status).not.toBe('done');
  });

  it.each(['blocked', 'failed'] as const)(
    'revoga atomicamente dispatch atual quando missão vira %s',
    (terminalStatus) => {
      const runtime = manager();
      const scope = testProjectScope();
      let id = 0;
      const missions = createScopedMissionStore(runtime, scope);
      const tasks = createScopedTaskStore(runtime, scope);
      const handoffs = createScopedHandoffStore(runtime, scope);
      const dispatches = createTaskDispatchStore(runtime, scope, {
        idFactory: (prefix) => `${prefix}-${++id}`,
      });
      const baseContract = approvedIntentContract({
        goal: 'Executar trabalho com revogação forte',
        intentVersion: 1,
      });
      const mission = missions.create({
        title: 'Lifecycle fence',
        intentVersion: 1,
        intentState: 'dispatched',
        intentContract: {
          ...baseContract,
          approvedAt: 1,
          dispatchedAt: 1,
        },
      });
      missions.setStatus(mission.id, 'running');
      const task = tasks.create({
        missionId: mission.id,
        title: 'Worker atual',
      });
      const route = missions.reserveRouteDecision(mission.id, task.title, {
        tier: 'hard',
        adapterId: 'codex',
        effort: 'high',
        reason: 'rota atual',
        alternatives: [],
      });
      const claim = dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-current',
        leaseOwner: 'main',
        leaseMs: 30_000,
      });
      const routed = dispatches.attachRoute({
        taskId: task.id,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: 'codex',
      });
      dispatches.bindSpawn({
        taskId: task.id,
        revision: routed.revision,
        leaseToken: claim.leaseToken,
        paneId: 'pane-current',
        sessionId: 'session-current',
        workerIncarnationId: claim.workerIncarnationId,
      });
      const handoff = handoffs.submit({
        missionId: mission.id,
        sessionId: 'session-current',
        workerIncarnationId: claim.workerIncarnationId,
        fromAgent: 'worker-current',
        status: 'success',
        summary: 'Resultado produzido antes da revogação da missão.',
      });

      const demoted = missions.setStatus(mission.id, terminalStatus);
      expect(demoted).toMatchObject({
        status: terminalStatus,
        intentState: terminalStatus === 'blocked' ? 'blocked_user' : 'blocked_technical',
      });
      expect(hasCurrentDispatchAuthority(demoted!)).toBe(false);
      expect(dispatches.get(task.id)).toMatchObject({ state: 'superseded' });
      expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
      expect(() =>
        dispatches.acceptHandoff({
          sessionId: 'session-current',
          workerIncarnationId: claim.workerIncarnationId,
          handoffId: handoff.id,
        }),
      ).toThrow(/dispatch|running|autoridade|miss[aã]o/i);
      expect(() =>
        dispatches.blockFromHandoff({
          sessionId: 'session-current',
          workerIncarnationId: claim.workerIncarnationId,
          handoffId: handoff.id,
          detail: 'Evento tardio não pode reabrir uma missão terminal.',
        }),
      ).toThrow(/dispatch|running|autoridade|miss[aã]o/i);
      expect(dispatches.get(task.id)?.integrationReceipt).toBeUndefined();
    },
  );

  it('revoga entre validação e merge sem aceitar receipt ou conclusão tardia', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Revogar antes do efeito Git',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Race merge',
      intentVersion: 1,
      intentState: 'validating',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Candidato já validado',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard',
      adapterId: 'codex',
      effort: 'high',
      reason: 'rota corrente',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-race',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: 'pane-race',
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
    });
    const handoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'worker-race',
      status: 'success',
      summary: 'Candidato validado, ainda sem integração no checkout principal.',
    });
    insertPhysicalHandoffAuthority({
      runtime,
      scope,
      missionId: mission.id,
      handoffId: handoff.id,
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
    });
    const ready = dispatches.acceptHandoff({
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    const merging = dispatches.beginMerge({
      taskId: task.id,
      revision: ready.revision,
    });

    missions.setStatus(mission.id, 'blocked');

    expect(() =>
      dispatches.completeByCoordinator({
        taskId: task.id,
        revision: merging.revision,
        receipt: {
          kind: 'worktree_integrated',
          reference: 'b'.repeat(40),
          completedAt: Date.now(),
          evidenceIds: ['evidence-race'],
        },
      }),
    ).toThrow(/autoridade|running|dispatch|merge|inten[cç][aã]o/i);
    expect(dispatches.get(task.id)).toMatchObject({
      state: 'superseded',
      integrationReceipt: undefined,
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
    expect(missions.get(mission.id)).toMatchObject({ status: 'blocked' });
  });

  it('não avança uma transição com contrato ainda não aprovado', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const mission = missions.create({
      title: 'Sem aprovação',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: compileIntentContract({
        goal: 'Aguardar aprovação real',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Não pode reservar worker',
    });

    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-unapproved',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/aprovad|autoridade|contrato/i);
    expect(dispatches.get(task.id)).toBeNull();
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'pending' });
  });

  it('não cria claim fora de dispatched, executing ou validating', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const mission = missions.create({
      title: 'Aguardando nova aprovação',
      intentVersion: 1,
      intentState: 'awaiting_approval',
      intentContract: approvedIntentContract({
        goal: 'Não reutilizar aprovação fora do lifecycle',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Ainda não despachar',
    });

    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-waiting',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/autoridade lifecycle|intent=awaiting_approval/i);
    expect(dispatches.get(task.id)).toBeNull();
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'pending' });
  });
});

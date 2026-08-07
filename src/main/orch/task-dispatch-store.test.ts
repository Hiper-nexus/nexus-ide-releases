import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../persistence/settings-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../persistence/settings-store')>();
  return {
    ...actual,
    getOrchSettings: () => ({
      ...actual.getOrchSettings(),
      fastPath: false,
    }),
  };
});

import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { compileIntentContract, hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore, plannedTaskId } from './task-store';
import {
  assertConcurrentIsolatedWorktreeDisjoint,
  createTaskDispatchStore as createProductionTaskDispatchStore,
  LEGACY_GUIDED_DIRTY_CHECKOUT_BOOTSTRAP_CAUSE,
  LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
  TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
  TASK_DISPATCH_QUALITY_REPAIR_MARKER,
  type TaskDispatchMissionEngine,
} from './task-dispatch-store';
import { assertTaskQualityReceiptAuthority } from './task-dispatch-quality-receipt-authority';
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
import {
  hasAutomaticTechnicalRecovery,
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
} from '../../shared/mission-recovery-policy';
import { physicalAgentActionPayloadSha256 } from './handoff-payload-identity';
import {
  bindTokenToSession,
  mintToken,
  resetGateForTests,
} from './gate';
import {
  mintAgentTransportPhysicalReceipt,
  runInsidePtyStreamAgentTransport,
} from './http-mcp-boundary';
import type {
  MissionBlockInput,
  MissionEngine,
  MissionVerifiedCompletionInput,
} from './mission-engine';

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

function createTaskDispatchStore(
  runtime: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: Parameters<typeof createProductionTaskDispatchStore>[2] = {},
) {
  if (options.missionEngine) {
    return createProductionTaskDispatchStore(runtime, scope, options);
  }
  const missions = createScopedMissionStore(runtime, scope);
  const transition = (
    input: MissionBlockInput | MissionVerifiedCompletionInput,
    patch: Parameters<typeof missions.transitionLifecycle>[2],
  ): void => {
    const current = missions.get(input.missionId);
    if (
      !current ||
      current.status !== input.expectedStatus ||
      current.intentState !== input.expectedIntentState ||
      current.updatedAt !== input.expectedUpdatedAt ||
      (current.intentVersion ?? 0) !== input.expectedIntentVersion
    ) {
      throw new Error('mission engine lifecycle fence changed');
    }
    const updated = missions.transitionLifecycle(
      input.missionId,
      {
        updatedAt: input.expectedUpdatedAt,
        intentVersion: input.expectedIntentVersion,
      },
      patch,
    );
    if (!updated) throw new Error('mission engine lifecycle CAS changed');
  };
  const engine = {
    prepare: async () => {
      throw new Error('not used');
    },
    start: async () => {
      throw new Error('not used');
    },
    command: async () => {
      throw new Error('not used');
    },
    snapshot: async () => {
      throw new Error('not used');
    },
    list: async () => [],
    blockUser: (_scope, input) =>
      transition(input, {
        status: 'blocked',
        intentState: 'blocked_user',
        description: input.description,
      }),
    blockTechnical: (_scope, input) =>
      transition(input, {
        status: 'blocked',
        intentState: 'blocked_technical',
        description: input.description,
      }),
    resumeTechnical: (_scope, input) =>
      transition(input, {
        status: 'running',
        intentState: 'executing',
        description: input.description,
      }),
    completeVerified: (_scope, input) =>
      transition(input, {
        status: 'done',
        intentState: 'done',
        learnings: input.learnings,
      }),
  } satisfies MissionEngine;
  return createProductionTaskDispatchStore(runtime, scope, {
    ...options,
    missionEngine: engine,
  });
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

function insertPhysicalToolAuditIntent(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly sessionId: string;
  readonly toolName: 'nexus_handoff_ack' | 'nexus_mission_set_status';
  readonly toolCallId: string;
  readonly occurredAt: number;
  readonly source?: 'http-mcp' | 'pty-stream';
}): void {
  input.runtime
    .open(input.scope)
    .db.prepare(
      `INSERT INTO audit_events
         (id, mission_id, actor, action, outcome, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, 'intent', ?, ?)`,
    )
    .run(
      `audit-${input.toolCallId}`,
      input.missionId,
      input.sessionId,
      input.toolName,
      JSON.stringify({
        schema: 'nexus.mcp-audit/v1',
        timestamp: new Date(input.occurredAt).toISOString(),
        project_id: input.scope.projectId,
        checkout_id: input.scope.checkoutId,
        source: input.source ?? 'http-mcp',
        invocation_id: input.toolCallId,
        args: {},
        duration_ms: 0,
        user_authorized: false,
      }),
      input.occurredAt,
  );
}

function withPhysicalMaestroReceipt<T>(input: {
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly sessionId: string;
  readonly toolName: 'nexus_handoff_ack' | 'nexus_mission_set_status';
  readonly toolCallId: string;
  readonly invoke: (
    receipt: ReturnType<typeof mintAgentTransportPhysicalReceipt>,
  ) => T;
}): T {
  resetGateForTests();
  const context = mintToken({
    label: 'Maestro físico do teste',
    role: 'orchestrator',
    providerId: 'agy',
    missionId: input.missionId,
    scope: input.scope,
    allowedTools: null,
  });
  bindTokenToSession(context.token, input.sessionId);
  try {
    return runInsidePtyStreamAgentTransport(
      input.sessionId,
      context,
      () => {
        const receipt = mintAgentTransportPhysicalReceipt({
          ctx: context,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
        });
        return input.invoke(receipt);
      },
    );
  } finally {
    resetGateForTests();
  }
}

function acknowledgeHandoffFromPhysicalMaestro(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly handoffs: ReturnType<typeof createScopedHandoffStore>;
  readonly missionId: string;
  readonly sessionId: string;
  readonly handoffId: string;
}): number {
  const toolCallId = `physical-ack-rebind-${++physicalReceiptSequence}`;
  insertPhysicalToolAuditIntent({
    ...input,
    toolName: 'nexus_handoff_ack',
    toolCallId,
    source: 'pty-stream',
    occurredAt: Date.now(),
  });
  const consumed = withPhysicalMaestroReceipt({
    ...input,
    toolName: 'nexus_handoff_ack',
    toolCallId,
    invoke: (receipt) =>
      input.handoffs.markConsumedFromPhysicalAck(
        {
          handoffId: input.handoffId,
          missionId: input.missionId,
          orchestratorSessionId: input.sessionId,
        },
        receipt,
      ),
  });
  expect(consumed).toBe(true);
  return (
    input.runtime
      .open(input.scope)
      .db.prepare(
        `SELECT acknowledged_at FROM handoff_ack_receipts
         WHERE handoff_id = ? AND orchestrator_session_id = ?`,
      )
      .get(input.handoffId, input.sessionId) as {
      acknowledged_at: number;
    }
  ).acknowledged_at;
}

function consolidateFanoutFromPhysicalMaestro(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly dispatches: ReturnType<typeof createTaskDispatchStore>;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly sessionId: string;
  readonly finalOutput: string;
}): boolean {
  const toolCallId = `physical-consolidation-rebind-${++physicalReceiptSequence}`;
  insertPhysicalToolAuditIntent({
    ...input,
    toolName: 'nexus_mission_set_status',
    toolCallId,
    source: 'pty-stream',
    occurredAt: Date.now(),
  });
  return withPhysicalMaestroReceipt({
    ...input,
    toolName: 'nexus_mission_set_status',
    toolCallId,
    invoke: (receipt) =>
      input.dispatches.recordFanoutConsolidation({
        missionId: input.missionId,
        intentVersion: input.intentVersion,
        orchestratorSessionId: input.sessionId,
        finalOutput: input.finalOutput,
        physicalReceipt: receipt,
      }),
  });
}

function insertPhysicalFanoutAck(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly sessionId: string;
  readonly handoffId: string;
  readonly attemptId: string;
}): number {
  const db = input.runtime.open(input.scope).db;
  const consumed = db
    .prepare(`SELECT consumed_at FROM handoffs WHERE id = ?`)
    .get(input.handoffId) as { consumed_at: number };
  const toolCallId = `physical-ack-${++physicalReceiptSequence}`;
  insertPhysicalToolAuditIntent({
    ...input,
    toolName: 'nexus_handoff_ack',
    toolCallId,
    occurredAt: consumed.consumed_at,
  });
  db.prepare(
    `INSERT INTO handoff_ack_receipts
       (receipt_id, handoff_id, delivery_attempt_id, tool_call_id, tool_name,
        source, mission_id, orchestrator_session_id, authority_sha256,
        payload_sha256, issued_at, acknowledged_at)
     VALUES (?, ?, ?, ?, 'nexus_handoff_ack', 'http-mcp', ?, ?, ?, ?, ?, ?)`,
  ).run(
    toolCallId,
    input.handoffId,
    input.attemptId,
    toolCallId,
    input.missionId,
    input.sessionId,
    createHash('sha256').update(toolCallId).digest('hex'),
    physicalAgentActionPayloadSha256('nexus_handoff_ack', {
      handoffId: input.handoffId,
    }),
    consumed.consumed_at,
    consumed.consumed_at,
  );
  return consumed.consumed_at;
}

function insertFanoutConsolidation(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly sessionId: string;
  readonly noEarlierThan: number;
  readonly finalOutput: string;
}): void {
  const db = input.runtime.open(input.scope).db;
  const plan = db
    .prepare(
      `SELECT plan_hash FROM mission_task_plans
       WHERE mission_id = ? AND intent_version = ?`,
    )
    .get(input.missionId, input.intentVersion) as { plan_hash: string };
  const heading = /\n## Maestro\n/iu.exec(input.finalOutput);
  if (!heading) throw new Error('test consolidation requires ## Maestro');
  const maestro = input.finalOutput
    .slice(heading.index + heading[0].length)
    .trim();
  const createdAt = Math.max(input.noEarlierThan, Date.now());
  const toolCallId = `physical-consolidation-${++physicalReceiptSequence}`;
  insertPhysicalToolAuditIntent({
    ...input,
    toolName: 'nexus_mission_set_status',
    toolCallId,
    occurredAt: createdAt,
  });
  db.prepare(
    `INSERT INTO mission_fanout_consolidation_receipts
       (mission_id, intent_version, plan_hash, topology,
        orchestrator_session_id, receipt_id, tool_call_id, tool_name, source,
        authority_sha256, payload_sha256, final_output, final_output_sha256,
        maestro_perspective, maestro_sha256, issued_at, created_at)
     VALUES (?, ?, ?, 'team-read-only-fanout', ?, ?, ?,
             'nexus_mission_set_status', 'http-mcp', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.missionId,
    input.intentVersion,
    plan.plan_hash,
    input.sessionId,
    toolCallId,
    toolCallId,
    createHash('sha256').update(toolCallId).digest('hex'),
    physicalAgentActionPayloadSha256('nexus_mission_set_status', {
      missionId: input.missionId,
      status: 'done',
      note: input.finalOutput,
    }),
    input.finalOutput,
    createHash('sha256').update(input.finalOutput).digest('hex'),
    maestro,
    createHash('sha256').update(maestro).digest('hex'),
    createdAt,
    createdAt,
  );
}

function seedIntegratedQualityAuthority(input: {
  readonly runtime: ProjectRuntimeManager;
  readonly scope: ReturnType<typeof testProjectScope>;
  readonly missionId: string;
  readonly headSha: string;
  readonly label: string;
  readonly goal?: string;
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
      goal: input.goal ?? `Validar integração ${input.label}`,
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
  const initialWorkflow = createWorkflowState(qualityContract.risk, binding);
  const executionIndex = initialWorkflow.route.indexOf('execution');
  store.freeze(
    qualityContract,
    {
      ...initialWorkflow,
      stage: 'execution',
      completedStages: initialWorkflow.route.slice(0, executionIndex),
      revision: executionIndex + 1,
    },
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
    goal?: string;
    mixedTopology?: boolean;
    qualityGoal?: string;
  } = {},
) {
  const runtime = manager();
  const scope = testProjectScope({ rootRealPath: process.cwd() });
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: options.goal ?? `Completar pelo motor (${label})`,
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
    domains: [
      ...(options.mixedTopology
        ? ['team-read-only-fanout']
        : (options.domains ?? [])),
    ],
  };
  const secondaryOwnership = {
    files: ['src/secondary.ts'],
    symbols: [],
    domains: [] as string[],
  };
  const [task, secondaryTask] = tasks.createPlanAtomically({
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
        ...(options.mixedTopology
          ? [
              {
                id: 'secondary-worker',
                agentName: 'Secondary Worker',
                category: 'executor' as const,
                cli: 'codex',
                model: 'gpt-5.6-sol',
                effort: 'high' as const,
              },
            ]
          : []),
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
      ...(options.mixedTopology
        ? [
            {
              plannerId: 'secondary-implement',
              title: 'Implementar caminho secundário',
              detail: encodeTaskScheduleDetail(
                'Implementar e testar o caminho secundário.',
                {
                  dependsOn: [],
                  ownership: secondaryOwnership,
                  merged: false,
                  agentRef: 'secondary-worker',
                  agentCategory: 'executor' as const,
                  executionMode: 'isolated_worktree' as const,
                },
              ),
              agentRef: 'secondary-worker',
              agentCategory: 'executor' as const,
            },
          ]
        : []),
    ],
  });
  const receipt = tasks.getPlanReceipt(mission.id, 7)!;
  let sharedQualityEvidenceIds: readonly string[] | null = null;
  const completePlannedTask = (input: {
    task: NonNullable<typeof task>;
    taskOwnership: typeof ownership;
    workerId: string;
    agentRef: string;
    sessionId: string;
    suffix: string;
  }) => {
    const route = missions.reserveRouteDecision(
      mission.id,
      input.task.title,
      {
        tier: 'hard',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        reason: 'roster selado',
        alternatives: [],
      },
    );
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: input.task.id,
      intentVersion: 7,
      workerId: input.workerId,
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: input.taskOwnership,
      executionMode: 'isolated_worktree',
      agentRef: input.agentRef,
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
      routeContract: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    });
    const routed = dispatches.attachRoute({
      taskId: input.task.id,
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
      taskId: input.task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: `pane-${input.suffix}`,
      sessionId: input.sessionId,
    });
    const handoff = handoffs.submit({
      missionId: mission.id,
      sessionId: input.sessionId,
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: input.workerId,
      status: 'success',
      summary: 'Implementação integrada com testes e commit local verificados.',
    });
    insertPhysicalHandoffAuthority({
      runtime,
      scope,
      missionId: mission.id,
      handoffId: handoff.id,
      sessionId: input.sessionId,
      workerIncarnationId: claim.workerIncarnationId,
      worktreeHeadSha: repositoryHead(),
    });
    const ready = dispatches.acceptHandoff({
      sessionId: input.sessionId,
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    const integratedHeadSha = repositoryHead();
    sharedQualityEvidenceIds ??= seedIntegratedQualityAuthority({
      runtime,
      scope,
      missionId: mission.id,
      headSha: integratedHeadSha,
      label,
      goal: options.qualityGoal,
    });
    dispatches.completeByCoordinator({
      taskId: input.task.id,
      revision: ready.revision,
      receipt: {
        kind: 'worktree_integrated',
        reference: integratedHeadSha,
        completedAt: Date.now(),
        evidenceIds: [...sharedQualityEvidenceIds],
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
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    acknowledgeHandoffFromPhysicalMaestro({
      runtime,
      scope,
      handoffs,
      missionId: mission.id,
      sessionId: 'orchestrator-golden',
      handoffId: handoff.id,
    });
    return { claim, handoff };
  };
  const primary = completePlannedTask({
    task: task!,
    taskOwnership: ownership,
    workerId: 'Golden Worker',
    agentRef: 'worker',
    sessionId: 'session-golden',
    suffix: 'golden',
  });
  if (secondaryTask) {
    completePlannedTask({
      task: secondaryTask,
      taskOwnership: secondaryOwnership,
      workerId: 'Secondary Worker',
      agentRef: 'secondary-worker',
      sessionId: 'session-secondary',
      suffix: 'secondary',
    });
  }
  return {
    runtime,
    scope,
    missions,
    tasks,
    handoffs,
    dispatches,
    mission,
    task: task!,
    handoff: primary.handoff,
  };
}

function guidedNoChangeDispatchFixture(
  options: {
    agentCategory?: 'executor' | 'reviewer';
    domains?: readonly string[];
    agentModel?: string;
    routeModel?: string;
    plannerId?: string;
    orchestratorSessionId?: string;
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
    ...(options.orchestratorSessionId
      ? { orchestratorSessionId: options.orchestratorSessionId }
      : {}),
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
        plannerId: options.plannerId ?? 'guided-quality-gate',
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
  return { runtime, scope, missions, tasks, handoffs, dispatches, mission, handoff, task: task!, ready };
}

/**
 * Sealed guided chain executor → QA: the executor may complete with an
 * honest no-change receipt, but the mission can only finish after the
 * reviewer/QA task validates that outcome.
 */
function guidedImplementationChainFixture() {
  const runtime = manager();
  const scope = testProjectScope({ rootRealPath: process.cwd() });
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: 'Verificar a entrega guiada do executor',
    intentVersion: 5,
  });
  const mission = missions.create({
    title: 'Cadeia guiada executor e QA',
    squadId: 'agentic-guided-squad',
    intentVersion: 5,
    intentState: 'executing',
    intentContract: contract,
    orchestratorSessionId: 'orchestrator-guided-chain',
  });
  missions.setStatus(mission.id, 'running');
  const executorOwnership = {
    files: ['src'],
    symbols: [],
    domains: ['guided-implementation', 'sequential-only'],
  };
  const qaOwnership = {
    files: ['src'],
    symbols: [],
    domains: ['guided-quality-gate', 'sequential-only'],
  };
  const [executorTask, qaTask] = tasks.createPlanAtomically({
    missionId: mission.id,
    intentVersion: 5,
    squad: {
      id: 'agentic-guided-squad',
      agents: [
        {
          id: 'exec',
          agentName: 'Executor guiado',
          category: 'executor',
          cli: 'codex',
          effort: 'high',
        },
        {
          id: 'qa',
          agentName: 'QA independente',
          category: 'reviewer',
          cli: 'codex',
          effort: 'high',
        },
      ],
    },
    rows: [
      {
        plannerId: 'guided-execution',
        title: 'Verificar a entrega',
        detail: encodeTaskScheduleDetail('Verificar e reportar com honestidade.', {
          dependsOn: [],
          ownership: executorOwnership,
          merged: false,
          agentRef: 'exec',
          agentCategory: 'executor',
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'exec',
        agentCategory: 'executor',
      },
      {
        plannerId: 'guided-quality-gate',
        title: 'Validar a verificação',
        detail: encodeTaskScheduleDetail('Validar se o resultado é aceitável.', {
          dependsOn: [],
          ownership: qaOwnership,
          merged: false,
          agentRef: 'qa',
          agentCategory: 'reviewer',
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'qa',
        agentCategory: 'reviewer',
      },
    ],
  });
  const planReceipt = tasks.getPlanReceipt(mission.id, 5)!;
  const route = missions.reserveRouteDecision(mission.id, executorTask!.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'rota selada para o executor guiado',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: executorTask!.id,
    intentVersion: 5,
    workerId: 'Executor guiado',
    leaseOwner: 'main',
    leaseMs: 30_000,
    ownership: executorOwnership,
    executionMode: 'isolated_worktree',
    agentRef: 'exec',
    agentCategory: 'executor',
    rosterHash: planReceipt.rosterHash,
    routeContract: {
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
  });
  const routed = dispatches.attachRoute({
    taskId: executorTask!.id,
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
    taskId: executorTask!.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    workerIncarnationId: claim.workerIncarnationId,
    paneId: 'pane-guided-exec',
    sessionId: 'session-guided-exec',
  });
  const handoff = handoffs.submit({
    missionId: mission.id,
    sessionId: 'session-guided-exec',
    workerIncarnationId: claim.workerIncarnationId,
    fromAgent: 'Executor guiado',
    status: 'success',
    summary: 'Suítes executadas; nenhuma alteração necessária.',
  });
  insertPhysicalHandoffAuthority({
    runtime,
    scope,
    missionId: mission.id,
    handoffId: handoff.id,
    sessionId: 'session-guided-exec',
    workerIncarnationId: claim.workerIncarnationId,
    worktreeHeadSha: repositoryHead(),
  });
  const ready = dispatches.acceptHandoff({
    sessionId: 'session-guided-exec',
    workerIncarnationId: claim.workerIncarnationId,
    handoffId: handoff.id,
  });
  return {
    runtime,
    scope,
    missions,
    tasks,
    handoffs,
    dispatches,
    mission,
    executorTask: executorTask!,
    qaTask: qaTask!,
    handoff,
    ready,
  };
}

function readOnlyPhysicalHandoffFixture(
  options: {
    executionMode?: 'read_only' | 'isolated_worktree' | 'same_checkout';
    worktreeHeadSha?: string;
    teamReadOnlyFanout?: boolean;
    priorLearnings?: string;
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
    files: options.teamReadOnlyFanout ? [] : ['src'],
    symbols: [],
    domains: options.teamReadOnlyFanout
      ? ['guided-advisory', 'team-read-only-fanout']
      : [
          executionMode === 'read_only'
            ? 'guided-advisory'
            : executionMode === 'same_checkout'
              ? 'guided-simple-implementation'
              : 'guided-isolated-advisory',
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
  if (options.priorLearnings) {
    missions.appendLearning(mission.id, options.priorLearnings);
  }
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
          category:
            executionMode === 'same_checkout' ? 'executor' : 'architect',
          cli: 'codex',
          effort: 'high',
        },
      ],
    },
    rows: [
      {
        // A entrega (`simple-implementation`) só pode ser reivindicada pela
        // identidade canônica `guided-execution` — o invariante rejeita
        // qualquer outro plannerId, e é isso que queremos.
        plannerId:
          executionMode === 'same_checkout'
            ? 'guided-execution'
            : 'guided-advisory-1-advisor',
        title: 'Mapear riscos',
        detail: encodeTaskScheduleDetail('Inspecione sem editar.', {
          dependsOn: [],
          ownership,
          merged: false,
          ...(options.teamReadOnlyFanout
            ? { parallelEligible: true }
            : {}),
          agentRef: 'advisor',
          agentCategory:
            executionMode === 'same_checkout' ? 'executor' : 'architect',
          executionMode,
        }),
        agentRef: 'advisor',
        agentCategory: executionMode === 'same_checkout' ? 'executor' : 'architect',
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
    agentCategory:
      executionMode === 'same_checkout' ? 'executor' : 'architect',
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

  // LÁPIDE DA MINA (06/08): um dispatch `same_checkout` em `handoff_ready` era
  // BLOQUEADO — "replaneje com ownership e worktree isolado" — mandando o
  // operador refazer a cerimônia que acabáramos de remover. Com o caminho
  // simples usando same_checkout, isso mataria TODA missão na entrega. Se a
  // suposição voltar, este teste morre antes do usuário.
  it('conclui um dispatch same_checkout a partir do handoff, em vez de rejeitá-lo', () => {
    const fixture = readOnlyPhysicalHandoffFixture({
      executionMode: 'same_checkout',
    });

    const completed = fixture.dispatches.completeSameCheckoutFromTrustedHandoff(
      { taskId: fixture.task.id, revision: fixture.ready.revision },
    );

    expect(completed).toMatchObject({
      state: 'completed',
      integrationReceipt: { kind: 'same_checkout_validated' },
    });
    // A proveniência tem de dizer QUAL forma provou a não-interferência.
    expect(completed.integrationReceipt?.reference).toBeTruthy();
  });

  it('recusa concluir same_checkout sem o recibo físico exato', () => {
    const missing = readOnlyPhysicalHandoffFixture({
      executionMode: 'same_checkout',
    });
    missing.runtime
      .open(missing.scope)
      .db.prepare(`DELETE FROM handoff_mcp_receipts WHERE handoff_id = ?`)
      .run(missing.handoff.id);

    expect(() =>
      missing.dispatches.completeSameCheckoutFromTrustedHandoff({
        taskId: missing.task.id,
        revision: missing.ready.revision,
      }),
    ).toThrow(/physical|receipt|recibo/i);
    expect(missing.dispatches.get(missing.task.id)?.state).toBe('handoff_ready');
  });

  it('delegates fan-out terminal completion exactly once without raw-writing mission state', () => {
    const fixture = readOnlyPhysicalHandoffFixture({
      teamReadOnlyFanout: true,
    });
    fixture.dispatches.completeReadOnlyFromTrustedHandoff({
      taskId: fixture.task.id,
      revision: fixture.ready.revision,
    });
    const handoffs = createScopedHandoffStore(fixture.runtime, fixture.scope);
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: fixture.handoff.id,
      missionId: fixture.mission.id,
      orchestratorSessionId: 'orchestrator-guided-advisor',
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: fixture.handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: fixture.handoff.id,
      }),
    ).toBe(true);
    acknowledgeHandoffFromPhysicalMaestro({
      runtime: fixture.runtime,
      scope: fixture.scope,
      handoffs,
      missionId: fixture.mission.id,
      sessionId: 'orchestrator-guided-advisor',
      handoffId: fixture.handoff.id,
    });
    const completeVerified = vi.fn(
      (
        _scope: ProjectExecutionScope,
        _input: MissionVerifiedCompletionInput,
      ) => undefined,
    );
    const dispatches = createTaskDispatchStore(
      fixture.runtime,
      fixture.scope,
      {
        missionEngine: {
          blockUser: vi.fn(),
          blockTechnical: vi.fn(),
          resumeTechnical: vi.fn(),
          completeVerified,
        } satisfies TaskDispatchMissionEngine,
      },
    );
    const finalOutput =
      '# Consolidação final\n## Especialistas\nPerspectivas verificadas.\n\n' +
      '## Maestro\nSíntese física concluída.';

    expect(
      consolidateFanoutFromPhysicalMaestro({
        runtime: fixture.runtime,
        scope: fixture.scope,
        dispatches,
        missionId: fixture.mission.id,
        intentVersion: 4,
        sessionId: 'orchestrator-guided-advisor',
        finalOutput,
      }),
    ).toBe(true);
    expect(completeVerified).toHaveBeenCalledOnce();
    expect(completeVerified).toHaveBeenCalledWith(
      fixture.scope,
      expect.objectContaining({
        missionId: fixture.mission.id,
        expectedStatus: 'running',
        expectedIntentState: 'executing',
        expectedIntentVersion: 4,
        learnings: finalOutput,
      }),
    );
    expect(
      createScopedMissionStore(fixture.runtime, fixture.scope).get(
        fixture.mission.id,
      ),
    ).toMatchObject({
      status: 'running',
      intentState: 'executing',
      learnings: '',
    });
  });

  it('keeps fan-out running after the last ACK and completes after durable Maestro consolidation recovery', () => {
    const fixture = readOnlyPhysicalHandoffFixture({
      teamReadOnlyFanout: true,
      priorLearnings: 'H'.repeat(65_536),
    });
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

    const handoffs = createScopedHandoffStore(fixture.runtime, fixture.scope);
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: fixture.handoff.id,
      missionId: fixture.mission.id,
      orchestratorSessionId: 'orchestrator-guided-advisor',
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: fixture.handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: fixture.handoff.id,
      }),
    ).toBe(true);
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
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
    const missionStore = createScopedMissionStore(
      fixture.runtime,
      fixture.scope,
    );
    expect(missionStore.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });

    const lastAckAt = insertPhysicalFanoutAck({
      runtime: fixture.runtime,
      scope: fixture.scope,
      missionId: fixture.mission.id,
      sessionId: 'orchestrator-guided-advisor',
      handoffId: fixture.handoff.id,
      attemptId: attempt.id,
    });
    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
    expect(missionStore.get(fixture.mission.id)?.status).toBe('running');

    const finalSuffix =
      '\n\n## Maestro\nMinha síntese prioriza liveness e validação completa ' +
      'sem bloquear o usuário.\nFIM-DA-SINTESE-MAESTRO';
    const finalPrefix =
      '# Consolidação da rodada\n## Especialistas\nPerspectivas verificadas.\n';
    const finalOutput =
      finalPrefix +
      'R'.repeat(65_536 - finalPrefix.length - finalSuffix.length) +
      finalSuffix;
    insertFanoutConsolidation({
      runtime: fixture.runtime,
      scope: fixture.scope,
      missionId: fixture.mission.id,
      intentVersion: 4,
      sessionId: 'orchestrator-guided-advisor',
      noEarlierThan: lastAckAt,
      finalOutput,
    });

    fixture.runtime.close(fixture.scope);
    const restartedDispatches = createTaskDispatchStore(
      fixture.runtime,
      fixture.scope,
    );
    expect(
      restartedDispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(true);
    const restartedMission = createScopedMissionStore(
      fixture.runtime,
      fixture.scope,
    ).get(fixture.mission.id);
    expect(restartedMission).toMatchObject({
      status: 'done',
      intentState: 'done',
      learnings: expect.stringContaining('## Maestro'),
    });
    expect(restartedMission?.learnings).toBe(finalOutput);
    expect(restartedMission?.learnings).toHaveLength(65_536);
    expect(restartedMission?.learnings).toMatch(/FIM-DA-SINTESE-MAESTRO$/);
  });

  it('rebinds fan-out after an old physical ACK without wedging current consolidation', () => {
    const fixture = readOnlyPhysicalHandoffFixture({
      teamReadOnlyFanout: true,
    });
    fixture.dispatches.completeReadOnlyFromTrustedHandoff({
      taskId: fixture.task.id,
      revision: fixture.ready.revision,
    });
    const handoffs = createScopedHandoffStore(fixture.runtime, fixture.scope);
    const missions = createScopedMissionStore(fixture.runtime, fixture.scope);
    const oldSessionId = 'orchestrator-guided-advisor';
    const currentSessionId = 'orchestrator-guided-advisor-rebound';
    const oldAttempt = handoffs.reserveDeliveryAttempt({
      handoffId: fixture.handoff.id,
      missionId: fixture.mission.id,
      orchestratorSessionId: oldSessionId,
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: oldAttempt.id,
      handoffId: fixture.handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: oldAttempt.id,
        handoffId: fixture.handoff.id,
      }),
    ).toBe(true);
    acknowledgeHandoffFromPhysicalMaestro({
      runtime: fixture.runtime,
      scope: fixture.scope,
      handoffs,
      missionId: fixture.mission.id,
      sessionId: oldSessionId,
      handoffId: fixture.handoff.id,
    });

    expect(
      missions.rebindOrchestratorSession(
        fixture.mission.id,
        currentSessionId,
      ),
    ).toMatchObject({
      orchestratorSessionId: currentSessionId,
      status: 'running',
    });
    expect(handoffs.get(fixture.handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: 'queued',
    });
    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);

    const currentAttempt = handoffs.reserveDeliveryAttempt({
      handoffId: fixture.handoff.id,
      missionId: fixture.mission.id,
      orchestratorSessionId: currentSessionId,
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: currentAttempt.id,
      handoffId: fixture.handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: currentAttempt.id,
        handoffId: fixture.handoff.id,
      }),
    ).toBe(true);
    acknowledgeHandoffFromPhysicalMaestro({
      runtime: fixture.runtime,
      scope: fixture.scope,
      handoffs,
      missionId: fixture.mission.id,
      sessionId: currentSessionId,
      handoffId: fixture.handoff.id,
    });
    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
    const currentOutput =
      '# Consolidação recuperada\n## Especialistas\nRodada atual.\n\n' +
      '## Maestro\nA nova sessão confirmou todos os ACKs antes de concluir.';
    expect(consolidateFanoutFromPhysicalMaestro({
      runtime: fixture.runtime,
      scope: fixture.scope,
      dispatches: fixture.dispatches,
      missionId: fixture.mission.id,
      intentVersion: 4,
      sessionId: currentSessionId,
      finalOutput: currentOutput,
    })).toBe(true);

    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
    expect(missions.get(fixture.mission.id)).toMatchObject({
      status: 'done',
      intentState: 'done',
      learnings: currentOutput,
    });
    const db = fixture.runtime.open(fixture.scope).db;
    expect(
      db
        .prepare(
          `SELECT orchestrator_session_id, delivery_attempt_id
           FROM handoff_ack_receipts WHERE handoff_id = ?
           ORDER BY acknowledged_at, receipt_id`,
        )
        .all(fixture.handoff.id),
    ).toEqual([
      {
        orchestrator_session_id: oldSessionId,
        delivery_attempt_id: oldAttempt.id,
      },
      {
        orchestrator_session_id: currentSessionId,
        delivery_attempt_id: currentAttempt.id,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT orchestrator_session_id
           FROM mission_fanout_consolidation_receipts
           WHERE mission_id = ? AND intent_version = ?
           ORDER BY created_at, receipt_id`,
        )
        .all(fixture.mission.id, 4),
    ).toEqual([
      { orchestrator_session_id: currentSessionId },
    ]);
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

  it('accepts the implementation no-change receipt from the sealed guided executor with physical evidence', () => {
    const fixture = guidedNoChangeDispatchFixture({
      agentCategory: 'executor',
      domains: ['guided-implementation', 'sequential-only'],
      plannerId: 'guided-execution',
      orchestratorSessionId: 'orchestrator-guided-implementation',
    });
    const headSha = repositoryHead();

    const completed = fixture.dispatches.completeByCoordinator({
      taskId: fixture.task.id,
      revision: fixture.ready.revision,
      receipt: {
        kind: 'worktree_validated_no_change',
        reference: `no-change:${headSha}:${EMPTY_GIT_DIFF_SHA256}`,
        completedAt: Date.now(),
        evidenceIds: [fixture.handoff.id],
      },
    });

    expect(completed).toMatchObject({
      state: 'completed',
      integrationReceipt: {
        kind: 'worktree_validated_no_change',
        reference: `no-change:${headSha}:${EMPTY_GIT_DIFF_SHA256}`,
        evidenceIds: [fixture.handoff.id],
      },
    });
    // No PREVC quality proof: the downstream reviewer/QA chain validates the
    // "no change" outcome, not the merge lane.
    expect(completed.integrationReceipt?.qualityProof).toBeUndefined();

    const attempt = fixture.handoffs.reserveDeliveryAttempt({
      handoffId: fixture.handoff.id,
      missionId: fixture.mission.id,
      orchestratorSessionId: 'orchestrator-guided-implementation',
      maxAttempts: 2,
    });
    fixture.handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: fixture.handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(
      fixture.handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: fixture.handoff.id,
      }),
    ).toBe(true);
    acknowledgeHandoffFromPhysicalMaestro({
      runtime: fixture.runtime,
      scope: fixture.scope,
      handoffs: fixture.handoffs,
      missionId: fixture.mission.id,
      sessionId: 'orchestrator-guided-implementation',
      handoffId: fixture.handoff.id,
    });
    // The mission-level authority replays the whole chain and admits the
    // executor no-change receipt with all physical proofs re-verified.
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 3,
      }),
    ).toBe(true);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('rejects the implementation no-change receipt when the checkout advanced past the sealed base', () => {
    const fixture = guidedNoChangeDispatchFixture({
      agentCategory: 'executor',
      domains: ['guided-implementation', 'sequential-only'],
      plannerId: 'guided-execution',
    });

    expect(() =>
      fixture.dispatches.completeByCoordinator({
        taskId: fixture.task.id,
        revision: fixture.ready.revision,
        receipt: {
          kind: 'worktree_validated_no_change',
          reference: `no-change:${'c'.repeat(40)}:${EMPTY_GIT_DIFF_SHA256}`,
          completedAt: Date.now(),
          evidenceIds: [fixture.handoff.id],
        },
      }),
    ).toThrow(/no-change|physical|HEAD/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'handoff_ready',
      integrationReceipt: undefined,
    });
  });

  it.each([
    {
      label: 'sem evidência',
      evidenceIds: [] as string[],
      reference: `no-change:${'a'.repeat(40)}:${EMPTY_GIT_DIFF_SHA256}`,
    },
    {
      label: 'com hash de diff fabricado',
      evidenceIds: ['handoff-guided-implementation'],
      reference: `no-change:${'a'.repeat(40)}:${'e'.repeat(64)}`,
    },
    {
      label: 'com referência não física',
      evidenceIds: ['handoff-guided-implementation'],
      reference: 'handoff-only',
    },
  ])('rejects the implementation no-change receipt $label', ({ evidenceIds, reference }) => {
    const fixture = guidedNoChangeDispatchFixture({
      agentCategory: 'executor',
      domains: ['guided-implementation', 'sequential-only'],
      plannerId: 'guided-execution',
    });

    expect(() =>
      fixture.dispatches.completeByCoordinator({
        taskId: fixture.task.id,
        revision: fixture.ready.revision,
        receipt: {
          kind: 'worktree_validated_no_change',
          reference,
          completedAt: Date.now(),
          evidenceIds,
        },
      }),
    ).toThrow(/no-change|inválido|evidência|physical|HEAD/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'handoff_ready',
      integrationReceipt: undefined,
    });
  });

  it('does not let an executor no-change receipt finish the mission without the reviewer chain', () => {
    const fixture = guidedImplementationChainFixture();
    const headSha = repositoryHead();

    const completed = fixture.dispatches.completeByCoordinator({
      taskId: fixture.executorTask.id,
      revision: fixture.ready.revision,
      receipt: {
        kind: 'worktree_validated_no_change',
        reference: `no-change:${headSha}:${EMPTY_GIT_DIFF_SHA256}`,
        completedAt: Date.now(),
        evidenceIds: [fixture.handoff.id],
      },
    });
    expect(completed.state).toBe('completed');

    // A lazy executor gets no free pass: while the sealed reviewer/QA task
    // is unfinished — or later rejects — the mission can never complete on
    // the executor's no-change receipt alone; the normal chain owns the
    // verdict on whether "no change" is acceptable for the goal.
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 5,
      }),
    ).toBe(false);
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(fixture.dispatches.get(fixture.qaTask.id)).toBeNull();
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

  it('returns the immutable physical handoff HEAD as merge authority', () => {
    const { dispatches, task, ready } = guidedNoChangeDispatchFixture();
    const expectedHeadSha = repositoryHead();

    expect(
      dispatches.assertPhysicalHandoffTaskHead({
        taskId: task.id,
        missionId: ready.missionId,
        intentVersion: ready.intentVersion,
        expectedStates: ['handoff_ready'],
      }),
    ).toBe(expectedHeadSha);
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

  it('allows exclusive QA claim while a parallel-eligible advisor dispatch is still active', () => {
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
      goal: 'Release gate QA after advisory scout',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Release E2E ownership fence',
      squadId: 'agentic-e2e-squad',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const advisorOwnership = {
      files: [] as string[],
      symbols: [] as string[],
      domains: ['guided-advisory'],
    };
    const qaOwnership = {
      files: ['resultado.txt'],
      symbols: [] as string[],
      domains: ['guided-quality-gate', 'sequential-only'],
    };
    const [advisorTask, qaTask] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: {
        id: 'agentic-e2e-squad',
        agents: [
          {
            id: 'scout',
            agentName: 'Advisor Grok',
            category: 'scout',
            cli: 'grok',
            effort: 'medium',
          },
          {
            id: 'qa',
            agentName: 'E2E QA',
            category: 'reviewer',
            cli: 'codex',
            effort: 'high',
          },
        ],
      },
      rows: [
        {
          plannerId: 'guided-advisory-scout',
          title: 'Scout advisory',
          detail: encodeTaskScheduleDetail('Advise only.', {
            dependsOn: [],
            ownership: advisorOwnership,
            merged: false,
            agentRef: 'scout',
            agentCategory: 'scout',
            executionMode: 'read_only',
          }),
          agentRef: 'scout',
          agentCategory: 'scout',
        },
        {
          plannerId: 'guided-quality-gate',
          title: 'QA final',
          detail: encodeTaskScheduleDetail('Validate resultado.txt.', {
            dependsOn: [],
            ownership: qaOwnership,
            merged: false,
            agentRef: 'qa',
            agentCategory: 'reviewer',
            executionMode: 'read_only',
          }),
          agentRef: 'qa',
          agentCategory: 'reviewer',
        },
      ],
    });
    const planReceipt = tasks.getPlanReceipt(mission.id, 1)!;
    const advisorClaim = dispatches.claim({
      missionId: mission.id,
      taskId: advisorTask!.id,
      intentVersion: 1,
      workerId: 'Advisor Grok',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: advisorOwnership,
      executionMode: 'read_only',
      agentRef: 'scout',
      agentCategory: 'scout',
      rosterHash: planReceipt.rosterHash,
      routeContract: {
        adapterId: 'grok',
        model: 'grok-4.5',
        effort: 'medium',
      },
    });
    expect(advisorClaim.state).toBe('claimed');

    // Parallel scout still active must not fence exclusive QA claim.
    const qaClaim = dispatches.claim({
      missionId: mission.id,
      taskId: qaTask!.id,
      intentVersion: 1,
      workerId: 'E2E QA',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: qaOwnership,
      executionMode: 'read_only',
      agentRef: 'qa',
      agentCategory: 'reviewer',
      rosterHash: planReceipt.rosterHash,
      routeContract: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    });
    expect(qaClaim).toMatchObject({
      taskId: qaTask!.id,
      state: 'claimed',
    });
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
    const completeVerified = vi.fn(
      (
        _scope: ProjectExecutionScope,
        input: MissionVerifiedCompletionInput,
      ) => {
        const current = missions.get(input.missionId);
        if (
          !current ||
          current.status !== input.expectedStatus ||
          current.intentState !== input.expectedIntentState
        ) {
          throw new Error('test engine lifecycle fence changed');
        }
        const completed = missions.transitionLifecycle(
          input.missionId,
          {
            updatedAt: input.expectedUpdatedAt,
            intentVersion: input.expectedIntentVersion,
          },
          {
            status: 'done',
            intentState: 'done',
            learnings: input.learnings,
          },
        );
        if (!completed) throw new Error('test engine completion CAS changed');
      },
    );
    const missionEngine = {
      blockUser: () => {
        throw new Error('unexpected user block');
      },
      blockTechnical: () => {
        throw new Error('unexpected technical block');
      },
      resumeTechnical: () => {
        throw new Error('unexpected technical resume');
      },
      completeVerified,
    } satisfies TaskDispatchMissionEngine;
    const dispatches = createTaskDispatchStore(runtime, scope, {
      missionEngine,
    });
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
    runtime.close(scope);
    const restartedMissions = createScopedMissionStore(runtime, scope);
    const restartedDispatches = createTaskDispatchStore(runtime, scope, {
      missionEngine,
    });
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
    expect(restartedHandoffs.get(handoff.id)).toMatchObject({
      delivered: true,
      deliveryState: 'submitted',
      consumedAt: undefined,
    });
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
    ).toBe(false);
    expect(restartedMissions.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'validating',
    });
    acknowledgeHandoffFromPhysicalMaestro({
      runtime,
      scope,
      handoffs: restartedHandoffs,
      missionId: mission.id,
      sessionId: 'orchestrator-golden-rebound',
      handoffId: handoff.id,
    });
    expect(restartedHandoffs.get(handoff.id)).toMatchObject({
      deliveryState: 'consumed',
      consumedBySession: 'orchestrator-golden-rebound',
      consumedDeliveryAttemptId: reboundAttempt.id,
    });
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
      /Conclusão automática verificada[\s\S]*handoffs aceitos pela sessão atual/i,
    );
    expect(completeVerified).toHaveBeenCalledOnce();
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

  it('keeps an existing delivery receipt PREVC-owned when its goal now matches the fan-out classifier', () => {
    const fixture = verifiedPlanFixture('delivery-receipt-topology', {
      squadId: 'agentic-guided-delivery-receipt',
      goal: 'todos os panes me falam o que fazem nesta missão',
    });

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

  it('refuses a fully verified mixed-marker plan from a saved squad', () => {
    const fixture = verifiedPlanFixture('custom-mixed-topology', {
      squadId: 'saved-mixed-squad',
      goal: 'todos os panes me falam o que fazem nesta missão',
      mixedTopology: true,
    });

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

  it('replays guided inspection without invoking terminal engine authority', () => {
    const fixture = verifiedPlanFixture('guided-physical-replay', {
      squadId: 'agentic-guided-physical-replay',
    });
    const completeVerified = vi.fn(
      (
        _scope: ProjectExecutionScope,
        _input: MissionVerifiedCompletionInput,
      ) => undefined,
    );
    const inspecting = createTaskDispatchStore(
      fixture.runtime,
      fixture.scope,
      {
        missionEngine: {
          blockUser: vi.fn(),
          blockTechnical: vi.fn(),
          resumeTechnical: vi.fn(),
          completeVerified,
        } satisfies TaskDispatchMissionEngine,
      },
    );
    const input = {
      missionId: fixture.mission.id,
      intentVersion: 7,
    };

    expect(inspecting.hasVerifiedGuidedPlanAuthority(input)).toBe(true);
    expect(inspecting.hasVerifiedGuidedPlanAuthority(input)).toBe(true);
    expect(completeVerified).not.toHaveBeenCalled();
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
    expect(completeVerified).not.toHaveBeenCalled();
    expect(
      createScopedMissionStore(fixture.runtime, fixture.scope).get(
        fixture.mission.id,
      ),
    ).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('keeps guided physical authority after PREVC advances past the quality receipt revision', () => {
    const fixture = verifiedPlanFixture('guided-prevc-revision-advance', {
      squadId: 'agentic-guided-prevc-revision-advance',
      qualityGoal: 'Validar autenticação e permissões da integração',
    });
    const db = fixture.runtime.open(fixture.scope).db;
    const row = db
      .prepare(
        `SELECT revision, workflow_json
           FROM workflow_states
          WHERE mission_id = ?`,
      )
      .get(fixture.mission.id) as {
      revision: number;
      workflow_json: string;
    };
    const workflow = JSON.parse(row.workflow_json) as {
      risk: string;
      revision: number;
      route: string[];
      stage: string;
      completedStages: string[];
    };
    const advanced = {
      ...workflow,
      revision: row.revision + 1,
      stage: 'validation-primary',
      completedStages: [...workflow.completedStages, 'execution'],
    };
    db.prepare(
      `UPDATE workflow_states
          SET revision = ?, stage = ?, workflow_json = ?, updated_at = ?
        WHERE mission_id = ? AND revision = ?`,
    ).run(
      advanced.revision,
      advanced.stage,
      JSON.stringify(advanced),
      Date.now(),
      fixture.mission.id,
      row.revision,
    );

    expect(
      fixture.dispatches.get(fixture.task.id)?.integrationReceipt?.qualityProof,
    ).toMatchObject({ workflowRevision: row.revision });
    expect(workflow.risk).toBe('high');
    expect(row.revision).toBe(workflow.route.indexOf('execution') + 1);
    const receipt = fixture.dispatches.get(
      fixture.task.id,
    )!.integrationReceipt!;
    expect(() =>
      assertTaskQualityReceiptAuthority({
        db,
        coordinates: fixture.scope,
        rootRealPath: fixture.scope.rootRealPath,
        missionId: fixture.mission.id,
        physicalHeadSha: repositoryHead(),
        receipt,
      }),
    ).toThrow('task quality receipt requires current PREVC execution authority');
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(true);

    db.prepare(
      `UPDATE task_dispatch_queue
          SET integration_receipt_json = ?
        WHERE task_id = ?`,
    ).run(
      JSON.stringify({
        ...receipt,
        qualityProof: {
          ...receipt.qualityProof!,
          workflowRevision: row.revision - 1,
        },
      }),
      fixture.task.id,
    );
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);

    db.prepare(
      `UPDATE task_dispatch_queue
          SET integration_receipt_json = ?
        WHERE task_id = ?`,
    ).run(
      JSON.stringify({
        ...receipt,
        qualityProof: {
          ...receipt.qualityProof!,
          workflowRevision: advanced.revision + 1,
        },
      }),
      fixture.task.id,
    );
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 7,
      }),
    ).toBe(false);
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

  it('stops retrying after bounded physical exits and preserves a terminal auth/config block', () => {
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
      title: 'Worker com login inválido',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: approvedIntentContract({
        goal: 'Evitar retry infinito de uma CLI sem autenticação',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Executar advisor autenticado',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'grok',
      effort: 'medium',
      reason: 'rota de advisor',
      alternatives: [],
    });

    for (
      let attempt = 1;
      attempt <= TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS;
      attempt += 1
    ) {
      const claim = dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'advisor-grok',
        leaseOwner: 'main',
        leaseMs: 30_000,
      });
      expect(claim.attempt).toBe(attempt);
      const routed = dispatches.attachRoute({
        taskId: task.id,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: 'grok',
      });
      dispatches.bindSpawn({
        taskId: task.id,
        revision: routed.revision,
        leaseToken: claim.leaseToken,
        paneId: `pane-grok-${attempt}`,
        sessionId: `session-grok-${attempt}`,
        workerIncarnationId: claim.workerIncarnationId,
      });

      const exited = dispatches.blockSessionExit({
        sessionId: `session-grok-${attempt}`,
        workerIncarnationId: claim.workerIncarnationId,
        reason: TASK_DISPATCH_SESSION_EXIT_REASON,
      });
      if (attempt < TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS) {
        expect(exited?.state).toBe('superseded');
        expect(tasks.list(mission.id)[0]?.status).toBe('pending');
        expect(missions.get(mission.id)?.status).toBe('running');
        now = exited!.leaseExpiresAt + 1;
      } else {
        expect(exited).toMatchObject({
          state: 'blocked',
          attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
        });
      }
    }

    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(blockedMission.description).toContain(
      TERMINAL_OPERATIONAL_FAILURE_MARKER,
    );
    expect(blockedMission.description).toMatch(
      /3 tentativas físicas.*autenticação|autenticação.*3 tentativas físicas/is,
    );
    expect(hasAutomaticTechnicalRecovery(blockedMission)).toBe(false);
    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'advisor-grok',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/missão running|task dispatch exige missão running/i);
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

  it('bounds repeated missing-runtime rebinds without losing the worktree identity', () => {
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
      title: 'Runtime desaparece repetidamente',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Parar recuperação física que não progride',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Preservar worktree do worker',
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
      workerId: 'worker-runtime-loop',
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
    const paneId = 'pane-runtime-loop';
    let sessionId = 'session-runtime-1';
    let running = dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId,
      sessionId,
      workerIncarnationId: claim.workerIncarnationId,
    });

    for (
      let attempt = 1;
      attempt <= TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS;
      attempt += 1
    ) {
      expect(running.attempt).toBe(attempt);
      const recovered = dispatches.requeueMissingRuntime({
        taskId: task.id,
        revision: running.revision,
      });
      if (attempt < TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS) {
        expect(recovered.state).toBe('superseded');
        now = recovered.leaseExpiresAt + 1;
        const replacementSessionId = `session-runtime-${attempt + 1}`;
        running = dispatches.rebindRestartedWorker({
          missionId: mission.id,
          paneId,
          expectedSessionId: sessionId,
          replacementSessionId,
          workerIncarnationId: claim.workerIncarnationId,
          leaseMs: 30_000,
        });
        sessionId = replacementSessionId;
        expect(running).toMatchObject({
          state: 'running',
          paneId,
          sessionId,
          workerIncarnationId: claim.workerIncarnationId,
        });
      } else {
        expect(recovered).toMatchObject({
          state: 'blocked',
          attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
          paneId,
          sessionId,
        });
      }
    }

    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.description).toContain(
      TERMINAL_OPERATIONAL_FAILURE_MARKER,
    );
    expect(hasAutomaticTechnicalRecovery(blockedMission)).toBe(false);
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

  it('reopens the exact third session-exit block when bootstrap classifies it retryable', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    let now = 10_000;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
      now: () => now,
    });
    const mission = missions.create({
      title: 'Retry classificado após exit',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Distinguir exit transitório de bloqueio terminal',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      reason: 'rota de bootstrap',
      alternatives: [],
    });

    for (let attempt = 1; attempt < TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS; attempt += 1) {
      const claim = dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-exit-retry',
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
      dispatches.markSpawning({
        taskId: task.id,
        revision: routed.revision,
        leaseToken: claim.leaseToken,
      });
      const retry = dispatches.requeueTechnicalBootstrapFailure({
        taskId: task.id,
        missionId: mission.id,
        leaseToken: claim.leaseToken,
        workerIncarnationId: claim.workerIncarnationId,
        error: `falha transitória ${attempt}`,
      });
      now = retry.leaseExpiresAt;
    }

    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-exit-retry',
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
    const paneId = 'pane-exit-retry-3';
    const sessionId = 'session-exit-retry-3';
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId,
      sessionId,
      workerIncarnationId: claim.workerIncarnationId,
    });
    const exitBlock = dispatches.blockSessionExit({
      sessionId,
      workerIncarnationId: claim.workerIncarnationId,
      reason: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
    expect(exitBlock).toMatchObject({
      state: 'blocked',
      attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    expect(missions.get(mission.id)?.status).toBe('blocked');

    const retry = dispatches.requeueTechnicalBootstrapFailure({
      taskId: task.id,
      missionId: mission.id,
      leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId,
      sessionId,
      error: 'provider saiu durante bootstrap retryable',
    });

    expect(retry).toMatchObject({
      state: 'superseded',
      attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
      lastError: 'provider saiu durante bootstrap retryable',
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('pending');
    expect(missions.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(missions.get(mission.id)?.description).not.toContain(
      TERMINAL_OPERATIONAL_FAILURE_MARKER,
    );
    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-exit-retry',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/capacity_wait.*retry técnico/i);
  });

  it('keeps retryable bootstrap failures live beyond three attempts with durable bounded backoff', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    let now = 10_000;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
      now: () => now,
    });
    const mission = missions.create({
      title: 'Bootstrap falha antes do pane',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Evitar loop de spawn sem processo físico',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      reason: 'rota de bootstrap',
      alternatives: [],
    });

    const retryableAttempts = TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS + 4;
    let previousBackoffMs = 0;
    for (let attempt = 1; attempt <= retryableAttempts; attempt += 1) {
      const claim = dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-bootstrap-loop',
        leaseOwner: 'main',
        leaseMs: 30_000,
      });
      expect(claim.attempt).toBe(attempt);
      const routed = dispatches.attachRoute({
        taskId: task.id,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: 'codex',
      });
      dispatches.markSpawning({
        taskId: task.id,
        revision: routed.revision,
        leaseToken: claim.leaseToken,
      });
      const recovered = dispatches.requeueTechnicalBootstrapFailure({
        taskId: task.id,
        missionId: mission.id,
        leaseToken: claim.leaseToken,
        workerIncarnationId: claim.workerIncarnationId,
        error: `provider falhou antes do pane (${attempt})`,
      });
      expect(recovered).toMatchObject({
        state: 'superseded',
        attempt,
        lastError: `provider falhou antes do pane (${attempt})`,
      });
      expect(tasks.list(mission.id)[0]?.status).toBe('pending');
      expect(missions.get(mission.id)).toMatchObject({
        status: 'running',
        intentState: 'executing',
      });
      const backoffMs = recovered.leaseExpiresAt - now;
      expect(backoffMs).toBeGreaterThan(0);
      expect(backoffMs).toBeGreaterThanOrEqual(previousBackoffMs);
      expect(backoffMs).toBeLessThanOrEqual(30_000);
      previousBackoffMs = backoffMs;

      // The persisted retry fence must reject scheduler ticks until its exact
      // deadline; this is the spawn-storm guard, not a retry-count terminal.
      expect(() =>
        dispatches.claim({
          missionId: mission.id,
          taskId: task.id,
          intentVersion: 1,
          workerId: 'worker-bootstrap-loop',
          leaseOwner: 'main',
          leaseMs: 30_000,
        }),
      ).toThrow(/capacity_wait.*retry técnico/i);

      // A duplicated catch for the same physical attempt is idempotent, even
      // after the old session-exit threshold.
      expect(
        dispatches.requeueTechnicalBootstrapFailure({
          taskId: task.id,
          missionId: mission.id,
          leaseToken: claim.leaseToken,
          workerIncarnationId: claim.workerIncarnationId,
          error: `provider falhou antes do pane (${attempt})`,
        }),
      ).toEqual(recovered);
      now = recovered.leaseExpiresAt;
    }

    expect(dispatches.get(task.id)).toMatchObject({
      state: 'superseded',
      attempt: retryableAttempts,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('pending');
    const liveMission = missions.get(mission.id)!;
    expect(liveMission).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(liveMission.description).not.toContain(
      TERMINAL_OPERATIONAL_FAILURE_MARKER,
    );
  });

  it('atomically reopens only the exhausted legacy dirty-checkout bootstrap block', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    let now = 10_000;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
      now: () => now,
    });
    const mission = missions.create({
      title: 'Checkout primário legado',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Continuar após o checkpoint automático corrigido',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Criar worker guided',
    });
    const siblingTask = tasks.create({
      missionId: mission.id,
      title: 'Criar reviewer guided',
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-guided-legacy',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: {
        files: ['src/worker.ts'],
        symbols: [],
        domains: [],
      },
    });
    const siblingClaim = dispatches.claim({
      missionId: mission.id,
      taskId: siblingTask.id,
      intentVersion: 1,
      workerId: 'reviewer-guided-legacy',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: {
        files: ['src/reviewer.ts'],
        symbols: [],
        domains: [],
      },
    });
    dispatches.fail({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      error: LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
    });
    missions.update(mission.id, {
      status: 'running',
      intentState: 'executing',
    });
    const revokedSibling = dispatches.get(siblingTask.id);
    if (!revokedSibling) throw new Error('revoked sibling dispatch missing');
    dispatches.fail({
      taskId: siblingTask.id,
      revision: revokedSibling.revision,
      leaseToken: siblingClaim.leaseToken,
      error: LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
    });
    runtime
      .open(scope)
      .db.prepare(
        `UPDATE task_dispatch_queue
            SET state = 'blocked', attempt = ?
          WHERE mission_id = ? AND state = 'failed'`,
      )
      .run(TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS, mission.id);

    const blocked = dispatches.get(task.id)!;
    expect(blocked).toMatchObject({
      state: 'blocked',
      attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
    });
    expect(tasks.list(mission.id).map((record) => record.status)).toEqual([
      'failed',
      'failed',
    ]);
    expect(missions.get(mission.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    now += 1;
    const recovered =
      dispatches.recoverLegacyGuidedDirtyCheckoutBootstrap(task.id);
    const recoveredSibling =
      dispatches.recoverLegacyGuidedDirtyCheckoutBootstrap(siblingTask.id);
    const recoveredAgain =
      dispatches.recoverLegacyGuidedDirtyCheckoutBootstrap(task.id);

    expect(recovered).toMatchObject({
      state: 'superseded',
      attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
      lastError: LEGACY_GUIDED_DIRTY_CHECKOUT_BOOTSTRAP_CAUSE,
    });
    expect(recovered).not.toBeNull();
    if (!recovered) {
      throw new Error('legacy dirty-checkout recovery returned null');
    }
    expect(recoveredAgain).toEqual(recovered);
    expect(recoveredSibling).toMatchObject({
      state: 'superseded',
      attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
      lastError: LEGACY_GUIDED_DIRTY_CHECKOUT_BOOTSTRAP_CAUSE,
    });
    expect(recovered.leaseExpiresAt).toBeGreaterThan(now);
    expect(tasks.list(mission.id).map((record) => record.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(missions.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(missions.get(mission.id)?.description).not.toContain(
      TASK_DISPATCH_BLOCK_MARKER,
    );
  });

  it('does not reopen an exhausted bootstrap block with another terminal cause', () => {
    const fixture = claimedDispatchFixture();
    const failed = fixture.dispatches.fail({
      taskId: fixture.task.id,
      revision: fixture.claim.revision,
      leaseToken: fixture.claim.leaseToken,
      error: 'authentication failed',
    });

    expect(failed.state).toBe('failed');
    expect(
      fixture.dispatches.recoverLegacyGuidedDirtyCheckoutBootstrap(
        fixture.task.id,
      ),
    ).toBeNull();
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).toBe('failed');
    expect(fixture.missions.get(fixture.mission.id)?.status).toBe('blocked');
  });

  it('terminalizes an exact superseded bootstrap before it can poison a retry', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    let now = 20_000;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
      now: () => now,
    });
    const mission = missions.create({
      title: 'Falha terminal durante bootstrap',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Não repetir um bootstrap cuja autoridade foi revogada',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      reason: 'rota do bootstrap terminal',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-terminal',
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
      paneId: 'pane-terminal',
      sessionId: 'session-terminal',
      workerIncarnationId: claim.workerIncarnationId,
    });
    dispatches.blockSessionExit({
      sessionId: 'session-terminal',
      workerIncarnationId: claim.workerIncarnationId,
      reason: TASK_DISPATCH_SESSION_EXIT_REASON,
    });

    const failed = dispatches.failSupersededBootstrap({
      taskId: task.id,
      missionId: mission.id,
      leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: 'pane-terminal',
      sessionId: 'session-terminal',
      error: 'autoridade selada mudou antes do provider',
    });

    expect(failed).toMatchObject({
      state: 'failed',
      attempt: 1,
      lastError: 'autoridade selada mudou antes do provider',
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    expect(missions.get(mission.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    now = 60_000;
    expect(() =>
      dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-terminal',
        leaseOwner: 'main',
        leaseMs: 30_000,
      }),
    ).toThrow(/missão running|dispatch exige missão running/i);
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

/**
 * Guided advisory worker still `running` (bindSpawn done, no handoff) when the
 * provider stays unavailable. `executor: true` swaps the sealed roster/plan to
 * a non-guided implementation task; `withConsumer: true` adds a sealed planned
 * task that consumes the advisory output.
 */
let waiverFixtureSequence = 0;
function advisoryWaiverFixture(
  options: {
    executor?: boolean;
    withConsumer?: boolean;
  } = {},
) {
  const suffix = `waiver-${++waiverFixtureSequence}`;
  const paneId = `pane-advisory-${suffix}`;
  const sessionId = `session-advisory-${suffix}`;
  const runtime = manager();
  const scope = testProjectScope({ rootRealPath: process.cwd() });
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const executor = options.executor === true;
  const agentCategory = executor ? ('executor' as const) : ('architect' as const);
  const executionMode = executor
    ? ('isolated_worktree' as const)
    : ('read_only' as const);
  const ownership = {
    files: ['src'],
    symbols: [],
    domains: executor ? [] : ['guided-advisory', 'sequential-only'],
  };
  const contract = approvedIntentContract({
    goal: 'Mapear riscos antes da execução principal',
    intentVersion: 4,
  });
  const mission = missions.create({
    title: 'Advisory sem provider',
    squadId: 'agentic-guided-squad',
    intentVersion: 4,
    intentState: 'executing',
    intentContract: contract,
    orchestratorSessionId: 'orchestrator-guided-advisor',
  });
  missions.setStatus(mission.id, 'running');
  const advisoryPlannerId = 'guided-advisory-1-advisor';
  const advisoryTaskId = plannedTaskId(mission.id, 4, advisoryPlannerId);
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
        ...(options.withConsumer
          ? [
              {
                id: 'consumer',
                agentName: 'Consumer Worker',
                category: 'executor' as const,
                cli: 'codex',
                model: 'gpt-5.6-sol',
                effort: 'high' as const,
              },
            ]
          : []),
      ],
    },
    rows: [
      {
        plannerId: advisoryPlannerId,
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
      ...(options.withConsumer
        ? [
            {
              plannerId: 'consumer-task',
              title: 'Consumir mapeamento',
              detail: encodeTaskScheduleDetail('Aplique o mapeamento.', {
                dependsOn: [advisoryTaskId],
                ownership: {
                  files: ['src/consumer.ts'],
                  symbols: [],
                  domains: [] as string[],
                },
                merged: false,
                agentRef: 'consumer',
                agentCategory: 'executor' as const,
                executionMode: 'isolated_worktree' as const,
              }),
              agentRef: 'consumer',
              agentCategory: 'executor' as const,
            },
          ]
        : []),
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
  const running = dispatches.get(task!.id)!;
  return {
    runtime,
    scope,
    missions,
    tasks,
    dispatches,
    mission,
    task: task!,
    claim,
    running,
    paneId,
    sessionId,
  };
}

function waiverCauseSha256(reason: string): string {
  return createHash('sha256').update(reason).digest('hex');
}

function waiverInputFor(
  fixture: ReturnType<typeof advisoryWaiverFixture>,
  overrides: Record<string, unknown> = {},
) {
  return {
    taskId: fixture.task.id,
    revision: fixture.running.revision,
    paneId: fixture.paneId,
    sessionId: fixture.sessionId,
    workerIncarnationId: fixture.claim.workerIncarnationId,
    adapterId: 'codex',
    hitKind: 'rate-limit' as const,
    causeSha256: waiverCauseSha256('rate limit'),
    ...overrides,
  };
}

describe('advisory provider-unavailable waiver', () => {
  it('waives a sealed root advisory without consumers: task done, dispatch completed, no synthetic handoff', () => {
    const fixture = advisoryWaiverFixture();
    const eligibility = fixture.dispatches.readProviderFailureWaiverEligibility(
      fixture.task.id,
    );
    expect(eligibility).toMatchObject({
      guidedTaskKind: 'advisory',
      dependsOn: [],
      consumers: [],
    });

    const completed = fixture.dispatches.completeSealedAdvisoryProviderWaiver(
      waiverInputFor(fixture),
    );
    expect(completed.revision).toBe(fixture.running.revision + 1);
    expect(completed).toMatchObject({
      state: 'completed',
      handoffId: undefined,
      handoffAcceptedAt: undefined,
      integrationReceipt: {
        kind: 'advisory_provider_unavailable',
        waiver: {
          missionId: fixture.mission.id,
          intentVersion: 4,
          taskId: fixture.task.id,
          revision: fixture.running.revision,
          sessionId: fixture.sessionId,
          workerIncarnationId: fixture.claim.workerIncarnationId,
          adapterId: 'codex',
          hitKind: 'rate-limit',
          causeSha256: waiverCauseSha256('rate limit'),
        },
      },
    });
    expect(
      fixture.tasks.list(fixture.mission.id)[0],
    ).toMatchObject({ status: 'done' });

    // O waiver é admitido pela prova guiada (única exceção validada); a
    // conclusão física da missão segue com o driver Guided PREVC, então o
    // caminho legacy corretamente se abstém.
    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(true);
    expect(
      fixture.dispatches.completeMissionFromVerifiedPlan({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
    expect(
      createScopedMissionStore(fixture.runtime, fixture.scope).get(
        fixture.mission.id,
      ),
    ).toMatchObject({ status: 'running', intentState: 'executing' });
  });

  it('never waives executor/non-guided tasks and keeps the dispatch running', () => {
    const fixture = advisoryWaiverFixture({ executor: true });
    expect(
      fixture.dispatches.readProviderFailureWaiverEligibility(fixture.task.id)
        ?.guidedTaskKind,
    ).toBeNull();
    expect(() =>
      fixture.dispatches.completeSealedAdvisoryProviderWaiver(
        waiverInputFor(fixture),
      ),
    ).toThrow(/waiver negado|nunca é elegível/i);
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'running',
      integrationReceipt: undefined,
    });
    expect(
      fixture.tasks.list(fixture.mission.id)[0],
    ).toMatchObject({ status: 'running' });
  });

  it('never waives an advisory with dependent consumers in the sealed plan', () => {
    const fixture = advisoryWaiverFixture({ withConsumer: true });
    expect(
      fixture.dispatches.readProviderFailureWaiverEligibility(fixture.task.id)
        ?.consumers,
    ).toHaveLength(1);
    expect(() =>
      fixture.dispatches.completeSealedAdvisoryProviderWaiver(
        waiverInputFor(fixture),
      ),
    ).toThrow(/waiver negado|consumidores/i);
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('running');
  });

  it('rejects quota hits, wrong physical identity and CAS replays', () => {
    const quota = advisoryWaiverFixture();
    expect(() =>
      quota.dispatches.completeSealedAdvisoryProviderWaiver(
        waiverInputFor(quota, { hitKind: 'quota' }),
      ),
    ).toThrow(/waiver negado|janela longa/i);

    const wrongSession = advisoryWaiverFixture();
    expect(() =>
      wrongSession.dispatches.completeSealedAdvisoryProviderWaiver(
        waiverInputFor(wrongSession, { sessionId: 'session-impostor' }),
      ),
    ).toThrow(/dispatch ativo exato/i);
    expect(() =>
      wrongSession.dispatches.completeSealedAdvisoryProviderWaiver(
        waiverInputFor(wrongSession, {
          workerIncarnationId: 'incarnation-impostor',
        }),
      ),
    ).toThrow(/dispatch ativo exato/i);

    const replay = advisoryWaiverFixture();
    replay.dispatches.completeSealedAdvisoryProviderWaiver(
      waiverInputFor(replay),
    );
    expect(() =>
      replay.dispatches.completeSealedAdvisoryProviderWaiver(
        waiverInputFor(replay),
      ),
    ).toThrow(/dispatch ativo exato|CAS/i);
    expect(
      replay.dispatches.get(replay.task.id)?.integrationReceipt?.kind,
    ).toBe('advisory_provider_unavailable');
  });

  it('rejects a forged waiver binding at mission completion authority', () => {
    const fixture = advisoryWaiverFixture();
    fixture.dispatches.completeSealedAdvisoryProviderWaiver(
      waiverInputFor(fixture),
    );
    const db = fixture.runtime.open(fixture.scope).db;
    const stored = db
      .prepare(
        `SELECT integration_receipt_json FROM task_dispatch_queue
         WHERE task_id = ?`,
      )
      .get(fixture.task.id) as { integration_receipt_json: string };
    const forged = JSON.parse(stored.integration_receipt_json) as {
      waiver: { sessionId: string };
    };
    forged.waiver.sessionId = 'session-forged';
    db.prepare(
      `UPDATE task_dispatch_queue SET integration_receipt_json = ?
       WHERE task_id = ?`,
    ).run(JSON.stringify(forged), fixture.task.id);

    expect(
      fixture.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: fixture.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
  });

  it('rejects an ineligible waiver (quota) and a handoff-bound waiver row', () => {
    const ineligible = advisoryWaiverFixture();
    ineligible.dispatches.completeSealedAdvisoryProviderWaiver(
      waiverInputFor(ineligible),
    );
    const db = ineligible.runtime.open(ineligible.scope).db;
    const stored = db
      .prepare(
        `SELECT integration_receipt_json FROM task_dispatch_queue
         WHERE task_id = ?`,
      )
      .get(ineligible.task.id) as { integration_receipt_json: string };
    const tampered = JSON.parse(stored.integration_receipt_json) as {
      waiver: { hitKind: string };
    };
    tampered.waiver.hitKind = 'quota';
    db.prepare(
      `UPDATE task_dispatch_queue SET integration_receipt_json = ?
       WHERE task_id = ?`,
    ).run(JSON.stringify(tampered), ineligible.task.id);
    expect(
      ineligible.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: ineligible.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);

    const handoffBound = advisoryWaiverFixture();
    handoffBound.dispatches.completeSealedAdvisoryProviderWaiver(
      waiverInputFor(handoffBound),
    );
    // A receipt forjada com handoff físico precisa de uma linha real (FK).
    const forgedHandoff = createScopedHandoffStore(
      handoffBound.runtime,
      handoffBound.scope,
    ).submit({
      missionId: handoffBound.mission.id,
      sessionId: handoffBound.sessionId,
      workerIncarnationId: handoffBound.claim.workerIncarnationId,
      fromAgent: 'Advisor independente',
      status: 'success',
      summary: 'Handoff forjado para adulterar a linha do waiver.',
    });
    handoffBound.runtime
      .open(handoffBound.scope)
      .db.prepare(
        `UPDATE task_dispatch_queue SET handoff_id = ?
         WHERE task_id = ?`,
      )
      .run(forgedHandoff.id, handoffBound.task.id);
    expect(
      handoffBound.dispatches.hasVerifiedGuidedPlanAuthority({
        missionId: handoffBound.mission.id,
        intentVersion: 4,
      }),
    ).toBe(false);
  });
});

describe('superseded plan generation retirement', () => {
  const generationSquad = {
    id: 'golden-squad',
    agents: [
      {
        id: 'worker',
        agentName: 'Golden Worker',
        category: 'executor' as const,
        cli: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high' as const,
      },
    ],
  };

  function generationRow(plannerId: string, title: string) {
    return {
      plannerId,
      title,
      detail: encodeTaskScheduleDetail('Implementar e testar.', {
        dependsOn: [],
        ownership: { files: ['src/golden.ts'], symbols: [], domains: [] },
        merged: false,
        agentRef: 'worker',
        agentCategory: 'executor' as const,
        executionMode: 'isolated_worktree' as const,
      }),
      agentRef: 'worker',
      agentCategory: 'executor' as const,
    };
  }

  /**
   * Two sealed generations of the same logical plan: v1 left pending (the
   * orphan wedge from a PREVC refreeze), v2 current and pending.
   */
  function twoGenerationFixture() {
    const runtime = manager();
    const scope = testProjectScope({ rootRealPath: process.cwd() });
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const mission = missions.create({
      title: 'Gerações superseded',
      squadId: 'golden-squad',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: approvedIntentContract({
        goal: 'Completar pelo motor com prova real',
        intentVersion: 1,
      }),
      orchestratorSessionId: 'orchestrator-golden',
    });
    missions.setStatus(mission.id, 'running');
    const [staleExecutor, staleReviewer] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: generationSquad,
      rows: [
        generationRow('implement', 'Entregar v1'),
        generationRow('review', 'Revisar v1'),
      ],
    });
    missions.update(mission.id, {
      intentVersion: 2,
      intentContract: approvedIntentContract({
        goal: 'Completar pelo motor com prova real',
        intentVersion: 2,
      }),
    });
    const [currentExecutor] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 2,
      squad: generationSquad,
      rows: [generationRow('implement', 'Entregar v2')],
    });
    return {
      runtime,
      scope,
      missions,
      tasks,
      dispatches,
      mission,
      staleExecutor: staleExecutor!,
      staleReviewer: staleReviewer!,
      currentExecutor: currentExecutor!,
    };
  }

  function taskStatus(
    fixture: ReturnType<typeof twoGenerationFixture>,
    taskId: string,
  ): string | undefined {
    return fixture.tasks.list(fixture.mission.id).find(
      (task) => task.id === taskId,
    )?.status;
  }

  it('retires orphan pending tasks of superseded generations and admits the current executor', () => {
    const fixture = twoGenerationFixture();

    const retired = fixture.dispatches.retireSupersededPlanGenerations({
      missionId: fixture.mission.id,
      intentVersion: 2,
    });

    expect(new Set(retired)).toEqual(
      new Set([fixture.staleExecutor.id, fixture.staleReviewer.id]),
    );
    expect(taskStatus(fixture, fixture.staleExecutor.id)).toBe('failed');
    expect(taskStatus(fixture, fixture.staleReviewer.id)).toBe('failed');
    expect(taskStatus(fixture, fixture.currentExecutor.id)).toBe('pending');
    // Idempotent: a second pass retires nothing.
    expect(
      fixture.dispatches.retireSupersededPlanGenerations({
        missionId: fixture.mission.id,
        intentVersion: 2,
      }),
    ).toEqual([]);
    // The current generation's executor is still admissible afterwards.
    const receipt = fixture.tasks.getPlanReceipt(fixture.mission.id, 2)!;
    const claim = fixture.dispatches.claim({
      missionId: fixture.mission.id,
      taskId: fixture.currentExecutor.id,
      intentVersion: 2,
      workerId: 'Golden Worker',
      leaseOwner: 'main',
      leaseMs: 30_000,
      ownership: { files: ['src/golden.ts'], symbols: [], domains: [] },
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
    expect(claim.taskId).toBe(fixture.currentExecutor.id);
  });

  it('heals the exact refreeze wedge: pending task with a dead superseded retry dispatch', () => {
    const fixture = twoGenerationFixture();
    // Replay the production wedge on the stale generation: claim → retryable
    // bootstrap failure → task back to pending, dispatch parked in the
    // superseded retry lane, no receipts. The later intent bump strands it.
    const db = fixture.runtime.open(fixture.scope).db;
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, revision, attempt, state,
          worker_id, agent_ref, agent_category, execution_mode,
          ownership_json, route_contract_json, roster_hash,
          lease_owner, lease_token_hash, lease_expires_at,
          worker_incarnation_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1, 'superseded',
               'Golden Worker', 'worker', 'executor', 'isolated_worktree',
               '{"files":["src/golden.ts"],"symbols":[],"domains":[]}', NULL,
               'roster-hash', 'main', 'lease-hash', 0,
               'incarnation-stale', 1, 1)`,
    ).run(
      `dispatch-${fixture.staleExecutor.id}`,
      fixture.staleExecutor.id,
      fixture.mission.id,
    );

    const retired = fixture.dispatches.retireSupersededPlanGenerations({
      missionId: fixture.mission.id,
      intentVersion: 2,
    });

    expect(retired).toContain(fixture.staleExecutor.id);
    expect(taskStatus(fixture, fixture.staleExecutor.id)).toBe('failed');
    // The stale dispatch row stays as immutable audit history.
    expect(
      db
        .prepare(
          `SELECT state FROM task_dispatch_queue WHERE task_id = ?`,
        )
        .get(fixture.staleExecutor.id),
    ).toEqual({ state: 'superseded' });
  });

  it('never touches superseded tasks with physical work or receipts', () => {
    const fixture = twoGenerationFixture();
    const db = fixture.runtime.open(fixture.scope).db;
    // Completed physical work: terminal task + receipt-bearing dispatch.
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(
      fixture.staleExecutor.id,
    );
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, revision, attempt, state,
          worker_id, agent_ref, agent_category, execution_mode,
          ownership_json, route_contract_json, roster_hash,
          lease_owner, lease_token_hash, lease_expires_at,
          worker_incarnation_id, integration_receipt_json, completed_at,
          created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1, 'completed',
               'Golden Worker', 'worker', 'executor', 'isolated_worktree',
               '{"files":["src/golden.ts"],"symbols":[],"domains":[]}', NULL,
               'roster-hash', 'main', 'lease-hash', 0,
               'incarnation-done', '{}', 1, 1, 1)`,
    ).run(
      `dispatch-${fixture.staleExecutor.id}`,
      fixture.staleExecutor.id,
      fixture.mission.id,
    );

    const retired = fixture.dispatches.retireSupersededPlanGenerations({
      missionId: fixture.mission.id,
      intentVersion: 2,
    });

    expect(retired).toEqual([fixture.staleReviewer.id]);
    expect(taskStatus(fixture, fixture.staleExecutor.id)).toBe('done');
    expect(taskStatus(fixture, fixture.staleReviewer.id)).toBe('failed');
  });

  it('rejects retirement against a stale intentVersion', () => {
    const fixture = twoGenerationFixture();

    expect(() =>
      fixture.dispatches.retireSupersededPlanGenerations({
        missionId: fixture.mission.id,
        intentVersion: 1,
      }),
    ).toThrow(/intentVersion obsoleta/i);
    expect(taskStatus(fixture, fixture.staleExecutor.id)).toBe('pending');
  });

  it('fails closed on a hash-corrupted stale plan without retiring anything', () => {
    const fixture = twoGenerationFixture();
    fixture.runtime
      .open(fixture.scope)
      .db.prepare(
        `UPDATE mission_task_plans SET plan_hash = ?
         WHERE mission_id = ? AND intent_version = 1`,
      )
      .run('0'.repeat(64), fixture.mission.id);

    expect(() =>
      fixture.dispatches.retireSupersededPlanGenerations({
        missionId: fixture.mission.id,
        intentVersion: 2,
      }),
    ).toThrow(/invalid.*stale sealed task plan hash/i);
    expect(taskStatus(fixture, fixture.staleExecutor.id)).toBe('pending');
    expect(taskStatus(fixture, fixture.currentExecutor.id)).toBe('pending');
  });

  it('completes the mission from the current generation with retired orphans present', () => {
    const fixture = twoGenerationFixture();
    const { runtime, scope, missions, tasks, dispatches, mission } = fixture;
    const handoffs = createScopedHandoffStore(runtime, scope);
    const receipt = tasks.getPlanReceipt(mission.id, 2)!;
    const ownership = { files: ['src/golden.ts'], symbols: [], domains: [] };
    const route = missions.reserveRouteDecision(
      mission.id,
      fixture.currentExecutor.title,
      {
        tier: 'hard',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        reason: 'roster selado',
        alternatives: [],
      },
    );
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: fixture.currentExecutor.id,
      intentVersion: 2,
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
      taskId: fixture.currentExecutor.id,
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
      taskId: fixture.currentExecutor.id,
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
      label: 'superseded-generation-completion',
    });
    dispatches.completeByCoordinator({
      taskId: fixture.currentExecutor.id,
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
    expect(
      handoffs.acceptDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
      }),
    ).toBe(true);
    acknowledgeHandoffFromPhysicalMaestro({
      runtime,
      scope,
      handoffs,
      missionId: mission.id,
      sessionId: 'orchestrator-golden',
      handoffId: handoff.id,
    });

    expect(
      dispatches.retireSupersededPlanGenerations({
        missionId: mission.id,
        intentVersion: 2,
      }),
    ).toEqual([fixture.staleExecutor.id, fixture.staleReviewer.id]);
    expect(
      dispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion: 2,
      }),
    ).toBe(true);
    expect(missions.get(mission.id)).toMatchObject({
      status: 'done',
      intentState: 'done',
    });
  });
});

/**
 * Cenário de campo (31/07): o worker selado esgota as tentativas físicas de
 * spawn (ex.: codex sem cota), o dispatch vira `blocked` terminal e a missão
 * inteira congela. O reroute dentro do roster devolve a task ao mesmo plano
 * selado, executada por outro agente da MESMA categoria — sem waiver, sem
 * replanejamento e sem tocar no receipt imutável.
 */
describe('reroute de provider esgotado dentro do roster selado', () => {
  function sealedRerouteFixture(runtime: ProjectRuntimeManager) {
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
      title: 'Entregar com roster de dois executores',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: approvedIntentContract({
        goal: 'Entregar mesmo quando a primeira CLI morre',
        intentVersion: 1,
      }),
      squadId: 'squad-reroute',
    });
    missions.setStatus(mission.id, 'running');
    const detail = encodeTaskScheduleDetail('Implementar a mudança', {
      dependsOn: [],
      ownership: { files: ['src/app.ts'], symbols: [], domains: [] },
      merged: false,
      agentRef: 'exec-codex',
      agentCategory: 'executor',
      executionMode: 'isolated_worktree',
    });
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: {
        id: 'squad-reroute',
        agents: [
          {
            id: 'exec-codex',
            agentName: 'Codex Dev',
            category: 'executor',
            cli: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
          },
          {
            id: 'exec-kimi',
            agentName: 'Kimi Dev',
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
          title: 'Implementar',
          detail,
          agentRef: 'exec-codex',
          agentCategory: 'executor',
        },
      ],
    });
    const receipt = tasks.getPlanReceipt(mission.id, 1)!;
    const ownership = {
      files: ['src/app.ts'],
      symbols: [],
      domains: [],
    };
    const routeContract = {
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    } as const;
    const exhaustSpawnAttempts = (): void => {
      for (
        let attempt = 1;
        attempt <= TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS;
        attempt += 1
      ) {
        const claim = dispatches.claim({
          missionId: mission.id,
          taskId: task!.id,
          intentVersion: 1,
          workerId: 'Codex Dev',
          leaseOwner: 'main',
          leaseMs: 30_000,
          agentRef: 'exec-codex',
          agentCategory: 'executor',
          rosterHash: receipt.rosterHash,
          routeContract,
          ownership,
          executionMode: 'isolated_worktree',
        });
        const route = missions.reserveRouteDecision(mission.id, task!.title, {
          tier: 'hard',
          ...routeContract,
          reason: 'rota selada',
          alternatives: [],
        });
        const routed = dispatches.attachRoute({
          taskId: task!.id,
          revision: claim.revision,
          leaseToken: claim.leaseToken,
          routeReservationId: route.id,
          ...routeContract,
        });
        dispatches.bindSpawn({
          taskId: task!.id,
          revision: routed.revision,
          leaseToken: claim.leaseToken,
          paneId: `pane-${attempt}`,
          sessionId: `session-${attempt}`,
          workerIncarnationId: claim.workerIncarnationId,
        });
        const exited = dispatches.blockSessionExit({
          sessionId: `session-${attempt}`,
          workerIncarnationId: claim.workerIncarnationId,
          reason: TASK_DISPATCH_SESSION_EXIT_REASON,
        });
        if (attempt < TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS) {
          now = exited!.leaseExpiresAt + 1;
        }
      }
    };
    return {
      scope,
      missions,
      tasks,
      dispatches,
      mission,
      task: task!,
      receipt,
      ownership,
      routeContract,
      exhaustSpawnAttempts,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const directive = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    fromAgentRef: 'exec-codex',
    toAgentRef: 'exec-kimi',
    exhaustedAdapterIds: ['codex'],
    reason: 'codex esgotou o spawn físico',
    reroutedAt: 5_000,
    ...overrides,
  });

  it('reabre a missão e devolve a task ao roster pelo agente alternativo', () => {
    const fixture = sealedRerouteFixture(manager());
    fixture.exhaustSpawnAttempts();
    const blocked = fixture.dispatches.get(fixture.task.id)!;
    expect(blocked.state).toBe('blocked');
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    const rerouted = fixture.dispatches.rerouteExhaustedWorkerByCoordinator({
      taskId: fixture.task.id,
      revision: blocked.revision,
      directive: directive(),
      note: 'reroute para Kimi Dev',
    });
    expect(rerouted).toMatchObject({
      state: 'superseded',
      attempt: 1,
      providerReroute: { fromAgentRef: 'exec-codex', toAgentRef: 'exec-kimi' },
    });
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(
      fixture.missions.get(fixture.mission.id)!.description,
    ).not.toMatch(TERMINAL_OPERATIONAL_FAILURE_MARKER);
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).toBe('pending');

    fixture.advance(rerouted.leaseExpiresAt + 1);
    const claim = fixture.dispatches.claim({
      missionId: fixture.mission.id,
      taskId: fixture.task.id,
      intentVersion: 1,
      workerId: 'Kimi Dev',
      leaseOwner: 'main',
      leaseMs: 30_000,
      agentRef: 'exec-kimi',
      agentCategory: 'executor',
      rosterHash: fixture.receipt.rosterHash,
      routeContract: fixture.routeContract,
      ownership: fixture.ownership,
      executionMode: 'isolated_worktree',
    });
    expect(claim).toMatchObject({
      state: 'claimed',
      agentRef: 'exec-kimi',
      workerId: 'Kimi Dev',
      providerReroute: { toAgentRef: 'exec-kimi' },
    });
    // O receipt selado permanece com o agente original: o reroute é uma
    // vinculação de dispatch, nunca uma reescrita do plano.
    expect(fixture.tasks.getPlanReceipt(fixture.mission.id, 1)).toMatchObject({
      planHash: fixture.receipt.planHash,
      tasks: [{ agentRef: 'exec-codex' }],
    });
  });

  it('recusa o claim do agente selado original enquanto a diretiva vigora', () => {
    const fixture = sealedRerouteFixture(manager());
    fixture.exhaustSpawnAttempts();
    const blocked = fixture.dispatches.get(fixture.task.id)!;
    const rerouted = fixture.dispatches.rerouteExhaustedWorkerByCoordinator({
      taskId: fixture.task.id,
      revision: blocked.revision,
      directive: directive(),
      note: 'reroute para Kimi Dev',
    });
    fixture.advance(rerouted.leaseExpiresAt + 1);
    expect(() =>
      fixture.dispatches.claim({
        missionId: fixture.mission.id,
        taskId: fixture.task.id,
        intentVersion: 1,
        workerId: 'Codex Dev',
        leaseOwner: 'main',
        leaseMs: 30_000,
        agentRef: 'exec-codex',
        agentCategory: 'executor',
        rosterHash: fixture.receipt.rosterHash,
        routeContract: fixture.routeContract,
        ownership: fixture.ownership,
        executionMode: 'isolated_worktree',
      }),
    ).toThrow(/agente alternativo da diretiva/i);
  });

  it('recusa uma diretiva que aponta para fora do agentRef selado', () => {
    const fixture = sealedRerouteFixture(manager());
    fixture.exhaustSpawnAttempts();
    const blocked = fixture.dispatches.get(fixture.task.id)!;
    expect(() =>
      fixture.dispatches.rerouteExhaustedWorkerByCoordinator({
        taskId: fixture.task.id,
        revision: blocked.revision,
        directive: directive({ fromAgentRef: 'exec-kimi' }),
        note: 'diretiva forjada',
      }),
    ).toThrow(/agentRef selado original/i);
  });

  it('nunca reroteia um dispatch que não provou esgotamento físico terminal', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 1_000;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => now,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
    });
    const mission = missions.create({
      title: 'Bloqueio de outra natureza',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: approvedIntentContract({
        goal: 'Bloquear por merge, não por spawn',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Task' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium',
      adapterId: 'codex',
      reason: 'rota',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker',
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
    now = 1_000 + 30_001;
    const blocked = dispatches.blockExpired({
      taskId: task.id,
      revision: routed.revision,
      reason: 'lease expirada sem prova física',
    });
    expect(blocked.state).toBe('blocked');
    expect(() =>
      dispatches.rerouteExhaustedWorkerByCoordinator({
        taskId: task.id,
        revision: blocked.revision,
        directive: directive(),
        note: 'reroute indevido',
      }),
    ).toThrow(/bloqueio terminal canônico/i);
  });

  /** Spawn físico único (o análogo vivo do primeiro attempt da exaustão). */
  function spawnLiveWorker(fixture: ReturnType<typeof sealedRerouteFixture>) {
    const claim = fixture.dispatches.claim({
      missionId: fixture.mission.id,
      taskId: fixture.task.id,
      intentVersion: 1,
      workerId: 'Codex Dev',
      leaseOwner: 'main',
      leaseMs: 30_000,
      agentRef: 'exec-codex',
      agentCategory: 'executor',
      rosterHash: fixture.receipt.rosterHash,
      routeContract: fixture.routeContract,
      ownership: fixture.ownership,
      executionMode: 'isolated_worktree',
    });
    const route = fixture.missions.reserveRouteDecision(
      fixture.mission.id,
      fixture.task.title,
      {
        tier: 'hard',
        ...fixture.routeContract,
        reason: 'rota selada',
        alternatives: [],
      },
    );
    const routed = fixture.dispatches.attachRoute({
      taskId: fixture.task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      ...fixture.routeContract,
    });
    const bound = fixture.dispatches.bindSpawn({
      taskId: fixture.task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: 'pane-live',
      sessionId: 'session-live',
      workerIncarnationId: claim.workerIncarnationId,
    });
    return { claim, bound };
  }

  const liveIdentity = (claim: { workerIncarnationId: string }) => ({
    paneId: 'pane-live',
    sessionId: 'session-live',
    workerIncarnationId: claim.workerIncarnationId,
  });

  it('re-rota ao vivo o worker de provider morto sem jamais bloquear a missão', () => {
    const fixture = sealedRerouteFixture(manager());
    const { claim, bound } = spawnLiveWorker(fixture);

    const rerouted = fixture.dispatches.rerouteLiveProviderDeadWorkerByCoordinator({
      taskId: fixture.task.id,
      revision: bound.revision,
      ...liveIdentity(claim),
      directive: directive({ reason: 'codex morreu com 401 no primeiro spawn' }),
      note: '[NEXUS_PROVIDER_REROUTE] codex 401; re-roteado para Kimi Dev',
    });

    expect(rerouted).toMatchObject({
      state: 'superseded',
      attempt: 1,
      providerReroute: {
        fromAgentRef: 'exec-codex',
        toAgentRef: 'exec-kimi',
        exhaustedAdapterIds: ['codex'],
      },
    });
    // A task volta ao roster e a missão NUNCA visitou blocked — este é o
    // contrato inteiro da variante viva.
    expect(fixture.tasks.list(fixture.mission.id)[0]).toMatchObject({
      status: 'pending',
    });
    expect(fixture.missions.get(fixture.mission.id)).toMatchObject({
      status: 'running',
    });
  });

  it('exige a identidade física exata do worker que detectou a falha', () => {
    const fixture = sealedRerouteFixture(manager());
    const { claim, bound } = spawnLiveWorker(fixture);

    expect(() =>
      fixture.dispatches.rerouteLiveProviderDeadWorkerByCoordinator({
        taskId: fixture.task.id,
        revision: bound.revision,
        ...liveIdentity(claim),
        sessionId: 'session-de-outro-worker',
        directive: directive(),
        note: 'identidade errada',
      }),
    ).toThrow(/encarnação física exata/i);
    // A recusa não pode ter efeito colateral: o dispatch continua vivo.
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('running');
    expect(fixture.tasks.list(fixture.mission.id)[0]?.status).toBe('running');
  });

  it('recusa o reroute vivo quando a missão saiu de running', () => {
    const fixture = sealedRerouteFixture(manager());
    const { claim, bound } = spawnLiveWorker(fixture);
    fixture.missions.setStatus(fixture.mission.id, 'blocked');

    expect(() =>
      fixture.dispatches.rerouteLiveProviderDeadWorkerByCoordinator({
        taskId: fixture.task.id,
        revision: bound.revision,
        ...liveIdentity(claim),
        directive: directive(),
        note: 'missão pausada',
      }),
    ).toThrow(/missão running/i);
  });

  it('recusa a diretiva viva que aponta para o mesmo agente já vinculado', () => {
    const fixture = sealedRerouteFixture(manager());
    const { claim, bound } = spawnLiveWorker(fixture);

    expect(() =>
      fixture.dispatches.rerouteLiveProviderDeadWorkerByCoordinator({
        taskId: fixture.task.id,
        revision: bound.revision,
        ...liveIdentity(claim),
        directive: directive({ toAgentRef: 'exec-codex' }),
        note: 'auto-reroute proibido',
      }),
    ).toThrow(/agente diferente/i);
  });

  it('gate 3: reroteia o esgotado mesmo com a missão ainda running', () => {
    // A forma capturada em 31/07: um advisor esgota as 3 tentativas com a
    // cadeia de entrega viva — dispatch blocked-terminal, missão running — e
    // nenhum caminho de recuperação cobria (o sweep exigia missão bloqueada;
    // o waiver só roda no attempt 0). A missão ficava eterna com 7/8 pronto.
    const fixture = sealedRerouteFixture(manager());
    fixture.exhaustSpawnAttempts();
    expect(fixture.missions.get(fixture.mission.id)!.status).toBe('blocked');
    fixture.missions.setStatus(fixture.mission.id, 'running');

    const blocked = fixture.dispatches.get(fixture.task.id)!;
    const rerouted = fixture.dispatches.rerouteExhaustedWorkerByCoordinator({
      taskId: fixture.task.id,
      revision: blocked.revision,
      directive: directive(),
      note: 'codex morto com a missão viva',
    });

    expect(rerouted.state).toBe('superseded');
    expect(rerouted.providerReroute?.toAgentRef).toBe('exec-kimi');
    expect(
      fixture.tasks
        .list(fixture.mission.id)
        .find((candidate) => candidate.id === fixture.task.id),
    ).toMatchObject({ status: 'pending' });
    // Missão running não tem bloqueio a reabrir — segue exatamente como está.
    expect(fixture.missions.get(fixture.mission.id)!.status).toBe('running');
  });

  // Os dois caminhos gravam a MESMA coluna durável. Sem a proveniência, o
  // reply guard do waiver lê a diretiva do sweep como se fosse a sua e
  // dispensa a task sem ter consultado o roster nenhuma vez.
  it('a diretiva viva sai carimbada como live-guard — o chamador não pode mentir', () => {
    const fixture = sealedRerouteFixture(manager());
    const { claim, bound } = spawnLiveWorker(fixture);

    const rerouted =
      fixture.dispatches.rerouteLiveProviderDeadWorkerByCoordinator({
        taskId: fixture.task.id,
        revision: bound.revision,
        ...liveIdentity(claim),
        // O chamador tenta se passar pelo sweep: a transação sobrescreve.
        directive: directive({ emittedBy: 'exhaustion-sweep' }),
        note: '[NEXUS_PROVIDER_REROUTE] codex 401 ao vivo',
      });

    expect(rerouted.providerReroute?.emittedBy).toBe('live-guard');
  });

  it('a diretiva do sweep sai carimbada como exhaustion-sweep', () => {
    const fixture = sealedRerouteFixture(manager());
    fixture.exhaustSpawnAttempts();
    const blockedDispatch = fixture.dispatches.get(fixture.task.id)!;

    const rerouted = fixture.dispatches.rerouteExhaustedWorkerByCoordinator({
      taskId: fixture.task.id,
      revision: blockedDispatch.revision,
      directive: directive({ emittedBy: 'live-guard' }),
      note: 'sweep de esgotamento físico',
    });

    expect(rerouted.providerReroute?.emittedBy).toBe('exhaustion-sweep');
  });
});

describe('assertConcurrentIsolatedWorktreeDisjoint (P0-3 parallel writers)', () => {
  it('accepts multiple simultaneous isolated_worktree tasks with disjoint files', () => {
    expect(() =>
      assertConcurrentIsolatedWorktreeDisjoint([
        {
          taskId: 's1',
          executionMode: 'isolated_worktree',
          ownership: { files: ['src/auth/login.ts'] },
        },
        {
          taskId: 's2',
          executionMode: 'isolated_worktree',
          ownership: { files: ['src/billing/checkout.ts'] },
        },
        {
          taskId: 's3',
          executionMode: 'isolated_worktree',
          ownership: { files: ['src/ui/nav.ts'] },
        },
      ]),
    ).not.toThrow();
  });

  it('ignores read_only peers — only worktree writers can collide on files', () => {
    expect(() =>
      assertConcurrentIsolatedWorktreeDisjoint([
        {
          taskId: 'writer',
          executionMode: 'isolated_worktree',
          ownership: { files: ['src/a.ts'] },
        },
        {
          taskId: 'reviewer',
          executionMode: 'read_only',
          ownership: { files: ['src/a.ts'] },
        },
      ]),
    ).not.toThrow();
  });

  it('fails closed when two simultaneous worktree writers share a file', () => {
    expect(() =>
      assertConcurrentIsolatedWorktreeDisjoint([
        {
          taskId: 's1',
          executionMode: 'isolated_worktree',
          ownership: { files: ['src/shared/util.ts', 'src/a.ts'] },
        },
        {
          taskId: 's2',
          executionMode: 'isolated_worktree',
          ownership: { files: ['./src/shared/util.ts'] },
        },
      ]),
    ).toThrow(/concurrent_isolated_worktree_files_overlap/);
  });

  it('is provider-agnostic: a claude+codex+gemini disjoint wave is accepted', () => {
    // Heterogeneous fleet: disjointness keys only on ownership files, never on
    // the writer's CLI/provider, so mixed-roster writers admit like all-claude.
    const mixed = [
      {
        taskId: 'writer-claude',
        executionMode: 'isolated_worktree',
        ownership: { files: ['src/auth/login.ts'] },
      },
      {
        taskId: 'writer-codex',
        executionMode: 'isolated_worktree',
        ownership: { files: ['src/billing/checkout.ts'] },
      },
      {
        taskId: 'writer-gemini',
        executionMode: 'isolated_worktree',
        ownership: { files: ['src/ui/nav.ts'] },
      },
    ];
    expect(() => assertConcurrentIsolatedWorktreeDisjoint(mixed)).not.toThrow();

    // And a mixed roster colliding on a file still fails closed, provider-blind.
    expect(() =>
      assertConcurrentIsolatedWorktreeDisjoint([
        mixed[0]!,
        {
          taskId: 'writer-gemini',
          executionMode: 'isolated_worktree',
          ownership: { files: ['src/auth/login.ts'] },
        },
      ]),
    ).toThrow(/concurrent_isolated_worktree_files_overlap/);
  });
});

describe('concurrent-writer disjointness wired at dispatch claim (P0-3 seam B)', () => {
  // Two codex executors (codex is the mechanically workspace-write CLI) sealed
  // as a wave-pack plan; each claim carries the exact sealed ownership so the
  // claim transaction is exercised end to end — the REAL caller of the guard.
  function sealTwoWriterWave(
    ownership1: { files: string[]; symbols: string[]; domains: string[] },
    ownership2: { files: string[]; symbols: string[]; domains: string[] },
  ) {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, {
      now: () => 1_000,
    });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => 1_000 });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => 1_000,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Fan-out N utilitários disjuntos',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'P0-3 disjoint wave',
      squadId: 'wave-pack-squad',
      intentVersion: 1,
      intentState: 'executing',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const [taskA, taskB] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: {
        id: 'wave-pack-squad',
        agents: [
          {
            id: 'dev-a',
            agentName: 'Dev A',
            category: 'executor',
            cli: 'codex',
            effort: 'medium',
          },
          {
            id: 'dev-b',
            agentName: 'Dev B',
            category: 'executor',
            cli: 'codex',
            effort: 'medium',
          },
        ],
      },
      rows: [
        {
          plannerId: 'wave-pack-story-a',
          title: 'Story A',
          detail: encodeTaskScheduleDetail('Implement story A.', {
            dependsOn: [],
            ownership: ownership1,
            merged: false,
            agentRef: 'dev-a',
            agentCategory: 'executor',
            executionMode: 'isolated_worktree',
          }),
          agentRef: 'dev-a',
          agentCategory: 'executor',
        },
        {
          plannerId: 'wave-pack-story-b',
          title: 'Story B',
          detail: encodeTaskScheduleDetail('Implement story B.', {
            dependsOn: [],
            ownership: ownership2,
            merged: false,
            agentRef: 'dev-b',
            agentCategory: 'executor',
            executionMode: 'isolated_worktree',
          }),
          agentRef: 'dev-b',
          agentCategory: 'executor',
        },
      ],
    });
    const rosterHash = tasks.getPlanReceipt(mission.id, 1)!.rosterHash;
    const claimA = () =>
      dispatches.claim({
        missionId: mission.id,
        taskId: taskA!.id,
        intentVersion: 1,
        workerId: 'Dev A',
        leaseOwner: 'main',
        leaseMs: 30_000,
        ownership: ownership1,
        executionMode: 'isolated_worktree',
        agentRef: 'dev-a',
        agentCategory: 'executor',
        rosterHash,
        routeContract: { adapterId: 'codex', effort: 'medium' },
      });
    const claimB = () =>
      dispatches.claim({
        missionId: mission.id,
        taskId: taskB!.id,
        intentVersion: 1,
        workerId: 'Dev B',
        leaseOwner: 'main',
        leaseMs: 30_000,
        ownership: ownership2,
        executionMode: 'isolated_worktree',
        agentRef: 'dev-b',
        agentCategory: 'executor',
        rosterHash,
        routeContract: { adapterId: 'codex', effort: 'medium' },
      });
    return { claimA, claimB };
  }

  const marker = 'wave-pack-disjoint-files';

  it('admits two concurrent disjoint-marked isolated writers through the real claim', () => {
    const { claimA, claimB } = sealTwoWriterWave(
      {
        files: ['src/util/slugify.ts'],
        symbols: [],
        domains: ['guided-implementation', 'wave-pack', 'wave-pack-story:a', marker],
      },
      {
        files: ['src/util/debounce.ts'],
        symbols: [],
        domains: ['guided-implementation', 'wave-pack', 'wave-pack-story:b', marker],
      },
    );
    expect(claimA().state).toBe('claimed');
    expect(claimB().state).toBe('claimed');
  });

  it('rejects a second disjoint-marked writer that shares a file, at claim time', () => {
    const { claimA, claimB } = sealTwoWriterWave(
      {
        files: ['src/shared/util.ts'],
        symbols: [],
        domains: ['guided-implementation', 'wave-pack', 'wave-pack-story:a', marker],
      },
      {
        files: ['src/shared/util.ts'],
        symbols: [],
        domains: ['guided-implementation', 'wave-pack', 'wave-pack-story:b', marker],
      },
    );
    expect(claimA().state).toBe('claimed');
    expect(() => claimB()).toThrow(/concurrent_isolated_worktree_files_overlap/);
  });

  it('does NOT fence shared-inventory wave-pack writers (no disjoint marker)', () => {
    // Shared inventory is a merge permit, not an exclusive file claim: two such
    // writers overlap by design and must still admit — the guard is scoped to
    // the disjoint marker only.
    const { claimA, claimB } = sealTwoWriterWave(
      {
        files: ['src/'],
        symbols: [],
        domains: ['guided-implementation', 'wave-pack', 'wave-pack-story:a'],
      },
      {
        files: ['src/'],
        symbols: [],
        domains: ['guided-implementation', 'wave-pack', 'wave-pack-story:b'],
      },
    );
    expect(claimA().state).toBe('claimed');
    expect(claimB().state).toBe('claimed');
  });
});

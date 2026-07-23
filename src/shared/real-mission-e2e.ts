import { z } from 'zod';
import type { Squad } from './orch-types';

/**
 * This is deliberately a command-line-only release gate. It is not enabled by
 * an environment variable, renderer setting, feature flag, or IPC payload.
 */
export const REAL_MISSION_E2E_FLAG = '--nexus-real-mission-e2e';
export const REAL_MISSION_E2E_TIMEOUT_MS = 15 * 60_000;
export const REAL_MISSION_E2E_EVIDENCE_FILE = 'real-mission-evidence.json';

export const REAL_MISSION_E2E_CHANNELS = Object.freeze({
  run: 'real-mission-e2e:run',
  prepareFixture: 'real-mission-e2e:prepare-fixture',
  observe: 'real-mission-e2e:observe',
});

export const REAL_MISSION_E2E_SQUAD_ID = 'nexus-real-mission-e2e';
export const REAL_MISSION_E2E_ORCHESTRATOR_ID = 'e2e-orchestrator';
export const REAL_MISSION_E2E_ORCHESTRATOR_NAME = 'E2E Orquestrador';
/** Claude orchestrates; Codex only executes (matches product + Overclock observation). */
export const REAL_MISSION_E2E_ORCHESTRATOR_CLI = 'claude';
export const REAL_MISSION_E2E_WORKER_ID = 'e2e-worker';
export const REAL_MISSION_E2E_WORKER_NAME = 'E2E Worker';
export const REAL_MISSION_E2E_WORKER_CLI = 'codex';
export const REAL_MISSION_E2E_RESULT_FILE = 'resultado.txt';
export const REAL_MISSION_E2E_RESULT_CONTENT = 'nexus-real-mission-e2e-ok\n';
export const REAL_MISSION_E2E_CTA =
  'Abra o relatório de evidências, corrija o estado bloqueado e execute novamente antes da release.';
const REAL_MISSION_E2E_RENDERER_FAILURE_PREFIX = 'renderer-failed:';

export const REAL_MISSION_E2E_GOAL =
  'Delegue a um worker do roster a criação de resultado.txt com o conteúdo exato ' +
  '"nexus-real-mission-e2e-ok\\n", integre o commit local pelo motor Nexus e conclua ' +
  'somente após receber o handoff. O orquestrador Claude não pode editar nem commitar o arquivo.';

export const REAL_MISSION_E2E_ACCEPTANCE_CRITERIA = Object.freeze([
  'Um worker Codex do roster, e não o orquestrador Claude, cria resultado.txt.',
  'resultado.txt contém exatamente nexus-real-mission-e2e-ok seguido de newline.',
  'O worker faz um commit local no worktree e envia nexus_handoff_submit com status success.',
  'O motor Nexus aceita o handoff, integra o commit e marca a missão done sem atalho manual.',
]);

export const REAL_MISSION_E2E_PLANNER_TASK_ID = 'resultado-worker';

/** Canonical worker task detail sealed by the main-owned release plan. */
export const REAL_MISSION_E2E_WORKER_TASK_DETAIL =
  'Crie resultado.txt com o conteúdo exato `nexus-real-mission-e2e-ok\\n` ' +
  '(byte-a-byte, newline final). Verifique o arquivo, faça um único commit LOCAL ' +
  'e chame nexus_handoff_submit com status success. Nunca faça push nem merge.';

/**
 * Exact plan rows the release gate seals (main-owned). Mirrors the orchestrator
 * contract so a flaky LLM that never reaches nexus_task plan still unlocks the
 * durable scheduler → worker → handoff path.
 */
export function createRealMissionE2EPlanTasks(): readonly Readonly<{
  id: string;
  title: string;
  detail: string;
  agentRef: string;
  category: 'executor';
  executionMode: 'isolated_worktree';
  ownership: { files: readonly string[]; symbols: readonly string[]; domains: readonly string[] };
  dependsOn: readonly string[];
}>[] {
  return Object.freeze([
    Object.freeze({
      id: REAL_MISSION_E2E_PLANNER_TASK_ID,
      title: 'Criar resultado.txt no worktree isolado',
      detail: REAL_MISSION_E2E_WORKER_TASK_DETAIL,
      agentRef: REAL_MISSION_E2E_WORKER_ID,
      category: 'executor' as const,
      executionMode: 'isolated_worktree' as const,
      ownership: Object.freeze({
        files: Object.freeze([REAL_MISSION_E2E_RESULT_FILE]),
        symbols: Object.freeze([] as string[]),
        domains: Object.freeze([] as string[]),
      }),
      dependsOn: Object.freeze([] as string[]),
    }),
  ]);
}

export const REAL_MISSION_E2E_ORCHESTRATOR_INSTRUCTIONS = [
  '# Release gate E2E real',
  'Você é o orquestrador Claude. É PROIBIDO criar, editar, adicionar ou commitar resultado.txt.',
  'Não use Bash/Edit/Write/NotebookEdit/Task nativos para o arquivo de resultado.',
  'Use exatamente um worker do roster: e2e-worker (Codex executor).',
  'O plano é selado pelo main Nexus na subida da missão. Se o plano já existir, NÃO replaneje.',
  'Se precisar planejar (só se o board estiver vazio), chame UMA vez a tool MCP ' +
    'mcp__nexus__nexus_task (ou nexus_task) com action=plan e este payload:',
  '  action=plan',
  `  tasks=[{id:${REAL_MISSION_E2E_PLANNER_TASK_ID}, agentRef:${REAL_MISSION_E2E_WORKER_ID}, ` +
    'category:executor, executionMode:isolated_worktree, ' +
    `ownership.files:["${REAL_MISSION_E2E_RESULT_FILE}"], dependsOn:[]}]`,
  `No detail: ${REAL_MISSION_E2E_WORKER_TASK_DETAIL}`,
  'Não spawne worker manualmente: o scheduler durável do main reserva a rota e spawna o Codex.',
  'Aguarde o handoff automático. Use mcp__nexus__nexus_handoff_list / nexus_handoff_list e ' +
    'mcp__nexus__nexus_handoff_ack / nexus_handoff_ack quando ele for entregue.',
  'Não use nexus_mission_update para forçar done: integração, receipts e conclusão pertencem ao motor Nexus.',
].join('\n');

export function createRealMissionE2ESquadFixture(): Squad {
  return {
    id: REAL_MISSION_E2E_SQUAD_ID,
    name: 'Nexus real mission release gate',
    createdAt: 'real-mission-e2e-v1',
    builtin: false,
    orchestratorInstructions: REAL_MISSION_E2E_ORCHESTRATOR_INSTRUCTIONS,
    agents: [
      {
        id: REAL_MISSION_E2E_ORCHESTRATOR_ID,
        agentName: REAL_MISSION_E2E_ORCHESTRATOR_NAME,
        category: 'orchestrator',
        // Claude is the only reliable orchestrator CLI in practice; Codex is executor-only.
        cli: REAL_MISSION_E2E_ORCHESTRATOR_CLI,
        allowedSkills: [],
        allowedTools: null,
      },
      {
        id: REAL_MISSION_E2E_WORKER_ID,
        agentName: REAL_MISSION_E2E_WORKER_NAME,
        category: 'executor',
        cli: REAL_MISSION_E2E_WORKER_CLI,
        effort: 'medium',
        allowedSkills: [],
        allowedTools: [],
      },
    ],
  };
}

interface RealMissionE2EObservationMission {
  readonly status?: string;
  readonly intentState?: string;
  readonly intentVersion?: number;
  readonly squadId?: string;
  readonly orchestratorSessionId?: string | null;
  readonly intentContract?: {
    readonly version?: number;
    readonly source?: string;
    readonly goal?: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly executionMode?: string;
    readonly lane?: string;
    readonly contextPolicy?: string;
    readonly approvedAt?: number;
    readonly dispatchedAt?: number;
    readonly intentVersion?: number;
    readonly squadRevisionHash?: string;
    readonly orchestratorRuntime?: unknown;
  } | null;
}

/**
 * The observer must be installed after the exact fixture intent is compiled
 * but before approval can synchronously start the main-owned bootstrap.
 */
export function isRealMissionE2EPreApprovalMission(
  mission: RealMissionE2EObservationMission | null | undefined,
): mission is RealMissionE2EObservationMission {
  const contract = mission?.intentContract;
  const criteria = contract?.acceptanceCriteria;
  return (
    mission?.status === 'pending' &&
    (mission.intentState === 'ready_to_start' ||
      mission.intentState === 'awaiting_approval') &&
    Number.isInteger(mission.intentVersion) &&
    (mission.intentVersion ?? 0) > 0 &&
    mission.squadId === REAL_MISSION_E2E_SQUAD_ID &&
    mission.orchestratorSessionId == null &&
    contract?.version === 1 &&
    contract.source === 'automation' &&
    contract.goal === REAL_MISSION_E2E_GOAL &&
    contract.executionMode === 'autopilot' &&
    contract.lane === 'standard' &&
    contract.contextPolicy === 'minimal' &&
    contract.intentVersion === mission.intentVersion &&
    contract.approvedAt === undefined &&
    contract.dispatchedAt === undefined &&
    contract.squadRevisionHash === undefined &&
    contract.orchestratorRuntime === undefined &&
    Array.isArray(criteria) &&
    criteria.length === REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.length &&
    criteria.every(
      (criterion, index) =>
        criterion === REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[index],
    )
  );
}

const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const timestampSchema = z.number().int().nonnegative();

export const realMissionE2ERunPayloadSchema = z
  .object({
    workspacePath: z.string().min(1).max(4_096),
    rendererFailureToken: sha256Schema,
  })
  .strict();

export const realMissionE2EPrepareFixturePayloadSchema = z
  .object({
    rendererFailureToken: sha256Schema,
  })
  .strict();

export const realMissionE2EObservePayloadSchema = z
  .object({
    missionId: idSchema,
  })
  .strict();

export function realMissionE2ERendererFailureSignal(token: string): string {
  return `${REAL_MISSION_E2E_RENDERER_FAILURE_PREFIX}${sha256Schema.parse(token)}`;
}

export function isRealMissionE2ERendererFailureSignal(
  value: string,
  expectedToken: string,
): boolean {
  const parsedToken = sha256Schema.safeParse(expectedToken);
  return (
    parsedToken.success &&
    value ===
      `${REAL_MISSION_E2E_RENDERER_FAILURE_PREFIX}${parsedToken.data}`
  );
}

const missionProofSchema = z
  .object({
    id: idSchema,
    status: z.enum(['pending', 'running', 'blocked', 'done', 'failed']),
    intentVersion: z.number().int().nonnegative(),
    squadId: z.literal(REAL_MISSION_E2E_SQUAD_ID),
  })
  .strict();

const kickoffProofSchema = z
  .object({
    sessionId: idSchema.nullable(),
    idleAt: timestampSchema.nullable(),
    busyAt: timestampSchema.nullable(),
    ptyDataAt: timestampSchema.nullable(),
    ptyChunkSha256: sha256Schema.nullable(),
  })
  .strict();

const paneProofSchema = z
  .object({
    role: z.enum(['orchestrator', 'worker']),
    paneId: idSchema,
    sessionId: idSchema.nullable(),
    adapterId: idSchema,
    agentRef: idSchema,
    workerIncarnationId: idSchema.nullable(),
    ptySpawnedAt: timestampSchema.nullable(),
    ptyDataAt: timestampSchema.nullable(),
    ptyChunkSha256: sha256Schema.nullable(),
  })
  .strict();

const dispatchProofSchema = z
  .object({
    taskId: idSchema,
    state: z.enum([
      'claimed',
      'routed',
      'spawning',
      'running',
      'handoff_ready',
      'merging',
      'completed',
      'blocked',
      'failed',
      'suspended',
      'superseded',
    ]),
    routeReservationId: idSchema.nullable(),
    routeConsumedAt: timestampSchema.nullable(),
    routeConsumerMatches: z.boolean(),
    workerIncarnationId: idSchema.nullable(),
    sessionId: idSchema.nullable(),
    handoffId: idSchema.nullable(),
    handoffAcceptedAt: timestampSchema.nullable(),
    integrationReceipt: z
      .object({
        kind: z.enum([
          'worktree_integrated',
          'same_checkout_validated',
          'read_only_validated',
        ]),
        referenceSha: gitShaSchema,
        completedAt: timestampSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const handoffProofSchema = z
  .object({
    id: idSchema,
    status: z.enum(['success', 'partial', 'blocked', 'failed', 'progress', 'stalled']),
    deliveryState: z.enum(['queued', 'submitted', 'acknowledged', 'consumed']),
    delivered: z.boolean(),
    acceptedAt: timestampSchema.nullable(),
    acceptedBySessionId: idSchema.nullable(),
  })
  .strict();

const repositoryProofSchema = z
  .object({
    initialHeadSha: gitShaSchema.nullable(),
    finalHeadSha: gitShaSchema.nullable(),
    resultSha256: sha256Schema.nullable(),
    commitCount: z.number().int().nonnegative(),
    clean: z.boolean(),
    changedBeforeWorker: z.boolean(),
    exactSingleCommit: z.boolean(),
  })
  .strict();

const failureSchema = z
  .object({
    code: z.enum([
      'setup-failed',
      'renderer-failed',
      'observer-invalid',
      'mission-blocked',
      'mission-failed',
      'invariant-failed',
      'timeout',
      'app-error',
    ]),
    reason: z
      .enum([
        'boot_timeout',
        'timeout',
        'session_exited',
        'write_failed',
        'authority_lost',
      ])
      .nullable(),
    cta: z.literal(REAL_MISSION_E2E_CTA),
    snapshot: z
      .object({
        missionStatus: z
          .enum(['pending', 'running', 'blocked', 'done', 'failed'])
          .nullable(),
        paneCount: z.number().int().nonnegative(),
        dispatchCount: z.number().int().nonnegative(),
        handoffCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const realMissionE2EEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: idSchema,
    appVersion: z.string().min(1).max(64),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    status: z.enum(['pass', 'fail']),
    workspaceSha256: sha256Schema,
    expectedContentSha256: sha256Schema,
    mission: missionProofSchema.nullable(),
    kickoff: kickoffProofSchema,
    panes: z.array(paneProofSchema).max(16),
    dispatches: z.array(dispatchProofSchema).max(64),
    handoffs: z.array(handoffProofSchema).max(64),
    repository: repositoryProofSchema,
    failure: failureSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.finishedAt < evidence.startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt precedes startedAt',
      });
    }
    if (evidence.status === 'fail') {
      if (!evidence.failure) {
        context.addIssue({
          code: 'custom',
          path: ['failure'],
          message: 'failed evidence requires a closed failure receipt',
        });
      }
      return;
    }
    const orchestrators = evidence.panes.filter(
      (pane) =>
        pane.role === 'orchestrator' &&
        pane.agentRef === REAL_MISSION_E2E_ORCHESTRATOR_ID &&
        pane.adapterId === REAL_MISSION_E2E_ORCHESTRATOR_CLI,
    );
    const workers = evidence.panes.filter(
      (pane) =>
        pane.role === 'worker' &&
        pane.agentRef === REAL_MISSION_E2E_WORKER_ID &&
        pane.adapterId === REAL_MISSION_E2E_WORKER_CLI,
    );
    const pass =
      evidence.failure === null &&
      evidence.mission?.status === 'done' &&
      evidence.kickoff.sessionId !== null &&
      evidence.kickoff.idleAt !== null &&
      evidence.kickoff.busyAt !== null &&
      evidence.kickoff.ptyDataAt !== null &&
      evidence.kickoff.ptyChunkSha256 !== null &&
      evidence.kickoff.idleAt <= evidence.kickoff.busyAt &&
      evidence.kickoff.idleAt <= evidence.kickoff.ptyDataAt &&
      evidence.panes.length === 2 &&
      orchestrators.length === 1 &&
      workers.length === 1 &&
      workers.every(
        (pane) =>
          pane.workerIncarnationId !== null &&
          pane.ptySpawnedAt !== null &&
          pane.ptyDataAt !== null &&
          pane.ptyChunkSha256 !== null &&
          pane.ptySpawnedAt <= pane.ptyDataAt,
      ) &&
      evidence.dispatches.length === 1 &&
      evidence.dispatches.every(
        (dispatch) =>
          dispatch.state === 'completed' &&
          dispatch.routeReservationId !== null &&
          dispatch.routeConsumedAt !== null &&
          dispatch.routeConsumerMatches &&
          dispatch.workerIncarnationId !== null &&
          dispatch.sessionId !== null &&
          dispatch.handoffId !== null &&
          dispatch.handoffAcceptedAt !== null &&
          dispatch.integrationReceipt?.kind === 'worktree_integrated',
      ) &&
      evidence.handoffs.length === 1 &&
      evidence.handoffs.every(
        (handoff) =>
          handoff.status === 'success' &&
          handoff.delivered &&
          handoff.deliveryState !== 'queued' &&
          handoff.acceptedAt !== null &&
          handoff.acceptedBySessionId !== null,
      ) &&
      evidence.repository.finalHeadSha !== null &&
      evidence.repository.initialHeadSha !== null &&
      evidence.repository.resultSha256 === evidence.expectedContentSha256 &&
      evidence.repository.commitCount === 2 &&
      evidence.repository.clean &&
      !evidence.repository.changedBeforeWorker &&
      evidence.repository.exactSingleCommit &&
      evidence.repository.initialHeadSha !== evidence.repository.finalHeadSha &&
      evidence.dispatches[0]?.integrationReceipt?.referenceSha ===
        evidence.repository.finalHeadSha &&
      workers[0]?.sessionId === evidence.dispatches[0]?.sessionId &&
      workers[0]?.workerIncarnationId ===
        evidence.dispatches[0]?.workerIncarnationId &&
      evidence.handoffs[0]?.id === evidence.dispatches[0]?.handoffId &&
      evidence.handoffs[0]?.acceptedBySessionId ===
        evidence.kickoff.sessionId &&
      orchestrators[0]?.sessionId === evidence.kickoff.sessionId;
    if (!pass) {
      context.addIssue({
        code: 'custom',
        message: 'PASS evidence is missing one or more real-mission invariants',
      });
    }
  });

export type RealMissionE2EEvidence = z.infer<
  typeof realMissionE2EEvidenceSchema
>;

export function isRealMissionE2E(argv: readonly string[]): boolean {
  return argv.includes(REAL_MISSION_E2E_FLAG);
}

export function isExclusiveRealMissionE2E(
  argv: readonly string[],
  incompatibleArguments: readonly string[] = [
    '--smoke-test',
    'nexus-smoke-test',
  ],
): boolean {
  return (
    argv.filter((value) => value === REAL_MISSION_E2E_FLAG).length === 1 &&
    incompatibleArguments.every((value) => !argv.includes(value))
  );
}

/**
 * Live process check — do not freeze at module load. Packaged Electron may
 * reorder argv around `--`, and the release gate also sets an env marker.
 */
export function isCurrentProcessRealMissionE2E(): boolean {
  if (process.env.NEXUS_REAL_MISSION_E2E === '1') return true;
  return isRealMissionE2E(process.argv);
}

export function parseRealMissionE2EEvidence(raw: unknown): RealMissionE2EEvidence {
  return realMissionE2EEvidenceSchema.parse(raw);
}

import type { AgentCategory } from '../../shared/orch-types';
import type { TaskPlanAgentSnapshot } from './task-store';
import {
  classifyTask,
  resolveRoutableModel,
  type RouteDecision,
} from './task-router';
import type { TaskScheduleMeta } from './mission-scheduler-meta';
import {
  parseGuidedTaskKind,
  type GuidedTaskKind,
} from './guided-task-kind';

export {
  supportsAdvisoryParticipationCli,
  // codex: governed argv profile. grok: kernel Seatbelt `--sandbox read-only`
  // (physical escape probe 27/07: write outside the sandbox denied, session
  // state under the GROK_HOME overlay works).
  supportsMechanicallyReadOnlyCli,
} from '../../shared/mission-advisory';

export type PlannedExecutionMode = 'isolated_worktree' | 'read_only';

const MECHANICALLY_WORKSPACE_WRITE_CLIS = new Set(['codex']);

/**
 * Id-level backstop for sealed task/claim authority. Live builtin origin and
 * the exact adapter argv declaration are rechecked again before process spawn.
 */
export function supportsMechanicallyWorkspaceWriteCli(
  adapterId: string,
): boolean {
  return MECHANICALLY_WORKSPACE_WRITE_CLIS.has(adapterId);
}

export interface SealedWorkerRoute {
  readonly decision: RouteDecision;
  readonly routeContract: {
    readonly adapterId: string;
    readonly model?: string;
    readonly effort?: string;
  };
}

export interface LiveRosterAdapter {
  readonly id: string;
  readonly installed: boolean;
  readonly models: {
    readonly list: readonly string[];
    readonly default: string;
  };
}

/**
 * A sealed plan is a closed graph. Missing dependencies can never be
 * satisfied because the scheduler intentionally sees only tasks in the
 * current receipt; cycles likewise have no admissible first task.
 */
export function assertClosedAcyclicPlanDependencies(
  tasks: readonly {
    readonly id: string;
    readonly dependsOn: readonly string[];
  }[],
): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`task plan contains duplicate id: ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(
          `task ${task.id} depends on unknown task ${dependency}; ` +
            'sealed plans cannot depend on work outside their receipt',
        );
      }
      if (dependency === task.id) {
        throw new Error(`task ${task.id} cannot depend on itself`);
      }
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`task plan contains a dependency cycle at ${id}`);
    }
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

/**
 * Resolve one sealed roster member against the live adapter snapshot.
 *
 * This is deliberately not a router/failover decision: the planner already
 * selected the worker identity. If that exact CLI/model is unavailable the
 * mission must block instead of silently substituting another provider.
 */
export function resolveSealedWorkerRoute(input: {
  readonly taskText: string;
  readonly agent: TaskPlanAgentSnapshot;
  readonly adapters: readonly LiveRosterAdapter[];
  readonly rosterHash: string;
  /**
   * Squad orchestrator CLI. Claude may advise (read_only) only when it is NOT
   * the orchestrator — reserveClaude protects the single OAuth session from
   * concurrent Claude processes. Undefined fails closed (Claude forbidden).
   */
  readonly orchestratorCliId?: string;
}): SealedWorkerRoute {
  if (input.agent.category === 'orchestrator') {
    throw new Error('sealed worker route cannot target the orchestrator');
  }
  if (input.agent.cli === 'claude' && input.orchestratorCliId !== 'codex') {
    throw new Error(
      'roster_route_forbidden: reserveClaude mantém o Claude OAuth exclusivo do orquestrador; ' +
        'Claude só participa como advisor read_only quando o orquestrador é codex',
    );
  }
  const adapter = input.adapters.find((candidate) => candidate.id === input.agent.cli);
  if (!adapter || !adapter.installed) {
    throw new Error(
      `roster_route_unavailable: CLI ${input.agent.cli} do agente ` +
        `${input.agent.agentName} não está instalada; nenhum provider substituto foi aceito`,
    );
  }
  const requestedModel = input.agent.model ?? adapter.models.default;
  const resolved = resolveRoutableModel(requestedModel, adapter.models.list);
  if (!resolved.ok) {
    throw new Error(
      `roster_model_unavailable: modelo ${requestedModel} do agente ` +
        `${input.agent.agentName} não existe na família real da CLI ${adapter.id}`,
    );
  }
  const classification = classifyTask(input.taskText);
  const routeContract = Object.freeze({
    adapterId: adapter.id,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(input.agent.effort ? { effort: input.agent.effort } : {}),
  });
  return Object.freeze({
    routeContract,
    decision: Object.freeze({
      tier: classification.tier,
      adapterId: routeContract.adapterId,
      ...(routeContract.model ? { model: routeContract.model } : {}),
      ...(routeContract.effort ? { effort: routeContract.effort } : {}),
      reason:
        `roster selado ${input.rosterHash.slice(0, 12)}: agente ` +
        `${input.agent.id}/${input.agent.agentName}; sem reroute automático`,
      alternatives: [],
    }),
  });
}

/** Fail closed if mutable task metadata diverges from the sealed receipt. */
export interface SealedTaskScheduleInput {
  readonly plannerId: string;
  readonly taskId: string;
  readonly agentRef: string;
  readonly agentCategory: AgentCategory;
  readonly plannedTitle: string;
  readonly plannedDetail: string;
  readonly task: {
    readonly title: string;
    readonly detail: string;
  };
}

export type SealedTaskSchedule = TaskScheduleMeta & {
  readonly agentRef: string;
  readonly agentCategory: Exclude<AgentCategory, 'orchestrator'>;
  readonly executionMode: PlannedExecutionMode;
  readonly guidedTaskKind: GuidedTaskKind | null;
};

export function assertSealedTaskSchedule(
  planned: SealedTaskScheduleInput,
  meta: TaskScheduleMeta | null,
): SealedTaskSchedule {
  if (
    planned.task.title !== planned.plannedTitle ||
    planned.task.detail !== planned.plannedDetail
  ) {
    throw new Error(`sealed task ${planned.taskId} divergiu do receipt imutável`);
  }
  if (!meta?.agentRef || !meta.agentCategory || !meta.executionMode) {
    throw new Error(`sealed task ${planned.taskId} não possui contrato de execução completo`);
  }
  if (
    meta.agentRef !== planned.agentRef ||
    meta.agentCategory !== planned.agentCategory
  ) {
    throw new Error(`sealed task ${planned.taskId} divergiu do agente/categoria do roster`);
  }
  if (
    meta.executionMode === 'isolated_worktree' &&
    meta.ownership.files.length === 0
  ) {
    throw new Error(`sealed task ${planned.taskId} exige ownership.files no worktree`);
  }
  const guidedTaskKind = parseGuidedTaskKind({
    plannerId: planned.plannerId,
    agentCategory: meta.agentCategory,
    executionMode: meta.executionMode,
    domains: meta.ownership.domains,
    label: planned.taskId,
  });
  // Read-only is an execution capability, not a semantic category. The seal
  // already binds the exact roster identity and rejects CLIs without native
  // confinement; production dispatch repeats that capability check against
  // the live route before materializing the worker.
  return Object.freeze({
    ...meta,
    agentRef: meta.agentRef,
    agentCategory: meta.agentCategory,
    executionMode: meta.executionMode,
    guidedTaskKind,
  });
}

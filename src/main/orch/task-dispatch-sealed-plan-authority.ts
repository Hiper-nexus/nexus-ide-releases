import { z } from "zod";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import { ScopedStoreCorruptionError } from "./scoped-store";
import { isRoutableModelResolution } from "./task-router";
import { assertSealedTaskSchedule } from "./mission-scheduler-plan";
import {
  sealedPlanDispatchSchema,
  sealedRosterDispatchSchema,
  taskDispatchOwnershipSchema,
  taskDispatchRouteContractSchema,
  taskDispatchTokenHash,
  taskProviderRerouteDirectiveSchema,
  type TaskDispatchRow,
} from "./task-dispatch-codec";
import type { TaskDispatchDatabase } from "./task-dispatch-persistence";

const sealedAuthorityPlanSchema = sealedPlanDispatchSchema.extend({
  version: z.literal(1),
  squadId: z.string().min(1).max(128),
});

interface RawPlanAuthority {
  readonly plan_hash: string;
  readonly planner_json: string;
  readonly squad_id: string | null;
  readonly roster_hash: string | null;
  readonly roster_snapshot_json: string | null;
}

interface RawTaskAuthority {
  readonly mission_id: string | null;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
}

const routeDecisionProjectionSchema = z
  .object({
    adapterId: z.string().min(1).max(128),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
  })
  .passthrough();

const routeReservationProjectionSchema = z
  .object({
    id: z.string().min(1).max(256),
    mission_id: z.string().min(1).max(256),
    intent_version: z.number().int().nonnegative(),
    decision_json: z.string(),
    adapter_id: z.string().min(1).max(128),
    model: z.string().min(1).max(256).nullable(),
    effort: z.string().min(1).max(64).nullable(),
    consumed_at: z.number().int().nonnegative(),
    consumed_by_session: z.string().min(1).max(256),
  })
  .strict();

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Read only the roster identity needed before a provider reroute. A reroute
 * can happen while the route reservation is intentionally being retired, so
 * it must not require the stronger "consumed reservation" proof used by the
 * normal claim/completion path. The plan and roster hashes remain mandatory,
 * and the substitute must stay in the task's sealed category.
 */
export function assertSealedRerouteTargetAgent(
  db: TaskDispatchDatabase,
  dispatch: TaskDispatchRow,
  targetAgentRef: string,
) {
  const rawPlan = db
    .prepare(
      `SELECT plan_hash, planner_json, squad_id, roster_hash,
              roster_snapshot_json
       FROM mission_task_plans
       WHERE mission_id = ? AND intent_version = ?`,
    )
    .get(dispatch.mission_id, dispatch.intent_version) as
    | RawPlanAuthority
    | undefined;
  if (
    !rawPlan ||
    !rawPlan.squad_id ||
    !rawPlan.roster_hash ||
    !rawPlan.roster_snapshot_json ||
    taskDispatchTokenHash(rawPlan.planner_json) !== rawPlan.plan_hash ||
    taskDispatchTokenHash(rawPlan.roster_snapshot_json) !== rawPlan.roster_hash
  ) {
    throw new ScopedStoreCorruptionError("sealed reroute roster hash");
  }
  let plan: z.infer<typeof sealedAuthorityPlanSchema>;
  let roster: z.infer<typeof sealedRosterDispatchSchema>;
  try {
    plan = sealedAuthorityPlanSchema.parse(JSON.parse(rawPlan.planner_json));
    roster = sealedRosterDispatchSchema.parse(
      JSON.parse(rawPlan.roster_snapshot_json),
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError("sealed reroute roster", {
      cause: error,
    });
  }
  const taskEntry = plan.tasks.find(
    (entry) => entry.taskId === dispatch.task_id,
  );
  const target = roster.agents.find((agent) => agent.id === targetAgentRef);
  if (
    plan.missionId !== dispatch.mission_id ||
    plan.intentVersion !== dispatch.intent_version ||
    plan.squadId !== rawPlan.squad_id ||
    plan.rosterHash !== rawPlan.roster_hash ||
    dispatch.roster_hash !== rawPlan.roster_hash ||
    !taskEntry ||
    !target ||
    target.category !== taskEntry.agentCategory
  ) {
    throw new Error(
      "reroute exige agente substituto da categoria no roster selado",
    );
  }
  return Object.freeze({ ...target });
}

/**
 * Re-read one task's complete execution contract from the immutable,
 * hash-bound planner receipt. Mutable task/dispatch projections are compared
 * with the seal, but never become the source of dependency or ownership
 * authority.
 */
export function assertSealedTaskDispatchPlanAuthority(
  db: TaskDispatchDatabase,
  dispatch: TaskDispatchRow,
) {
  const rawPlan = db
    .prepare(
      `SELECT plan_hash, planner_json, squad_id, roster_hash,
              roster_snapshot_json
       FROM mission_task_plans
       WHERE mission_id = ? AND intent_version = ?`,
    )
    .get(dispatch.mission_id, dispatch.intent_version) as
    RawPlanAuthority | undefined;
  if (
    !rawPlan ||
    !rawPlan.squad_id ||
    !rawPlan.roster_hash ||
    !rawPlan.roster_snapshot_json
  ) {
    throw new Error("task completion requires the current sealed plan");
  }

  if (
    taskDispatchTokenHash(rawPlan.planner_json) !== rawPlan.plan_hash ||
    taskDispatchTokenHash(rawPlan.roster_snapshot_json) !== rawPlan.roster_hash
  ) {
    throw new ScopedStoreCorruptionError("sealed task plan hash");
  }

  let plan: z.infer<typeof sealedAuthorityPlanSchema>;
  let roster: z.infer<typeof sealedRosterDispatchSchema>;
  try {
    plan = sealedAuthorityPlanSchema.parse(JSON.parse(rawPlan.planner_json));
    roster = sealedRosterDispatchSchema.parse(
      JSON.parse(rawPlan.roster_snapshot_json),
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError("sealed task plan authority", {
      cause: error,
    });
  }
  if (
    plan.missionId !== dispatch.mission_id ||
    plan.intentVersion !== dispatch.intent_version ||
    plan.squadId !== rawPlan.squad_id ||
    plan.rosterHash !== rawPlan.roster_hash ||
    dispatch.roster_hash !== rawPlan.roster_hash
  ) {
    throw new ScopedStoreCorruptionError("sealed task plan coordinates");
  }

  const taskEntries = plan.tasks.filter(
    (candidate) => candidate.taskId === dispatch.task_id,
  );
  if (
    taskEntries.length !== 1 ||
    new Set(plan.tasks.map((candidate) => candidate.taskId)).size !==
      plan.tasks.length
  ) {
    throw new ScopedStoreCorruptionError("sealed task plan identity");
  }
  const entry = taskEntries[0]!;
  const task = db
    .prepare(
      `SELECT mission_id, title, detail, status
       FROM tasks WHERE id = ?`,
    )
    .get(dispatch.task_id) as RawTaskAuthority | undefined;
  if (
    !task ||
    task.mission_id !== dispatch.mission_id ||
    task.title !== entry.title ||
    task.detail !== entry.detail
  ) {
    throw new ScopedStoreCorruptionError("sealed task projection");
  }

  const plannerId = entry.plannerId;
  if (typeof plannerId !== "string" || plannerId.length === 0) {
    throw new ScopedStoreCorruptionError("sealed task planner identity");
  }
  let schedule: ReturnType<typeof assertSealedTaskSchedule>;
  try {
    schedule = assertSealedTaskSchedule(
      {
        plannerId,
        taskId: entry.taskId,
        agentRef: entry.agentRef,
        agentCategory: entry.agentCategory,
        plannedTitle: entry.title,
        plannedDetail: entry.detail,
        task,
      },
      decodeTaskScheduleDetail(entry.detail).meta,
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError("sealed task scheduler contract", {
      cause: error,
    });
  }
  const plannedTaskIds = new Set(
    plan.tasks.map((candidate) => candidate.taskId),
  );
  if (
    new Set(schedule.dependsOn).size !== schedule.dependsOn.length ||
    schedule.dependsOn.includes(dispatch.task_id) ||
    schedule.dependsOn.some((dependency) => !plannedTaskIds.has(dependency))
  ) {
    throw new ScopedStoreCorruptionError("sealed task dependency graph");
  }

  let dispatchOwnership: z.infer<typeof taskDispatchOwnershipSchema>;
  let route: z.infer<typeof taskDispatchRouteContractSchema>;
  try {
    dispatchOwnership = taskDispatchOwnershipSchema.parse(
      JSON.parse(dispatch.ownership_json),
    );
    route = taskDispatchRouteContractSchema.parse(
      JSON.parse(dispatch.route_contract_json ?? "null"),
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError("sealed task dispatch projection", {
      cause: error,
    });
  }
  // Sob diretiva de reroute (gravada só pelo coordenador após esgotamento
  // físico terminal e re-validada pelo claim), a identidade executora
  // vinculada é o agente ALTERNATIVO do mesmo roster selado. O receipt do
  // plano permanece com o agentRef original — a diretiva é o único elo.
  let boundAgentRef = schedule.agentRef;
  if (dispatch.provider_reroute_json) {
    let directive: z.infer<typeof taskProviderRerouteDirectiveSchema>;
    try {
      directive = taskProviderRerouteDirectiveSchema.parse(
        JSON.parse(dispatch.provider_reroute_json),
      );
    } catch (error) {
      throw new ScopedStoreCorruptionError("sealed task provider reroute", {
        cause: error,
      });
    }
    if (directive.fromAgentRef !== schedule.agentRef) {
      throw new ScopedStoreCorruptionError("sealed task reroute identity");
    }
    boundAgentRef = directive.toAgentRef;
  }
  if (
    dispatch.agent_ref !== boundAgentRef ||
    dispatch.agent_category !== schedule.agentCategory ||
    dispatch.execution_mode !== schedule.executionMode ||
    !sameJson(dispatchOwnership, schedule.ownership)
  ) {
    throw new ScopedStoreCorruptionError("sealed task dispatch contract");
  }

  const agents = roster.agents.filter(
    (candidate) => candidate.id === boundAgentRef,
  );
  if (agents.length !== 1) {
    throw new ScopedStoreCorruptionError("sealed task roster identity");
  }
  const agent = agents[0]!;
  if (
    agent.category !== entry.agentCategory ||
    dispatch.worker_id !== agent.agentName ||
    route.adapterId !== agent.cli ||
    dispatch.adapter_id !== route.adapterId ||
    dispatch.model !== (route.model ?? null) ||
    dispatch.effort !== (route.effort ?? null) ||
    (agent.model !== undefined &&
      !isRoutableModelResolution(agent.model, route.model)) ||
    route.effort !== agent.effort
  ) {
    throw new ScopedStoreCorruptionError("sealed task route authority");
  }
  if (!dispatch.route_reservation_id) {
    throw new ScopedStoreCorruptionError("sealed task route reservation");
  }
  let reservation: z.infer<typeof routeReservationProjectionSchema>;
  let decision: z.infer<typeof routeDecisionProjectionSchema>;
  try {
    reservation = routeReservationProjectionSchema.parse(
      db
        .prepare(
          `SELECT id, mission_id, intent_version, decision_json, adapter_id,
                  model, effort, consumed_at, consumed_by_session
           FROM mission_route_reservations WHERE id = ?`,
        )
        .get(dispatch.route_reservation_id),
    );
    decision = routeDecisionProjectionSchema.parse(
      JSON.parse(reservation.decision_json),
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError("sealed task route reservation", {
      cause: error,
    });
  }
  if (
    reservation.id !== dispatch.route_reservation_id ||
    reservation.mission_id !== dispatch.mission_id ||
    reservation.intent_version !== dispatch.intent_version ||
    reservation.consumed_by_session !== `dispatch:${dispatch.id}` ||
    reservation.adapter_id !== route.adapterId ||
    reservation.model !== (route.model ?? null) ||
    reservation.effort !== (route.effort ?? null) ||
    decision.adapterId !== route.adapterId ||
    (decision.model ?? null) !== (route.model ?? null) ||
    (decision.effort ?? null) !== (route.effort ?? null)
  ) {
    throw new ScopedStoreCorruptionError(
      "sealed task consumed route authority",
    );
  }

  // Plan-wide, hash-bound dependency view. The current task reuses the fully
  // validated schedule; siblings are decoded straight from the immutable
  // planner receipt (null = undecodable → callers that must prove "no
  // consumers" fail closed).
  const planTaskDependencies = Object.freeze(
    plan.tasks.map((candidate) => {
      if (candidate.taskId === dispatch.task_id) {
        return Object.freeze({
          taskId: candidate.taskId,
          dependsOn: Object.freeze([...schedule.dependsOn]) as
            | readonly string[]
            | null,
        });
      }
      const meta = decodeTaskScheduleDetail(candidate.detail).meta;
      return Object.freeze({
        taskId: candidate.taskId,
        dependsOn: meta ? Object.freeze([...meta.dependsOn]) : null,
      });
    }),
  );

  return Object.freeze({
    entry: Object.freeze({ ...entry, plannerId }),
    roster: Object.freeze({
      ...roster,
      agents: Object.freeze(roster.agents.map((candidate) => Object.freeze({ ...candidate }))),
    }),
    schedule: Object.freeze({
      ...schedule,
      dependsOn: Object.freeze([...schedule.dependsOn]),
      ownership: Object.freeze({
        files: Object.freeze([...schedule.ownership.files]),
        symbols: Object.freeze([...schedule.ownership.symbols]),
        domains: Object.freeze([...schedule.ownership.domains]),
      }),
    }),
    agent: Object.freeze({ ...agent }),
    route: Object.freeze({ ...route }),
    routeConsumedAt: reservation.consumed_at,
    task: Object.freeze({ ...task }),
    planHash: rawPlan.plan_hash,
    planTaskDependencies,
  });
}

/**
 * Planned tasks whose sealed schedule consumes `taskId`. Fail-closed: a
 * sibling whose dependency meta cannot be decoded from the hash-bound planner
 * receipt is corruption, never an absent consumer.
 */
export function sealedPlanTaskConsumers(
  sealed: Pick<
    ReturnType<typeof assertSealedTaskDispatchPlanAuthority>,
    "planTaskDependencies"
  >,
  taskId: string,
): readonly string[] {
  const consumers: string[] = [];
  for (const entry of sealed.planTaskDependencies) {
    if (entry.taskId === taskId) continue;
    if (entry.dependsOn === null) {
      throw new ScopedStoreCorruptionError("sealed plan dependency decode");
    }
    if (entry.dependsOn.includes(taskId)) consumers.push(entry.taskId);
  }
  return Object.freeze(consumers);
}

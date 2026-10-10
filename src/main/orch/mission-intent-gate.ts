import {
  assertStepAndTokenBudget,
  canDispatchWorkers,
  canRunBootstrapEffects,
  canSubmitMissionHandoff,
  isRecoveryEligibleIntentState,
  isToolDeniedByContract,
  resolveEffectiveIntentState,
  type MissionIntentContract,
  type MissionIntentState,
} from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import { canonicalToolName } from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';
import { requireMissionLeaderSession } from './mission-leader-gate';
import { emitMissionIntentEvent } from './mission-intent-events';

export type IntentGateCode =
  | 'intent_required'
  | 'approval_required'
  | 'dispatch_required'
  | 'budget_exhausted'
  | 'handoff_origin'
  | 'tool_denied';

export interface IntentGateDenial {
  readonly ok: false;
  readonly code: IntentGateCode;
  readonly error: string;
  readonly intentState: MissionIntentState;
  readonly intentVersion: number;
}

export interface IntentGateAllow {
  readonly ok: true;
  readonly intentState: MissionIntentState;
  readonly intentVersion: number;
}

export type IntentGateResult = IntentGateAllow | IntentGateDenial;

export interface IntentGateContext {
  readonly mission: Pick<
    Mission,
    | 'id'
    | 'status'
    | 'description'
    | 'intentState'
    | 'intentContract'
    | 'intentVersion'
    | 'orchestratorSessionId'
  >;
  readonly taskCount?: number;
  readonly workerPaneCount?: number;
  /** Explicit prepare-project action sets this on the contract. */
  readonly allowPrepareProject?: boolean;
  /** Caller role for handoff origin checks. */
  readonly role?: string | null;
  /** Caller session id for handoff origin checks. */
  readonly sessionId?: string | null;
  /**
   * The caller is the operator's own pane, promoted to orchestrator by
   * `nexus_mission_create` (gate `promotedFromUserSession`). Main-owned, never
   * derived from MCP arguments.
   */
  readonly operatorHand?: boolean;
  /** Caller project/checkout scope, required to resolve the current mission
   * leader. Absent means the leader-identity checks below fail closed. */
  readonly scope?: ProjectExecutionScope;
  /**
   * When true, mission row was not found — effectful tools must fail closed
   * (used by mcp-dispatch after a null lookup).
   */
  readonly missionMissing?: boolean;
}

function effectiveContract(
  mission: IntentGateContext['mission'],
): MissionIntentContract | undefined {
  return mission.intentContract;
}

function deny(
  code: IntentGateCode,
  error: string,
  ctx: IntentGateContext,
  intentState: MissionIntentState,
  intentVersion: number,
  toolName: string,
): IntentGateDenial {
  emitMissionIntentEvent({
    name: 'intent_gate_denied',
    missionId: ctx.mission.id,
    intentState,
    intentVersion,
    reason: `${code}:${toolName}`,
  });
  return { ok: false, code, error, intentState, intentVersion };
}

/**
 * Main-process authority gate: bootstrap/delegation tools may not invent work
 * before the user has a goal and dispatch authorization.
 */
export function assertMissionIntentAllowsTool(
  toolName: string,
  ctx: IntentGateContext,
  args: Readonly<Record<string, unknown>> = {},
): IntentGateResult {
  const policy = effectPolicyForTool(toolName);
  const intentVersion = ctx.mission.intentVersion ?? 0;

  if (ctx.missionMissing) {
    return deny(
      'intent_required',
      'intent_required: mission not found for intent authority check',
      ctx,
      'awaiting_goal',
      intentVersion,
      toolName,
    );
  }

  const intentState = resolveEffectiveIntentState({
    mission: ctx.mission,
    taskCount: ctx.taskCount ?? 0,
    workerPaneCount: ctx.workerPaneCount ?? 0,
  });
  const contract = effectiveContract(ctx.mission);
  const canonical = canonicalToolName(toolName);
  const isCurrentContract =
    intentVersion > 0 && contract?.intentVersion === intentVersion;
  // A running mission is the user's signal that work is authorized. The
  // intent contract and approval dialog are still recorded for audit, but the
  // gate must not stall ordinary execution when the mission is alive.
  const isDispatchAuthorized = ctx.mission.status === 'running';

  if (policy === 'read-only' || policy === 'mission-control') {
    return { ok: true, intentState, intentVersion };
  }

  // Parent deny list applies to every non-read tool.
  if (isToolDeniedByContract(toolName, contract)) {
    return deny(
      'tool_denied',
      `tool_denied: ${toolName} is denied by mission contract`,
      ctx,
      intentState,
      intentVersion,
      toolName,
    );
  }

  // Lane-specific hard fences are intentionally removed: any running mission
  // must be able to spawn panes, run commands, read files and diagnose. Since
  // F-1157 the gate context restricts nothing (no allowlist, no role deny;
  // read-only only under the operator's Hardened mode). What remains is the
  // workspace sandbox of Hardened and the contract's deniedTools list.

  // Step/token budgets after dispatch.
  if (isDispatchAuthorized) {
    const budget = assertStepAndTokenBudget(contract);
    if (!budget.ok) {
      return deny(
        'budget_exhausted',
        budget.error,
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
  }

  if (policy === 'bootstrap-authority') {
    // Bootstrap/diagnostic tools (context_doctor, code_map_refresh, drafts, …)
    // are ordinary mission work. Once the mission is running they execute
    // without the pre-dispatch prepare-project ceremony.
    if (ctx.mission.status === 'running') {
      return { ok: true, intentState, intentVersion };
    }

    // prepare-project only when stored by explicit prepare UX (or flag).
    const prepareOk =
      isCurrentContract &&
      (ctx.allowPrepareProject || contract?.contextPolicy === 'prepare-project');
    const prepareContract =
      prepareOk && contract
        ? { ...contract, contextPolicy: 'prepare-project' as const }
        : prepareOk
          ? contract
          : null;

    const canRunBootstrap = canRunBootstrapEffects(
      intentState,
      prepareContract,
      toolName,
    );
    if (
      canRunBootstrap &&
      (!isRecoveryEligibleIntentState(intentState) || isDispatchAuthorized)
    ) {
      return { ok: true, intentState, intentVersion };
    }

    // Shell arming only — not status promotion to running / done.
    if (canonical === 'mission_create') {
      return { ok: true, intentState, intentVersion };
    }

    // set_status: post-dispatch, or fail-safe demotion to blocked/failed only.
    // legacy no longer opens arbitrary status writes.
    if (canonical === 'mission_set_status') {
      const nextStatus =
        typeof args.status === 'string' ? args.status : undefined;
      const currentSession = ctx.mission.orchestratorSessionId?.trim();
      if (
        nextStatus === 'done' && ctx.mission.status === 'done' &&
        ctx.role === 'orchestrator' && currentSession && ctx.scope &&
        requireMissionLeaderSession(ctx.scope, ctx.mission.id, { sessionId: ctx.sessionId }).ok
      ) {
        // Permit only the idempotent completion handler, including its final
        // push checkpoint. Other effects and stale/unbound sessions stay closed.
        return { ok: true, intentState, intentVersion };
      }
      const failSafe =
        nextStatus === 'blocked' || nextStatus === 'failed';
      const canStart =
        nextStatus === 'running' &&
        (intentState === 'ready_to_start' ||
          intentState === 'dispatched' ||
          canDispatchWorkers(intentState));
      // A mão do operador retoma a própria missão bloqueada (F-651). O agente
      // do "+ Pane" que marcou blocked ficava sem volta: running caía aqui como
      // dispatch_required e o destravamento dependia de uma tela que não existe.
      const operatorResume =
        nextStatus === 'running' &&
        ctx.mission.status === 'blocked' &&
        ctx.operatorHand === true &&
        ctx.role === 'orchestrator' &&
        Boolean(ctx.scope) &&
        requireMissionLeaderSession(ctx.scope!, ctx.mission.id, {
          sessionId: ctx.sessionId,
        }).ok;
      if (
        failSafe ||
        canStart ||
        operatorResume ||
        (canDispatchWorkers(intentState) && isDispatchAuthorized)
      ) {
        return { ok: true, intentState, intentVersion };
      }
      return deny(
        'dispatch_required',
        'dispatch_required: mission_set_status só após despacho autorizado (exceto blocked/failed)',
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }

    const code: IntentGateCode =
      intentState === 'awaiting_approval'
        ? 'approval_required'
        : 'intent_required';
    const error =
      code === 'approval_required'
        ? 'approval_required: confirme o plano antes de bootstrap/diagnóstico'
        : 'intent_required: informe um objetivo antes de context_doctor, drafts ou freeze';
    return deny(code, error, ctx, intentState, intentVersion, toolName);
  }

  if (policy === 'delegation-authority' || policy === 'workflow-authority') {
    // A running mission is enough to spawn panes and create worktrees. The
    // intent state is informative, not an additional gate, so legacy rows and
    // freshly started missions both work without an approved contract.
    if (isDispatchAuthorized || canDispatchWorkers(intentState)) {
      return { ok: true, intentState, intentVersion };
    }
    return deny(
      'dispatch_required',
      'dispatch_required: workers e worktrees só após a missão iniciar',
      ctx,
      intentState,
      intentVersion,
      toolName,
    );
  }

  // Handoff submit requires authenticated origin; ack is orchestrator-only in tool.
  if (policy === 'handoff-authority') {
    if (canonical === 'handoff_ack') {
      if (
        ctx.role === 'orchestrator' && ctx.mission.id && ctx.scope &&
        requireMissionLeaderSession(ctx.scope, ctx.mission.id, { sessionId: ctx.sessionId }).ok
      ) {
        return { ok: true, intentState, intentVersion };
      }
      return deny(
        'handoff_origin',
        'handoff_origin: ack requires mission orchestrator',
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
    const origin = canSubmitMissionHandoff({
      role: ctx.role,
      missionId: ctx.mission.id,
      sessionId: ctx.sessionId,
      intentState,
    });
    if (!origin.ok) {
      return deny(
        origin.code as IntentGateCode,
        origin.error,
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
    if (!isDispatchAuthorized) {
      return deny(
        'dispatch_required',
        'dispatch_required: contrato atual aprovado é obrigatório para handoff',
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
    return { ok: true, intentState, intentVersion };
  }

  // Execution effects (terminal, file write, editor, git) run once the
  // mission is running. The intent state records progress but does not gate
  // ordinary work; this keeps legacy and freshly-started missions usable.
  if (!isDispatchAuthorized) {
    return deny(
      'dispatch_required',
      'dispatch_required: execução bloqueada até a missão ser despachada',
      ctx,
      intentState,
      intentVersion,
      toolName,
    );
  }

  return { ok: true, intentState, intentVersion };
}

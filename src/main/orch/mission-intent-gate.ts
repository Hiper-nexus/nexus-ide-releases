import {
  assertStepAndTokenBudget,
  canDispatchWorkers,
  canRunBootstrapEffects,
  canSubmitMissionHandoff,
  hasCurrentApprovedDispatchContract,
  isRecoveryEligibleIntentState,
  isToolDeniedByContract,
  resolveEffectiveIntentState,
  type MissionIntentContract,
  type MissionIntentState,
} from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
import { canonicalToolName } from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';
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
  const isDispatchAuthorized =
    ctx.mission.status === 'running' &&
    hasCurrentApprovedDispatchContract(ctx.mission);

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

  // Consult lane: hard read-only. Only status transitions (blocked/failed/done
  // with durable note) may mutate mission metadata — never code/worktree/merge.
  if (contract?.lane === 'consult' && canonical !== 'mission_set_status') {
    return deny(
      'tool_denied',
      `tool_denied: consult lane is read-only; ${toolName} is not allowed ` +
        '(use read tools or mission_set_status with a durable note)',
      ctx,
      intentState,
      intentVersion,
      toolName,
    );
  }

  // Plan lane (grok-build plan-mode): read + plan.md writes + status only.
  // Worktree/merge/shell/code edits stay denied until the operator upgrades lane.
  // Read-only / mission-control already returned above (file_read, plan_read, …).
  if (contract?.lane === 'plan' && canonical !== 'mission_set_status') {
    const planAllowed = new Set([
      'file_write', // path-checked in file tool handler
      'plan_write',
      'handoff_submit',
      'memory_retain', // bootstrap-authority elsewhere; allowed here for design notes
    ]);
    if (!planAllowed.has(canonical)) {
      return deny(
        'tool_denied',
        `tool_denied: plan lane only allows design (plan.md / read tools); ` +
          `${toolName} is not allowed until the mission leaves plan mode`,
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
    // Narrow plan-side writes that must not re-enter bootstrap/dispatch gates.
    // file_write / plan_write / handoff_submit still need dispatch + origin below.
    if (canonical === 'memory_retain') {
      return { ok: true, intentState, intentVersion };
    }
  }

  // Ops lane: infra/operation work (SSH, deploy, backup, DNS) — shell/browser/
  // media execution effects run WITHOUT a frozen PREVC contract, but repo code
  // mutations (editor/file_write/git/worktree/merge/delegation) stay denied.
  // Read-only / mission-control already returned above; the allowed execution
  // effects still require dispatch authority in the final check below.
  if (contract?.lane === 'ops' && canonical !== 'mission_set_status') {
    const opsAllowed = new Set([
      'terminal_run',
      'bg_run',
      'browser_navigate',
      'browser_click',
      'browser_fill',
      'audio_generate',
      'image_generate',
      'video_generate',
      'memory_retain', // bootstrap-authority elsewhere; allowed here for ops notes
    ]);
    if (!opsAllowed.has(canonical)) {
      return deny(
        'tool_denied',
        `tool_denied: lane ops não altera código do repo; ${toolName} não é ` +
          'permitida (reabra a missão como standard)',
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
    // Narrow ops-side write that must not re-enter bootstrap/dispatch gates.
    if (canonical === 'memory_retain') {
      return { ok: true, intentState, intentVersion };
    }
  }

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
      const failSafe =
        nextStatus === 'blocked' || nextStatus === 'failed';
      if (
        failSafe ||
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
    if (!canDispatchWorkers(intentState)) {
      return deny(
        'dispatch_required',
        'dispatch_required: workers e worktrees só após início autorizado da missão',
        ctx,
        intentState,
        intentVersion,
        toolName,
      );
    }
    // Intent-first and immediate legacy shells both carry a current approved
    // contract. State alone is never dispatch authority.
    if (isDispatchAuthorized) {
      return { ok: true, intentState, intentVersion };
    }
    return deny(
      'approval_required',
      'approval_required: contrato atual precisa de aprovação antes de despachar workers',
      ctx,
      intentState,
      intentVersion,
      toolName,
    );
  }

  // Handoff submit requires authenticated origin; ack is orchestrator-only in tool.
  if (policy === 'handoff-authority') {
    if (canonical === 'handoff_ack') {
      if (ctx.role === 'orchestrator' && ctx.mission.id) {
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

  // legacy no longer bypasses execution — only real dispatch states.
  if (!canDispatchWorkers(intentState) || !isDispatchAuthorized) {
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

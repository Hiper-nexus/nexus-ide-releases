import {
  canDispatchWorkers,
  canRunBootstrapEffects,
  hasApprovedDispatchContract,
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
  | 'dispatch_required';

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
  const intentState = resolveEffectiveIntentState({
    mission: ctx.mission,
    taskCount: ctx.taskCount ?? 0,
    workerPaneCount: ctx.workerPaneCount ?? 0,
  });
  const intentVersion = ctx.mission.intentVersion ?? 0;
  const contract = effectiveContract(ctx.mission);
  const canonical = canonicalToolName(toolName);

  if (policy === 'read-only' || policy === 'mission-control') {
    return { ok: true, intentState, intentVersion };
  }

  if (policy === 'bootstrap-authority') {
    const prepareContract =
      ctx.allowPrepareProject || contract?.contextPolicy === 'prepare-project'
        ? contract
          ? { ...contract, contextPolicy: 'prepare-project' as const }
          : contract
        : contract;

    if (canRunBootstrapEffects(intentState, prepareContract, toolName)) {
      return { ok: true, intentState, intentVersion };
    }

    // Shell arming only — not status promotion to running / done.
    if (canonical === 'mission_create') {
      return { ok: true, intentState, intentVersion };
    }

    // set_status: post-dispatch, or fail-safe demotion to blocked/failed only.
    if (canonical === 'mission_set_status') {
      const nextStatus =
        typeof args.status === 'string' ? args.status : undefined;
      const failSafe =
        nextStatus === 'blocked' || nextStatus === 'failed';
      if (
        failSafe ||
        canDispatchWorkers(intentState) ||
        intentState === 'legacy' ||
        hasApprovedDispatchContract(contract)
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
    if (canDispatchWorkers(intentState)) {
      return { ok: true, intentState, intentVersion };
    }
    return deny(
      'dispatch_required',
      'dispatch_required: workers e worktrees só após início autorizado da missão',
      ctx,
      intentState,
      intentVersion,
      toolName,
    );
  }

  // Handoffs remain open so delivery receipts can complete.
  if (policy === 'handoff-authority') {
    return { ok: true, intentState, intentVersion };
  }

  if (!canDispatchWorkers(intentState) && intentState !== 'legacy') {
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

import {
  canDispatchWorkers,
  canRunBootstrapEffects,
  resolveEffectiveIntentState,
  type MissionIntentContract,
  type MissionIntentState,
} from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
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

/**
 * Main-process authority gate: bootstrap/delegation tools may not invent work
 * before the user has a goal and dispatch authorization.
 */
export function assertMissionIntentAllowsTool(
  toolName: string,
  ctx: IntentGateContext,
): IntentGateResult {
  const policy = effectPolicyForTool(toolName);
  const intentState = resolveEffectiveIntentState({
    mission: ctx.mission,
    taskCount: ctx.taskCount ?? 0,
    workerPaneCount: ctx.workerPaneCount ?? 0,
  });
  const intentVersion = ctx.mission.intentVersion ?? 0;
  const contract = effectiveContract(ctx.mission);

  if (policy === 'read-only' || policy === 'mission-control') {
    return { ok: true, intentState, intentVersion };
  }

  if (policy === 'bootstrap-authority') {
    const prepareOk =
      ctx.allowPrepareProject ||
      contract?.contextPolicy === 'prepare-project';
    if (
      canRunBootstrapEffects(
        intentState,
        prepareOk && contract
          ? { ...contract, contextPolicy: 'prepare-project' }
          : contract,
      )
    ) {
      return { ok: true, intentState, intentVersion };
    }
    // mission_create / set_status are allowed for shell arming.
    const canonical = toolName.replace(/^nexus_/, '');
    if (
      canonical === 'mission_create' ||
      canonical === 'mission_set_status' ||
      toolName === 'nexus_mission_create' ||
      toolName === 'nexus_mission_set_status'
    ) {
      return { ok: true, intentState, intentVersion };
    }
    const code: IntentGateCode =
      intentState === 'awaiting_approval'
        ? 'approval_required'
        : 'intent_required';
    const error =
      code === 'approval_required'
        ? 'approval_required: confirme o plano antes de bootstrap/diagnóstico'
        : 'intent_required: informe um objetivo antes de context_doctor, drafts ou freeze';
    emitMissionIntentEvent({
      name: 'intent_gate_denied',
      missionId: ctx.mission.id,
      intentState,
      intentVersion,
      reason: `${code}:${toolName}`,
    });
    return { ok: false, code, error, intentState, intentVersion };
  }

  if (policy === 'delegation-authority' || policy === 'workflow-authority') {
    if (canDispatchWorkers(intentState)) {
      return { ok: true, intentState, intentVersion };
    }
    emitMissionIntentEvent({
      name: 'intent_gate_denied',
      missionId: ctx.mission.id,
      intentState,
      intentVersion,
      reason: `dispatch_required:${toolName}`,
    });
    return {
      ok: false,
      code: 'dispatch_required',
      error:
        'dispatch_required: workers e worktrees só após início autorizado da missão',
      intentState,
      intentVersion,
    };
  }

  // execution / mission-effect / handoff — require dispatch or stay open for handoff progress
  if (policy === 'handoff-authority') {
    return { ok: true, intentState, intentVersion };
  }

  if (!canDispatchWorkers(intentState) && intentState !== 'legacy') {
    emitMissionIntentEvent({
      name: 'intent_gate_denied',
      missionId: ctx.mission.id,
      intentState,
      intentVersion,
      reason: `dispatch_required:${toolName}`,
    });
    return {
      ok: false,
      code: 'dispatch_required',
      error: 'dispatch_required: execução bloqueada até a missão ser despachada',
      intentState,
      intentVersion,
    };
  }

  return { ok: true, intentState, intentVersion };
}

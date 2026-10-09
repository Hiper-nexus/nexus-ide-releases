import { maestroKickoffBlockReason } from './maestro-boot-gate';
import { randomBytes } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import { sameProjectScope } from './project-scoped-broadcast';
import type { Mission } from '../../shared/orch-types';
import { hashMissionIntentAuthority } from './mission-pane-authority';

/**
 * Poke do operador durante o kickoff do Maestro.
 *
 * O recibo de kickoff só existia depois de waitForIdle (até 60s) + prova do
 * briefing. Uma linha civil nesse intervalo virava erro técnico em inglês
 * (`Mission direct requires the current kickoff receipt`). A linha entra na
 * fila ou o recibo é gravado quando o pane já está idle com o briefing
 * injetado — nunca um diagnóstico cru.
 */

export interface RememberedKickoffBrief {
  readonly missionId: string;
  readonly orchestratorSessionId: string;
  readonly intentVersion: number;
  readonly promptHash: string;
}

export interface QueuedKickoffDirect {
  readonly scope: ProjectExecutionScope;
  readonly directionId: string;
  readonly missionId: string;
  readonly targetAgentId: string | null;
  readonly text: string;
  readonly queuedAt: number;
  readonly intentVersion: number;
  readonly intentAuthorityHash: string | null;
  readonly kickoffAttemptId?: string;
}

export interface PendingKickoffBriefDelivery extends RememberedKickoffBrief {
  readonly scope: ProjectExecutionScope;
  readonly intentAuthorityHash: string | null;
  readonly attemptId: string;
}

export interface RecordIdleKickoffInput {
  readonly missionId: string;
  readonly sessionId: string;
  readonly intentVersion: number;
  readonly promptHash: string;
  readonly sessionIdle: boolean;
  readonly sessionOutput: string;
  readonly hasCurrentKickoffAcceptance: boolean;
  readonly recordKickoffAcceptance: (raw: {
    readonly missionId: string;
    readonly intentVersion: number;
    readonly orchestratorSessionId: string;
    readonly promptHash: string;
  }) => unknown;
}

const rememberedBriefByMission = new Map<string, RememberedKickoffBrief>();
const queuedDirectsByMission = new Map<string, QueuedKickoffDirect[]>();
const pendingBriefByMission = new Map<string, PendingKickoffBriefDelivery>();
const provedBriefByScope = new Map<string, PendingKickoffBriefDelivery>();

function pendingBriefKey(scope: ProjectExecutionScope, missionId: string): string {
  return JSON.stringify([missionId, scope.version, scope.identitySource, scope.installationId, scope.projectId,
    scope.checkoutId, scope.rootRealPath, scope.workspaceRootDevice, scope.workspaceRootInode]);
}

export function kickoffIntentAuthorityHash(mission: Pick<Mission, 'intentContract'>): string | null {
  return mission.intentContract
    ? hashMissionIntentAuthority(JSON.parse(JSON.stringify(mission.intentContract))) : null;
}

export function pendingKickoffBriefDelivery(scope: ProjectExecutionScope, missionId: string): PendingKickoffBriefDelivery | null {
  const pending = pendingBriefByMission.get(pendingBriefKey(scope, missionId));
  return pending && sameQueuedScope(pending.scope, scope) ? pending : null;
}

export function provedKickoffBriefDelivery(scope: ProjectExecutionScope, missionId: string): PendingKickoffBriefDelivery | null {
  return provedBriefByScope.get(pendingBriefKey(scope, missionId)) ?? null;
}

export function kickoffDeliveryMatchesMission(pending: PendingKickoffBriefDelivery, mission: Mission): boolean {
  return pending.orchestratorSessionId === mission.orchestratorSessionId &&
    pending.intentVersion === (mission.intentVersion ?? 0) && pending.intentAuthorityHash === kickoffIntentAuthorityHash(mission);
}

/** The caller has revalidated its Main-owned bootstrap before publishing this hold. */
export function beginKickoffBriefDelivery(scope: ProjectExecutionScope,
  brief: RememberedKickoffBrief & { readonly intentAuthorityHash: string | null }): PendingKickoffBriefDelivery {
  const pending = Object.freeze({ ...brief, scope: Object.freeze({ ...scope }), attemptId: randomBytes(32).toString('hex') });
  pendingBriefByMission.set(pendingBriefKey(pending.scope, brief.missionId), pending);
  provedBriefByScope.delete(pendingBriefKey(pending.scope, brief.missionId));
  queuedDirectsByMission.set(brief.missionId, (queuedDirectsByMission.get(brief.missionId) ?? []).map(item =>
    !item.kickoffAttemptId && sameQueuedScope(item.scope, scope) && item.intentVersion === brief.intentVersion &&
      item.intentAuthorityHash === brief.intentAuthorityHash ? { ...item, kickoffAttemptId: pending.attemptId } : item));
  return pending;
}

/** Adoption composes context while held; only its exact current handle can publish the final hash. */
export function updateKickoffBriefDeliveryHash(expected: PendingKickoffBriefDelivery, promptHash: string): PendingKickoffBriefDelivery {
  const key = pendingBriefKey(expected.scope, expected.missionId);
  if (pendingBriefByMission.get(key) !== expected) throw new Error('kickoff_delivery_attempt_changed');
  const updated = Object.freeze({ ...expected, promptHash });
  pendingBriefByMission.set(key, updated);
  return updated;
}

export function endKickoffBriefDelivery(expected: PendingKickoffBriefDelivery, accepted = false): boolean {
  const key = pendingBriefKey(expected.scope, expected.missionId);
  if (pendingBriefByMission.get(key) !== expected) return false;
  pendingBriefByMission.delete(key);
  if (accepted) provedBriefByScope.set(key, expected);
  return true;
}

export function rememberKickoffBrief(brief: RememberedKickoffBrief): void {
  rememberedBriefByMission.set(brief.missionId, brief);
}

export function rememberedKickoffBrief(
  missionId: string,
): RememberedKickoffBrief | null {
  return rememberedBriefByMission.get(missionId) ?? null;
}

export function clearKickoffBrief(missionId: string): void {
  rememberedBriefByMission.delete(missionId);
}

export function enqueueKickoffDirect(
  command: Omit<QueuedKickoffDirect, 'queuedAt' | 'directionId'> & { readonly queuedAt?: number },
): QueuedKickoffDirect {
  const item: QueuedKickoffDirect = {
    scope: Object.freeze({ ...command.scope }),
    directionId: randomBytes(32).toString('hex'),
    missionId: command.missionId,
    targetAgentId: command.targetAgentId,
    text: command.text,
    queuedAt: command.queuedAt ?? Date.now(),
    intentVersion: command.intentVersion,
    intentAuthorityHash: command.intentAuthorityHash,
    ...(command.kickoffAttemptId ? { kickoffAttemptId: command.kickoffAttemptId } : {}),
  };
  const existing = queuedDirectsByMission.get(command.missionId) ?? [];
  queuedDirectsByMission.set(command.missionId, [...existing, item]);
  return item;
}

function sameQueuedScope(left: ProjectExecutionScope, right: ProjectExecutionScope): boolean {
  return left.version === right.version && left.identitySource === right.identitySource && sameProjectScope(left, right) &&
    left.workspaceRootDevice === right.workspaceRootDevice && left.workspaceRootInode === right.workspaceRootInode;
}

export function takeKickoffDirects(missionId: string, scope: ProjectExecutionScope, kickoffAttemptId?: string): QueuedKickoffDirect[] {
  const queued = queuedDirectsByMission.get(missionId) ?? [];
  const selected = (item: QueuedKickoffDirect) => sameQueuedScope(item.scope, scope) &&
    (kickoffAttemptId === undefined || item.kickoffAttemptId === kickoffAttemptId);
  const remaining = queued.filter(item => !selected(item));
  if (remaining.length) queuedDirectsByMission.set(missionId, remaining);
  else queuedDirectsByMission.delete(missionId);
  return queued.filter(selected);
}

export function peekKickoffDirects(missionId: string, scope: ProjectExecutionScope): readonly QueuedKickoffDirect[] {
  return (queuedDirectsByMission.get(missionId) ?? []).filter(item => sameQueuedScope(item.scope, scope));
}

export function resetKickoffDirectQueueForTests(): void {
  rememberedBriefByMission.clear();
  queuedDirectsByMission.clear();
  pendingBriefByMission.clear();
  provedBriefByScope.clear();
}

export function isKickoffReceiptMessage(message: string): boolean {
  return /current kickoff receipt/i.test(message);
}

/**
 * Falhas do caminho `direct` que, SEM recibo, significam kickoff em curso —
 * não "Maestro morto, respawne".
 */
export function isKickoffInProgressMessage(
  message: string,
  hasCurrentKickoffAcceptance: boolean,
): boolean {
  if (isKickoffReceiptMessage(message)) return true;
  // Autoridade incompleta enfileira MESMO com recibo: o revival grava o
  // recibo já no spawn e a autoridade só fecha depois — rejeitar aqui
  // vazava "orchestrator authority is incomplete" cru pro operador (19/08).
  if (/orchestrator authority is incomplete/i.test(message)) return true;
  if (hasCurrentKickoffAcceptance) return false;
  return (
    /live orchestrator session/i.test(message) ||
    /orchestrator session is not live/i.test(message)
  );
}

export function isKickoffInProgressError(
  error: unknown,
  hasCurrentKickoffAcceptance: boolean,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isKickoffInProgressMessage(message, hasCurrentKickoffAcceptance);
}

/**
 * Recibo automático: pane idle, briefing já injetado (hash lembrado), tela
 * sem OAuth/first-run. Não espera a prova de Enter/paste.
 */
export function tryRecordIdleKickoffAcceptance(
  input: RecordIdleKickoffInput,
): boolean {
  if (input.hasCurrentKickoffAcceptance) return true;
  if (!input.sessionIdle) return false;
  if (!input.promptHash) return false;
  if (maestroKickoffBlockReason(input.sessionOutput)) return false;
  try {
    input.recordKickoffAcceptance({
      missionId: input.missionId,
      intentVersion: input.intentVersion,
      orchestratorSessionId: input.sessionId,
      promptHash: input.promptHash,
    });
    return true;
  } catch {
    return false;
  }
}

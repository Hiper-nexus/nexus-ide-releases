import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { missionLifecycleKey } from './mission-lifecycle-lock';
import type { CodeCompletionCertification } from './mission-code-completion';
import {
  canMarkTurnSettled,
  type SettlementEffectView,
} from './effect-settlement-gate';
import { EffectOutboxStore } from './effect-outbox';
import { createScopedHandoffStore } from './handoff-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

export interface AutomaticCompletionProof {
  /** Opaque Main-issued certification; serialized/cloned claims do not verify. */
  readonly codeCompletion?: CodeCompletionCertification;
  readonly status: 'verified' | 'unavailable';
  readonly candidateFingerprint?: string;
  readonly deletedArtifactPaths?: readonly string[];
  readonly note?: string;
}

/**
 * ORC-02: a prova de conclusão só vale se o turno estiver assentado —
 * nenhum `checkpoint.capture`/`handoff.deliver` pending/running.
 */
export function automaticCompletionEffectsSettled(
  effects: readonly SettlementEffectView[],
  threadId?: string,
): boolean {
  return canMarkTurnSettled(effects, threadId).settled;
}

/**
 * ORC-02 no estado durável: lê o outbox do escopo e o ledger de handoff.
 * `handoff.deliver` não entra em effect_outbox (o enum não aceita o tipo);
 * a entrega real fica na fila do handoff. A sessão provada do Maestro fica
 * de fora: o resumo dela não é entregue de volta para ela. Usado pelo
 * caminho de conclusão antes de fechar.
 */
export function assertCompletionEffectsSettled(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  threadId?: string,
  options?: { readonly excludeSessionId?: string },
): void {
  const outbox = new EffectOutboxStore(runtimeManager, scope);
  const open = [
    ...outbox.listByStatus('pending', 200),
    ...outbox.listByStatus('running', 200),
  ];
  const excludeSessionId = options?.excludeSessionId?.trim() ?? '';
  const queuedDeliveries = createScopedHandoffStore(
    runtimeManager,
    scope,
  )
    .listQueuedDeliveries(threadId)
    .filter(
      (delivery) =>
        !(excludeSessionId && delivery.sessionId === excludeSessionId),
    );
  const gate = canMarkTurnSettled(
    [
      ...open.map((entry) => ({
        type: entry.type,
        status: entry.status,
        threadId: entry.threadId,
      })),
      ...queuedDeliveries.map((delivery) => ({
        type: 'handoff.deliver',
        status: 'pending' as const,
        threadId: delivery.missionId,
      })),
    ],
    threadId,
  );
  if (!gate.settled) {
    throw new Error(
      `completion_effects_pending: turno terminal com efeitos não assentados — ${gate.reason ?? ''}`,
    );
  }
}

type CompletionMission = Pick<Mission, 'id' | 'intentVersion' | 'updatedAt' | 'intentState'>;
const activeProofs = new Map<string, Readonly<AutomaticCompletionProof>>();

function proofKey(scope: ProjectExecutionScope, mission: CompletionMission): string {
  return JSON.stringify([
    missionLifecycleKey(scope, mission.id),
    scope.version,
    scope.identitySource,
    scope.workspaceRootDevice,
    scope.workspaceRootInode,
    mission.intentVersion ?? 0,
    mission.updatedAt,
    mission.intentState ?? 'legacy',
  ]);
}

/** Only the current synchronous completion boundary can observe this proof. */
export function withAutomaticCompletionProof(
  scope: ProjectExecutionScope,
  mission: CompletionMission,
  proof: AutomaticCompletionProof,
  operation: () => boolean,
): boolean {
  const key = proofKey(scope, mission);
  const previous = activeProofs.get(key);
  activeProofs.set(key, Object.freeze({
    ...proof,
    ...(proof.deletedArtifactPaths
      ? { deletedArtifactPaths: Object.freeze([...proof.deletedArtifactPaths]) } : {}),
  }));
  try {
    return operation();
  } finally {
    if (previous) activeProofs.set(key, previous);
    else activeProofs.delete(key);
  }
}

export function getAutomaticCompletionProof(
  scope: ProjectExecutionScope,
  mission: CompletionMission,
): Readonly<AutomaticCompletionProof> | null {
  return activeProofs.get(proofKey(scope, mission)) ?? null;
}

export function isAutomaticCompletionProof(
  value: unknown,
  scope?: ProjectExecutionScope,
  mission?: CompletionMission,
): value is Readonly<AutomaticCompletionProof> {
  if (scope && mission) return value != null && value === getAutomaticCompletionProof(scope, mission);
  if (scope || mission) return false;
  return [...activeProofs.values()].some((proof) => proof === value);
}

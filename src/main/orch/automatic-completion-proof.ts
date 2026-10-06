import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { missionLifecycleKey } from './mission-lifecycle-lock';
import type { CodeCompletionCertification } from './mission-code-completion';

export interface AutomaticCompletionProof {
  /** Opaque Main-issued certification; serialized/cloned claims do not verify. */
  readonly codeCompletion?: CodeCompletionCertification;
  readonly status: 'verified' | 'unavailable';
  readonly candidateFingerprint?: string;
  readonly deletedArtifactPaths?: readonly string[];
  readonly note?: string;
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

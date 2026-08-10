import {
  getAdapter,
  isBuiltinAdapter,
} from '../adapters/adapter-registry';
import {
  supportsEnforceableReadOnlyNativeAuthority,
  supportsEnforceableWorkspaceWriteNativeAuthority,
} from '../pty/autonomous-cli-policy';
import { getOrchSettings } from '../persistence/settings-store';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { isReleaseQualifiedMissionWorkerCli } from './squad-runtime-policy';
import {
  supportsAdvisoryParticipationCli,
  supportsMechanicallyReadOnlyCli,
} from '../../shared/mission-advisory';

export interface MissionWorkerSpawnGate {
  readonly adapterId: string;
  readonly missionId?: string;
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly readOnly?: boolean;
  /**
   * Per-mission "Escolha livre de agentes" opt-in (contract-sealed). When set,
   * any live cli-pty may write inside its execution scope even under the global
   * `governed` policy — the operator explicitly chose it for this mission.
   */
  readonly freeAgentChoice?: boolean;
}

/**
 * Last physical boundary before a governed worker can reach credential probes,
 * RPC, or PTY creation. Persisted rosters, sticky routes, legacy receipts and
 * callers without a contextRevision are data — none of them can widen this
 * release-owned allowlist under `governed`.
 *
 * Under `operator-choice` (orch.squadCliPolicy), any live cli-pty may write
 * inside its task worktree; session authority and Main-owned merge remain the
 * promotion boundary.
 *
 * Manual Terminal panes have no missionId and remain multi-provider. An
 * explicitly identified mission orchestrator is also outside the worker
 * boundary (Maestro has its own read-only/delegation authority).
 */
export function assertReleaseQualifiedMissionWorkerSpawn(
  options: MissionWorkerSpawnGate,
): void {
  if (!options.missionId || options.role === 'orchestrator') return;
  const adapter = getAdapter(options.adapterId);
  const operatorChoice = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  // Per-mission free-choice opt-in widens the lane exactly like the global
  // operator-choice policy: any live cli-pty writes inside its execution scope.
  if ((operatorChoice || options.freeAgentChoice === true) && adapter?.kind === 'cli-pty') {
    return;
  }
  const qualified =
    adapter?.kind === 'cli-pty' &&
    isReleaseQualifiedMissionWorkerCli(adapter.id) &&
    isBuiltinAdapter(adapter.id) &&
    supportsEnforceableWorkspaceWriteNativeAuthority(adapter) &&
    (options.readOnly !== true ||
      supportsEnforceableReadOnlyNativeAuthority(adapter));
  if (qualified) return;
  const readOnlyParticipant =
    options.readOnly === true &&
    adapter?.kind === 'cli-pty' &&
    isBuiltinAdapter(adapter.id) &&
    (supportsMechanicallyReadOnlyCli(adapter.id) ||
      supportsAdvisoryParticipationCli(adapter.id)) &&
    (supportsEnforceableReadOnlyNativeAuthority(adapter) ||
      supportsAdvisoryParticipationCli(adapter.id));
  if (readOnlyParticipant) return;
  throw new Error(
    `governed_worker_spawn_unsupported: ${options.adapterId} não pode executar ` +
      'como worker autônomo de missão nesta release; use o adapter Codex builtin ' +
      // Nav real: Configurações › Squads (OrchestratorDefaults). Não existe
      // seção "Orquestração" — mandar o operador para lá custava a busca toda.
      'qualificado, ative Configurações › Squads › Escolha livre, ou abra ' +
      'esse CLI manualmente no Terminal fora da missão',
  );
}

/**
 * Whether a revision-bound writable worker may use this adapter under the
 * current squad CLI policy. Codex native sandbox qualifies in governed mode;
 * under operator-choice any live cli-pty qualifies for an isolated task
 * worktree.
 */
export function isRevisionBoundWritableWorkerAdapterAllowed(
  adapterId: string,
): boolean {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') {
    return false;
  }
  if (isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)) {
    return true;
  }
  return (
    adapter.id === 'codex' &&
    isBuiltinAdapter(adapter.id) &&
    supportsEnforceableWorkspaceWriteNativeAuthority(adapter)
  );
}

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
} from './mission-scheduler-plan';

export interface MissionWorkerSpawnGate {
  readonly adapterId: string;
  readonly missionId?: string;
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly readOnly?: boolean;
}

/**
 * Last physical boundary before a governed worker can reach credential probes,
 * RPC, or PTY creation. Persisted rosters, sticky routes, legacy receipts and
 * callers without a contextRevision are data — none of them can widen this
 * release-owned allowlist under `governed`.
 *
 * Under `operator-choice` (orch.squadCliPolicy), any builtin cli-pty may write;
 * the Nexus Seatbelt at spawn remains the real boundary.
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
  if (
    operatorChoice &&
    options.readOnly !== true &&
    adapter?.kind === 'cli-pty' &&
    isBuiltinAdapter(adapter.id)
  ) {
    return;
  }
  throw new Error(
    `governed_worker_spawn_unsupported: ${options.adapterId} não pode executar ` +
      'como worker autônomo de missão nesta release; use o adapter Codex builtin ' +
      'qualificado, ative Configurações › Orquestração › Escolha livre, ou abra ' +
      'esse CLI manualmente no Terminal fora da missão',
  );
}

/**
 * Whether a revision-bound writable worker may use this adapter under the
 * current squad CLI policy. Codex native sandbox always qualifies; under
 * operator-choice any builtin cli-pty qualifies (Seatbelt wraps at spawn).
 */
export function isRevisionBoundWritableWorkerAdapterAllowed(
  adapterId: string,
): boolean {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty' || !isBuiltinAdapter(adapter.id)) {
    return false;
  }
  if (isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)) {
    return true;
  }
  return (
    adapter.id === 'codex' &&
    supportsEnforceableWorkspaceWriteNativeAuthority(adapter)
  );
}

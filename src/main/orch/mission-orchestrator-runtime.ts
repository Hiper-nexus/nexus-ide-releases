import {
  hasNexusMcpCapability,
  orchestrationEvidenceOf,
  type OrchestrationEvidence,
} from '../../shared/adapter-types';
import {
  missionOrchestratorRuntimeSnapshotSchema,
  type MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { defaultSquadModelForAdapter } from '../../shared/squad-model-defaults';
import {
  getAdapter,
  listAdapterInfos,
} from '../adapters/adapter-registry';
import { listAccountInfos } from '../persistence/account-store';
import { getOrchSettings } from '../persistence/settings-store';
import { supportsEnforceableReadOnlyNativeAuthority } from '../pty/autonomous-cli-policy';

export interface ResolvedMissionOrchestratorRuntime {
  readonly adapterId: string;
  readonly model?: string;
  readonly accountId?: string;
  readonly effort?: string;
  readonly readOnly: boolean;
  readonly nativeReadOnly: boolean;
}

function present(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function preferredMissionOrchestratorAdapterId(
  orchestrator: Pick<SquadAgent, 'cli'>,
  defaultAdapterId: string | undefined,
): string {
  return present(orchestrator.cli) ?? present(defaultAdapterId) ?? 'claude';
}

/**
 * Converts a resolver result into the only runtime shape that an approval may
 * persist. Insecure or implicit confinement is rejected, never normalized.
 */
export function canonicalMissionOrchestratorRuntime(
  runtime: ResolvedMissionOrchestratorRuntime,
): MissionOrchestratorRuntimeSnapshot {
  if (runtime.readOnly !== false || runtime.nativeReadOnly !== true) {
    throw new Error(
      'O runtime do orquestrador exige Nexus MCP delegável e confinamento ' +
        'nativo read-only explícito.',
    );
  }
  return missionOrchestratorRuntimeSnapshotSchema.parse({
    adapterId: present(runtime.adapterId),
    ...(present(runtime.model) ? { model: present(runtime.model) } : {}),
    ...(present(runtime.accountId)
      ? { accountId: present(runtime.accountId) }
      : {}),
    ...(present(runtime.effort) ? { effort: present(runtime.effort) } : {}),
    readOnly: false,
    nativeReadOnly: true,
  });
}

export function sameMissionOrchestratorRuntime(
  left: MissionOrchestratorRuntimeSnapshot | null | undefined,
  right: MissionOrchestratorRuntimeSnapshot | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.adapterId === right.adapterId &&
      left.model === right.model &&
      left.accountId === right.accountId &&
      left.effort === right.effort &&
      left.readOnly === right.readOnly &&
      left.nativeReadOnly === right.nativeReadOnly,
  );
}

export function missionOrchestratorRuntimeReviewStrings(
  runtime: MissionOrchestratorRuntimeSnapshot,
  evidence = missionOrchestratorEvidence(runtime.adapterId),
): string[] {
  return [
    runtime.adapterId,
    runtime.model ?? '',
    runtime.accountId ?? '',
    runtime.effort ?? '',
    `readOnly=${String(runtime.readOnly)}`,
    `nativeReadOnly=${String(runtime.nativeReadOnly)}`,
    `orchestrationEvidence=${evidence}`,
  ];
}

/** Main-owned evidence lookup. Renderer acknowledgement is never consulted. */
export function missionOrchestratorEvidence(
  adapterId: string,
): OrchestrationEvidence {
  const adapter = listAdapterInfos().find((candidate) => candidate.id === adapterId);
  return adapter ? orchestrationEvidenceOf(adapter) : 'unsupported';
}

export function assertMissionOrchestratorEvidence(input: {
  evidence: OrchestrationEvidence;
  selection: 'saved-roster' | 'automatic';
  label: string;
}): void {
  if (input.evidence === 'unsupported') {
    throw new Error(
      `${input.label} não tem evidência válida para a rota de orquestração.`,
    );
  }
  if (input.selection === 'automatic' && input.evidence !== 'verified') {
    throw new Error(
      `${input.label} tem orquestração experimental e não pode ser ` +
        'promovido automaticamente a Maestro. Escolha um provider verificado.',
    );
  }
}

export function resolveProductionMissionOrchestratorRuntime(
  _squad: Squad,
  orchestrator: SquadAgent,
): MissionOrchestratorRuntimeSnapshot {
  const settings = getOrchSettings();
  // The approved saved roster owns the route. A profile default is only a
  // fallback for legacy roster entries that omitted their CLI.
  const adapterId = preferredMissionOrchestratorAdapterId(
    orchestrator,
    settings.defaultAdapterId,
  );
  const adapter = getAdapter(adapterId);
  if (!adapter) {
    throw new Error(
      `Provider do orquestrador \`${adapterId}\` não foi carregado. ` +
        'Escolha outro em Configurações › Providers.',
    );
  }
  if (adapter.kind !== 'cli-pty') {
    throw new Error(
      `${adapter.label} não oferece confinamento nativo read-only em PTY ` +
        'para o orquestrador inicial.',
    );
  }
  if (!hasNexusMcpCapability(adapter.quirks)) {
    throw new Error(
      `${adapter.label} não declara uma rota Nexus MCP de orquestrador.`,
    );
  }
  if (!supportsEnforceableReadOnlyNativeAuthority(adapter)) {
    throw new Error(
      `${adapter.label} não declara confinamento nativo read-only ` +
        'aplicável ao orquestrador.',
    );
  }
  const evidence = missionOrchestratorEvidence(adapterId);
  const runtimeComesFromRoster = present(orchestrator.cli) === adapterId;
  assertMissionOrchestratorEvidence({
    evidence,
    selection: runtimeComesFromRoster ? 'saved-roster' : 'automatic',
    label: adapter.label,
  });

  const accounts = listAccountInfos().filter(
    (account) => account.adapterId === adapterId,
  );
  const account =
    accounts.find(
      (candidate) =>
        candidate.id === settings.defaultAccountId &&
        candidate.hasCredential &&
        !candidate.onCooldown,
    ) ??
    accounts.find(
      (candidate) =>
        candidate.active && candidate.hasCredential && !candidate.onCooldown,
    ) ??
    accounts.find(
      (candidate) => candidate.hasCredential && !candidate.onCooldown,
    );
  if (accounts.length > 0 && !account) {
    throw new Error(
      'Nenhuma conta do orquestrador tem credencial válida fora de cooldown.',
    );
  }

  return canonicalMissionOrchestratorRuntime({
    adapterId,
    model:
      (runtimeComesFromRoster ? orchestrator.model : undefined) ||
      settings.defaultModel ||
      defaultSquadModelForAdapter(adapterId),
    accountId: account?.id,
    effort: runtimeComesFromRoster ? orchestrator.effort : undefined,
    readOnly: false,
    nativeReadOnly: true,
  });
}

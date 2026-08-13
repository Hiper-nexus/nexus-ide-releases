import {
  adapterCapabilityMatrixOf,
  hasNexusMcpCapability,
  orchestrationEvidenceOf,
  type OrchestrationEvidence,
} from '../../shared/adapter-types';
import {
  missionOrchestratorRuntimeSnapshotSchema,
  type MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  isRetiredAdapterId,
  RetiredRosterRouteError,
} from '../../shared/retired-adapter-policy';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { defaultSquadModelForAdapter } from '../../shared/squad-model-defaults';
import {
  getAdapter,
  listAdapterInfos,
} from '../adapters/adapter-registry';
import { listAccountInfos } from '../persistence/account-store';
import {
  isProviderEnabled,
  providerReadiness,
  type ProviderReadiness,
} from '../persistence/provider-config-store';
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

interface MissionOrchestratorSettings {
  readonly squadCliPolicy: string;
  readonly defaultAdapterId: string;
  readonly defaultModel: string;
  readonly defaultAccountId: string;
}

export interface MissionOrchestratorRuntimeDeps {
  readonly getSettings: () => MissionOrchestratorSettings;
  readonly getAdapter: typeof getAdapter;
  readonly listAdapterInfos: typeof listAdapterInfos;
  readonly listAccountInfos: typeof listAccountInfos;
  readonly isProviderEnabled: typeof isProviderEnabled;
  readonly providerReadiness: (
    adapterId: string,
    selectedModel?: string,
  ) => ProviderReadiness;
}

const productionRuntimeDeps: MissionOrchestratorRuntimeDeps = {
  getSettings: getOrchSettings,
  getAdapter,
  listAdapterInfos,
  listAccountInfos,
  isProviderEnabled,
  providerReadiness,
};

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
 * persist. The native-confinement bit is retained rather than inferred: false
 * is the explicit Autopilot contract, true is Hardened.
 */
export function canonicalMissionOrchestratorRuntime(
  runtime: ResolvedMissionOrchestratorRuntime,
): MissionOrchestratorRuntimeSnapshot {
  if (runtime.readOnly !== false) {
    throw new Error(
      'O runtime do orquestrador exige autoridade Main-owned delegável; ' +
        'readOnly=true removeria a superfície necessária da missão.',
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
    nativeReadOnly: runtime.nativeReadOnly,
  });
}

/**
 * Igualdade de AUTORIDADE concedida pela aprovação (fix 06/08 do re-prompt
 * residual): adapter, modelo e confinamento definem o que o operador aprovou;
 * accountId e effort são política main-owned recomputada a cada tentativa
 * (rotação de conta, tuning) — a igualdade estrita fazia o modal de aprovação
 * voltar PARA SEMPRE numa missão viva cujo candidato fresco divergia do
 * contrato selado nesses campos voláteis.
 */
export function sameMissionOrchestratorGrantRuntime(
  left: MissionOrchestratorRuntimeSnapshot | null | undefined,
  right: MissionOrchestratorRuntimeSnapshot | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.adapterId === right.adapterId &&
      left.model === right.model &&
      left.readOnly === right.readOnly &&
      left.nativeReadOnly === right.nativeReadOnly,
  );
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
  deps: MissionOrchestratorRuntimeDeps = productionRuntimeDeps,
  options: { readonly requireProviderReadiness?: boolean } = {},
): MissionOrchestratorRuntimeSnapshot {
  const requireProviderReadiness =
    options.requireProviderReadiness !== false;
  const settings = deps.getSettings();
  const operatorChoice = isOperatorChoicePolicy(settings.squadCliPolicy);
  // The approved saved roster owns the route. A profile default is only a
  // fallback for legacy roster entries that omitted their CLI.
  const adapterId = preferredMissionOrchestratorAdapterId(
    orchestrator,
    settings.defaultAdapterId,
  );
  if (isRetiredAdapterId(adapterId)) {
    throw new RetiredRosterRouteError(
      adapterId,
      `${orchestrator.id}/${orchestrator.agentName}`,
    );
  }
  const adapter = deps.getAdapter(adapterId);
  if (!adapter) {
    throw new Error(
      `Provider do orquestrador \`${adapterId}\` não foi carregado. ` +
        'Escolha outro em Configurações › Providers.',
    );
  }
  if (adapter.kind !== 'cli-pty') {
    throw new Error(
      `${adapter.label} não oferece uma rota PTY para o orquestrador inicial.`,
    );
  }
  const runtimeComesFromRoster = present(orchestrator.cli) === adapterId;
  const adapterInfo = deps
    .listAdapterInfos()
    .find((candidate) => candidate.id === adapterId);
  if (!adapterInfo?.installed) {
    throw new Error(
      `${adapter.label} não está instalada ou o binário não está executável.`,
    );
  }
  if (operatorChoice) {
    const capabilities = adapterCapabilityMatrixOf(adapterInfo);
    if (
      adapterInfo.missionControlCapable !== true ||
      !capabilities.launchable ||
      !capabilities.promptInjectable ||
      !capabilities.statusObservable
    ) {
      throw new Error(
        `${adapter.label} não oferece um canal Main-owned de controle PTY ` +
          'e conclusão necessário para o Autopiloto.',
      );
    }
  } else {
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
    assertMissionOrchestratorEvidence({
      evidence: adapterInfo.orchestrationEvidence ?? 'unsupported',
      selection: runtimeComesFromRoster ? 'saved-roster' : 'automatic',
      label: adapter.label,
    });
  }

  const accounts = deps.listAccountInfos().filter(
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
  if (!deps.isProviderEnabled(adapterId)) {
    throw new Error(
      `${adapter.label} está desativado em Configurações › Providers.`,
    );
  }
  if (
    requireProviderReadiness &&
    accounts.length > 0 &&
    !account &&
    !operatorChoice
  ) {
    throw new Error(
      'Nenhuma conta do orquestrador tem credencial válida fora de cooldown.',
    );
  }
  const sealedModel = runtimeComesFromRoster
    ? present(orchestrator.model)
    : undefined;
  const model =
    sealedModel ||
    present(settings.defaultModel) ||
    defaultSquadModelForAdapter(adapterId);
  if (requireProviderReadiness && !account) {
    const readiness = deps.providerReadiness(adapterId, model);
    if (!readiness.ready) throw new Error(readiness.reason);
  }

  return canonicalMissionOrchestratorRuntime({
    adapterId,
    model,
    accountId: account?.id,
    effort: runtimeComesFromRoster ? orchestrator.effort : undefined,
    readOnly: false,
    nativeReadOnly: !operatorChoice,
  });
}

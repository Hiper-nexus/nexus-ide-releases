import type { AccountInfo } from "../../shared/account-types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { AdapterInfo } from "../../shared/types";
import { orchestrationEvidenceOf } from "../../shared/adapter-types";
import type { SquadCliPolicy } from "../../shared/settings-types";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";

export interface MissionRuntimeReadiness {
  readonly detectedAdapters: readonly AdapterInfo[];
  readonly authenticatedAdapters: readonly AdapterInfo[];
  /** All installed+authenticated providers (every CLI, not a top-N sample). */
  readonly readyProviders: readonly AdapterInfo[];
  readonly verifiedMaestros: readonly AdapterInfo[];
  readonly qualifiedWorkers: readonly AdapterInfo[];
  readonly hasOperationalRoute: boolean;
  /** True when 2+ providers are ready — multi-LLM economics in play. */
  readonly multiProviderReady: boolean;
}

function providerFor(
  adapterId: string,
  providers: readonly ProviderSettingsInfo[],
): ProviderSettingsInfo | null {
  return providers.find((provider) => provider.adapterId === adapterId) ?? null;
}

function hasAvailableManagedAccount(
  adapterId: string,
  accounts: readonly AccountInfo[],
  preferredAccountId?: string | null,
): boolean {
  const candidates = accounts.filter(
    (account) =>
      account.adapterId === adapterId &&
      account.hasCredential &&
      !account.onCooldown,
  );
  if (preferredAccountId?.trim()) {
    const preferred = candidates.find(
      (account) => account.id === preferredAccountId,
    );
    if (preferred) return true;
  }
  // Main uses the preferred account first, then the active account, then any
  // usable managed account. Renderer readiness mirrors that fallback order
  // without ever receiving credential material.
  return candidates.some((account) => account.active) || candidates.length > 0;
}

/**
 * Secret-free renderer check for the exact model/provider snapshot produced by
 * main. Process creation still performs the authoritative uncached check.
 */
export function isAdapterModelAuthenticated(
  adapter: AdapterInfo,
  providers: readonly ProviderSettingsInfo[],
  selectedModel?: string | null,
  accounts: readonly AccountInfo[] = [],
  preferredAccountId?: string | null,
): boolean {
  const provider = providerFor(adapter.id, providers);
  if (
    !adapter.installed ||
    !provider ||
    !provider.enabled ||
    !provider.installed
  ) {
    return false;
  }
  const model =
    selectedModel?.trim() ||
    provider.defaultModel.trim() ||
    adapter.models.default.trim();
  if (!model || !provider.models.includes(model)) return false;
  const managedAccountReady = hasAvailableManagedAccount(
    adapter.id,
    accounts,
    preferredAccountId,
  );
  // Uma CLI que autentica pela PRÓPRIA assinatura (Claude Code, Codex…) não
  // deposita chave nem conta no Nexus: exigir o modelo em `authReadyModels`
  // reprovava um coordenador que funciona de verdade e travava a missão em
  // "a ferramenta escolhida não está pronta" — com o binário logado e
  // respondendo. Instalada + estratégia de assinatura basta aqui; a fronteira
  // de spawn continua fail-closed e é ela quem tem a palavra final.
  const authenticatesItself =
    provider.authStrategy === 'subscription' ||
    provider.authStrategy === 'credentialless';
  if (Array.isArray(provider.authReadyModels)) {
    // Lista declarada é autoritativa: granularidade por modelo é intencional.
    // Lista VAZIA não é "nada autorizado" — é ausência de informação, e é
    // exatamente o que uma CLI de assinatura própria produz.
    if (provider.authReadyModels.length > 0) {
      return provider.authReadyModels.includes(model) || managedAccountReady;
    }
    return managedAccountReady || authenticatesItself;
  }
  // Rolling compatibility for an older main snapshot. The final spawn
  // boundary remains authoritative and fail-closed.
  return provider.authStrategy !== "login-needed" || managedAccountReady;
}

export function missionRuntimeReadiness(
  adapters: readonly AdapterInfo[],
  providers: readonly ProviderSettingsInfo[],
  accounts: readonly AccountInfo[] = [],
  squadCliPolicy: SquadCliPolicy = "operator-choice",
): MissionRuntimeReadiness {
  const detectedAdapters = adapters.filter((adapter) => adapter.installed);
  const authenticatedAdapters = detectedAdapters.filter((adapter) =>
    isAdapterModelAuthenticated(adapter, providers, undefined, accounts),
  );
  const operatorChoice = isOperatorChoicePolicy(squadCliPolicy);
  const verifiedMaestros = authenticatedAdapters.filter((adapter) =>
    operatorChoice
      ? adapter.kind === "cli-pty" && adapter.missionControlCapable === true
      : adapter.kind === "cli-pty" &&
        adapter.orchestratorCapable &&
        orchestrationEvidenceOf(adapter) === "verified",
  );
  const qualifiedWorkers = authenticatedAdapters.filter((adapter) =>
    operatorChoice
      ? adapter.kind === "cli-pty" && adapter.taskHandoffCapable === true
      : adapter.id !== "claude" &&
        adapter.kind === "cli-pty" &&
        adapter.autonomousWorkspaceWriteCapable === true,
  );
  const readyProviders = authenticatedAdapters;
  return Object.freeze({
    detectedAdapters: Object.freeze(detectedAdapters),
    authenticatedAdapters: Object.freeze(authenticatedAdapters),
    readyProviders: Object.freeze(readyProviders),
    verifiedMaestros: Object.freeze(verifiedMaestros),
    qualifiedWorkers: Object.freeze(qualifiedWorkers),
    hasOperationalRoute:
      verifiedMaestros.length > 0 && qualifiedWorkers.length > 0,
    multiProviderReady: readyProviders.length >= 2,
  });
}

/** Compact label list for UI: "claude, codex, grok" (all, not capped). */
export function formatReadyProviderIds(
  readiness: Pick<MissionRuntimeReadiness, "readyProviders">,
): string {
  return readiness.readyProviders.map((adapter) => adapter.id).join(", ");
}

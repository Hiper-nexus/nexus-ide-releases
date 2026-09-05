import type { AccountInfo } from "../../shared/account-types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { AdapterInfo } from "../../shared/types";
import type { SquadCliPolicy } from "../../shared/settings-types";

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

/**
 * Doutrina fluxo-por-padrão: CLI instalada e não desligada pelo operador é
 * utilizável. Autenticação NÃO é pré-condição de missão — é conversa entre o
 * operador e a própria CLI, dentro do terminal dela (se faltar login, o
 * prompt de login aparece no pane, como em qualquer terminal). Provar auth
 * antes de abrir o terminal foi o que manteve missões reais paradas no passo
 * Equipe com o binário logado e respondendo.
 */
export function isAdapterModelAuthenticated(
  adapter: AdapterInfo,
  providers: readonly ProviderSettingsInfo[],
  _selectedModel?: string | null,
  _accounts: readonly AccountInfo[] = [],
  _preferredAccountId?: string | null,
): boolean {
  const provider = providerFor(adapter.id, providers);
  if (!adapter.installed) return false;
  // `enabled === false` é escolha explícita do operador nas configurações —
  // única recusa que sobra. Provider ausente no snapshot não reprova.
  return provider === null || provider.enabled !== false;
}

/**
 * CLIs instaladas continuam disponíveis para execução e escolha manual.
 * Coordenação exige a capacidade de MCP publicada pelo Main, que aplica o
 * mesmo requisito físico no início da missão.
 */
export function missionRuntimeReadiness(
  adapters: readonly AdapterInfo[],
  providers: readonly ProviderSettingsInfo[],
  accounts: readonly AccountInfo[] = [],
  _squadCliPolicy: SquadCliPolicy = "operator-choice",
): MissionRuntimeReadiness {
  const detectedAdapters = adapters.filter((adapter) => adapter.installed);
  const authenticatedAdapters = detectedAdapters.filter((adapter) =>
    isAdapterModelAuthenticated(adapter, providers, undefined, accounts),
  );
  const cliAdapters = authenticatedAdapters.filter(
    (adapter) => adapter.kind === "cli-pty",
  );
  const verifiedMaestros = cliAdapters.filter(
    (adapter) => adapter.missionControlCapable === true,
  );
  const qualifiedWorkers = cliAdapters;
  const readyProviders = authenticatedAdapters;
  return Object.freeze({
    detectedAdapters: Object.freeze(detectedAdapters),
    authenticatedAdapters: Object.freeze(authenticatedAdapters),
    readyProviders: Object.freeze(readyProviders),
    verifiedMaestros: Object.freeze(verifiedMaestros),
    qualifiedWorkers: Object.freeze(qualifiedWorkers),
    hasOperationalRoute: verifiedMaestros.length > 0,
    multiProviderReady: readyProviders.length >= 2,
  });
}

/** Compact label list for UI: "claude, codex, grok" (all, not capped). */
export function formatReadyProviderIds(
  readiness: Pick<MissionRuntimeReadiness, "readyProviders">,
): string {
  return readiness.readyProviders.map((adapter) => adapter.id).join(", ");
}

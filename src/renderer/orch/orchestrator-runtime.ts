import type { AccountInfo } from '../../shared/account-types';
import type { AdapterInfo } from '../../shared/types';
import {
  adapterCapabilityMatrixOf,
  orchestrationEvidenceOf,
} from '../../shared/adapter-types';
import type { SquadCliPolicy } from '../../shared/settings-types';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { defaultSquadModelForAdapter } from '../../shared/squad-model-defaults';

/** A declared route is compatibility metadata, not proof of orchestration. */
export function hasDeclaredOrchestratorMcpRoute(adapter: AdapterInfo): boolean {
  return adapter.kind === 'cli-pty' && adapter.orchestratorCapable;
}

/** Installed adapters shown in the explicit provider picker. */
export function isDeclaredOrchestratorAdapter(adapter: AdapterInfo): boolean {
  return adapter.installed && hasDeclaredOrchestratorMcpRoute(adapter);
}

/** Adapters eligible for automatic Maestro selection. */
export function isVerifiedOrchestratorAdapter(adapter: AdapterInfo): boolean {
  return (
    isDeclaredOrchestratorAdapter(adapter) &&
    orchestrationEvidenceOf(adapter) === 'verified'
  );
}

/**
 * Pode ser o Maestro escolhido nesta política: o mesmo requisito que o Main
 * confere no prepare (`mission-orchestrator-runtime`). Em Autopilot basta a
 * CLI instalada coordenar missão; só o Hardened exige o gate de Maestro
 * verificado. O Piloto automático usava o gate do Hardened em qualquer
 * política e só oferecia Claude e Codex (F-1575).
 */
export function isSelectableOrchestratorAdapter(
  adapter: AdapterInfo,
  squadCliPolicy: SquadCliPolicy = 'operator-choice',
): boolean {
  if (!adapter.installed) return false;
  if (!isOperatorChoicePolicy(squadCliPolicy)) {
    return isVerifiedOrchestratorAdapter(adapter);
  }
  const capabilities = adapterCapabilityMatrixOf(adapter);
  return (
    adapter.kind === 'cli-pty' &&
    adapter.missionControlCapable === true &&
    capabilities.launchable &&
    capabilities.promptInjectable &&
    capabilities.statusObservable
  );
}

/**
 * Automatic routing never falls through to adapters[0]. A configured
 * experimental route is skipped in favor of a verified provider; null means
 * the operator must make an explicit choice in review.
 */
export function automaticOrchestratorAdapterId(
  adapters: readonly (AdapterInfo & { enabled?: boolean })[],
  configuredAdapterId: string,
  squadCliPolicy: SquadCliPolicy = 'operator-choice',
  authenticatedAdapterIds?: ReadonlySet<string>,
): string | null {
  const isEligible = (
    adapter: AdapterInfo & { enabled?: boolean },
  ): boolean =>
    adapter.enabled !== false &&
    (!authenticatedAdapterIds || authenticatedAdapterIds.has(adapter.id)) &&
    isSelectableOrchestratorAdapter(adapter, squadCliPolicy);
  const configured = adapters.find(
    (adapter) => adapter.id === configuredAdapterId,
  );
  if (configured && isEligible(configured)) {
    return configured.id;
  }
  return (
    adapters.find((adapter) => isEligible(adapter))?.id ?? null
  );
}

/** @deprecated Prefer the evidence-specific helpers above. */
export const hasOrchestratorMcpRoute = hasDeclaredOrchestratorMcpRoute;
/** @deprecated Prefer isDeclaredOrchestratorAdapter or isVerifiedOrchestratorAdapter. */
export const isOrchestratorCapableAdapter = isDeclaredOrchestratorAdapter;

interface OrchestratorRuntimeInput {
  adapterId: string;
  squadModel?: string;
  defaultModel: string;
  defaultAccountId: string;
  accounts: readonly AccountInfo[];
}

export interface OrchestratorRuntimeSelection {
  model: string | undefined;
  accountId: string | undefined;
}

export function resolveOrchestratorRuntime(
  input: OrchestratorRuntimeInput,
): OrchestratorRuntimeSelection {
  const selectedAccount = input.accounts.find(
    (account) =>
      account.id === input.defaultAccountId &&
      account.adapterId === input.adapterId &&
      account.hasCredential &&
      !account.onCooldown &&
      // Morta não fixa: undefined devolve a decisão ao spawn (conta ativa),
      // e o prepare veta com motivo acionável em vez de 401 mudo.
      !account.needsRelogin,
  );
  return {
    model:
      input.squadModel ||
      input.defaultModel ||
      defaultSquadModelForAdapter(input.adapterId),
    accountId: selectedAccount?.id,
  };
}

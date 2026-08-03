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
  const operatorChoice = isOperatorChoicePolicy(squadCliPolicy);
  const isEligible = (
    adapter: AdapterInfo & { enabled?: boolean },
  ): boolean => {
    if (
      adapter.enabled === false ||
      !adapter.installed ||
      (authenticatedAdapterIds &&
        !authenticatedAdapterIds.has(adapter.id))
    ) {
      return false;
    }
    if (!operatorChoice) return isVerifiedOrchestratorAdapter(adapter);
    const capabilities = adapterCapabilityMatrixOf(adapter);
    return (
      adapter.kind === 'cli-pty' &&
      adapter.missionControlCapable === true &&
      capabilities.launchable &&
      capabilities.promptInjectable &&
      capabilities.statusObservable
    );
  };
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
      !account.onCooldown,
  );
  return {
    model:
      input.squadModel ||
      input.defaultModel ||
      defaultSquadModelForAdapter(input.adapterId),
    accountId: selectedAccount?.id,
  };
}

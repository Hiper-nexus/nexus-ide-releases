import type { AccountInfo } from '../../shared/account-types';
import type { AdapterInfo } from '../../shared/types';
import { defaultSquadModelForAdapter } from '../../shared/squad-model-defaults';

/** The adapter registry derives this capability from its validated MCP metadata. */
export function hasOrchestratorMcpRoute(adapter: AdapterInfo): boolean {
  return adapter.kind === 'cli-pty' && adapter.orchestratorCapable;
}

export function isOrchestratorCapableAdapter(adapter: AdapterInfo): boolean {
  return adapter.installed && hasOrchestratorMcpRoute(adapter);
}

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

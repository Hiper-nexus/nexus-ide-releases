import { MANAGED_CLAUDE_CREDENTIAL_CHANGED_ERROR } from '../adapters/managed-claude-auth';

/**
 * F-1401: com vários panes Claude na mesma conta, um pane irmão pode renovar
 * o access token entre o `verifyManagedClaudeAccountForSpawn` e o
 * `prepareAccountForSpawn` — o materialize recusa porque o blob materializado
 * já não é o verificado. A rotação já foi gravada pelo autor: basta revalidar
 * o perfil (que relê a credencial mais fresca) e refazer o prepare. Backoff
 * curto e limitado a este erro específico — qualquer outro falha na hora.
 */
const CLAUDE_CREDENTIAL_RETRY_DELAYS_MS = [150, 400] as const;

export function isManagedClaudeCredentialChangedError(
  error: string | undefined,
): boolean {
  return (
    typeof error === 'string' &&
    error.includes(MANAGED_CLAUDE_CREDENTIAL_CHANGED_ERROR)
  );
}

/**
 * Roda `attempt` (verify + prepare, para que cada tentativa revalide o perfil)
 * e repete somente quando o resultado é o erro de credencial girada.
 */
export async function retryClaudeSpawnOnCredentialChange<
  T extends { ok: boolean; error?: string },
>(attempt: () => T | Promise<T>): Promise<T> {
  let result = await attempt();
  for (const delayMs of CLAUDE_CREDENTIAL_RETRY_DELAYS_MS) {
    if (result.ok || !isManagedClaudeCredentialChangedError(result.error)) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    result = await attempt();
  }
  return result;
}

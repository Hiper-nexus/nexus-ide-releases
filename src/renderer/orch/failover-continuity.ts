/**
 * Pure continuity pack for multi-account failover (F-775).
 * Cross-account resume cannot reuse provider session ids (account-owned),
 * so we rehydrate mission intent as a fresh CLI prompt.
 *
 * O builder vive em `shared/failover-handoff.ts` (main + renderer precisam do
 * mesmo texto, com as mesmas máscaras anti-detector). Este módulo é a porta de
 * entrada do renderer e mantém o prompt leve de recuperação same-account.
 */

export {
  buildContinuityPack,
  stripNestedHandoffPacks,
  MAX_CONTINUITY_PACK_CHARS,
  type ContinuityPackInput,
} from '../../shared/failover-handoff';

/** Same-account recovery (stall) keeps a lighter continue prompt. */
export function buildSameAccountContinuePrompt(role?: string): string {
  const r = role === 'orchestrator' ? 'orchestrator' : 'agent';
  return (
    `Continue the current mission from exactly where you stopped as the ${r}. ` +
    'Preserve existing context and execute the next pending step now.'
  );
}

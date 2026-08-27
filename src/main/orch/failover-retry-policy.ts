import type { FailoverReasonKind } from '../../shared/account-types';

/**
 * When no replacement account is spawnable, decide whether (and when) to
 * retry. Rate-limit/quota wait for the sooner of own cooldown vs a sibling.
 * Auth must NOT retry the same dead credential — that produced the field
 * loop "Sessão recuperada automaticamente" → 401 → continue injected into
 * /login. Auth only waits for a sibling that will actually unblock.
 */
export function retryTargetMsForLimit(input: {
  readonly kind: FailoverReasonKind;
  readonly ownUnblockAtMs?: number;
  readonly nextUnblockAtMs?: number;
}): number | undefined {
  const sibling = input.nextUnblockAtMs;
  if (input.kind === 'auth') {
    return Number.isFinite(sibling) ? sibling : undefined;
  }
  const target = Math.min(
    input.ownUnblockAtMs ?? Number.POSITIVE_INFINITY,
    sibling ?? Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(target) ? target : undefined;
}

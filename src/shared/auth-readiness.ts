/**
 * Five-state auth readiness for auto-seat / first-wave.
 *
 * Only `present` is a live seat. The other four remint silently.
 */

export const AUTH_READINESS = [
  'present',
  'incomplete',
  'missing',
  'unreadable',
  'no-credential',
] as const;

export type AuthReadiness = (typeof AUTH_READINESS)[number];

export function isLiveSeat(
  readiness: AuthReadiness | null | undefined,
): boolean {
  return readiness === 'present';
}

export function autoSeatReadiness(provider: {
  readonly readiness?: AuthReadiness;
  readonly authStrategy?: string | null;
  readonly hasKey?: boolean;
}): AuthReadiness {
  if (provider.readiness) return provider.readiness;
  const strategy = (provider.authStrategy ?? '').trim().toLowerCase();
  if (
    strategy === 'subscription' ||
    strategy === 'credentialless' ||
    strategy === 'oauth'
  ) {
    return 'present';
  }
  if (strategy === 'api-key') {
    return provider.hasKey === true ? 'present' : 'no-credential';
  }
  return 'no-credential';
}

// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure allowlist filter
// without ssh2 Agent class (no agent-force; keys selected by fingerprint only).

/**
 * Filter SSH agent identity fingerprints to an explicit allowlist.
 * Callers supply fingerprints already derived from IdentityFile keys —
 * this module never invokes agent signing APIs itself.
 */

const WILDCARD = '*';

/** Normalize only the `SHA256:` prefix and surrounding whitespace. */
function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().replace(/^SHA256:/i, '');
}

/** True when the allowlist opts into offering every available identity. */
export function identityAllowlistIsWildcard(allowed: readonly string[]): boolean {
  return allowed.some((f) => f.trim() === WILDCARD);
}

export function filterAllowedIdentityFingerprints(
  available: readonly string[],
  allowed: readonly string[],
): string[] {
  // Wildcard = explicit "offer all identities". NOTE: this is intentionally a
  // fail-OPEN case — only pass `['*']` when offering every agent identity is
  // acceptable. A specific fingerprint list below is the fail-closed default.
  if (identityAllowlistIsWildcard(allowed)) return [...available];
  // SHA-256 fingerprints are case-sensitive base64 — compare exactly (H3/L17).
  const allow = new Set(allowed.map(normalizeFingerprint));
  return available.filter((f) => allow.has(normalizeFingerprint(f)));
}

/** Reject empty agent usage when policy requires a pin. */
export function assertIdentityAllowlistNonEmpty(
  allowed: readonly string[],
): void {
  if (allowed.length === 0) {
    throw new Error('ssh-identity-filter: empty identity allowlist (fail closed)');
  }
}

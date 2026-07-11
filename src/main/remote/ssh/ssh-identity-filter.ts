// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure allowlist filter
// without ssh2 Agent class (no agent-force; keys selected by fingerprint only).

/**
 * Filter SSH agent identity fingerprints to an explicit allowlist.
 * Callers supply fingerprints already derived from IdentityFile keys —
 * this module never invokes agent signing APIs itself.
 */
export function filterAllowedIdentityFingerprints(
  available: readonly string[],
  allowed: readonly string[],
): string[] {
  const allow = new Set(allowed.map((f) => f.toLowerCase()));
  return available.filter((f) => allow.has(f.toLowerCase()));
}

/** Reject empty or wildcard-all agent usage when policy requires pin. */
export function assertIdentityAllowlistNonEmpty(
  allowed: readonly string[],
): void {
  if (allowed.length === 0) {
    throw new Error('ssh-identity-filter: empty identity allowlist (fail closed)');
  }
}

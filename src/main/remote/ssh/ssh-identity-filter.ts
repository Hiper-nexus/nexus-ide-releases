// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure allowlist filter
// plus an ssh2 BaseAgent wrapper selected by fingerprint (no agent forwarding).

import { createHash } from 'node:crypto';

/**
 * Filter SSH agent identity fingerprints to an explicit allowlist.
 * Callers supply fingerprints already derived from public-key blobs. The
 * runtime wrapper below keeps both identity listing and signing inside that
 * same allowlist.
 */

const WILDCARD = '*';
const SHA256_BODY_RE = /^[A-Za-z0-9+/]{43}$/u;

export type SshAgentCallback<T> = (
  error?: Error | null,
  value?: T,
) => void;

export type SshAgentLike = {
  getIdentities(callback: SshAgentCallback<unknown[]>): void;
  sign(
    publicKey: unknown,
    data: Buffer,
    optionsOrCallback?: Record<string, unknown> | SshAgentCallback<Buffer>,
    callback?: SshAgentCallback<Buffer>,
  ): void;
};

export type Ssh2AgentRuntime = {
  BaseAgent: new () => SshAgentLike;
  createAgent(socketPath: string): SshAgentLike;
  utils: {
    parseKey(value: unknown): unknown;
  };
};

type ParsedPublicKey = {
  getPublicSSH(): Buffer;
};

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

/**
 * Build a custom ssh2 BaseAgent that exposes and signs only identities whose
 * OpenSSH SHA256 fingerprint is explicitly pinned.
 *
 * Adapted from Orca's IdentityFilteredAgent. Nexus additionally checks the
 * fingerprint again on sign, so a caller cannot bypass getIdentities and ask
 * the backing SSH agent to sign with another loaded key. getStream is
 * intentionally not forwarded: agent forwarding would bypass this filter.
 */
export function createIdentityFilteredAgent(
  socketPath: string,
  allowedFingerprints: readonly string[],
  runtime: Ssh2AgentRuntime,
): SshAgentLike {
  const allowed = strictAllowedFingerprintSet(allowedFingerprints);
  if (!socketPath.trim()) {
    throw new Error('ssh-identity-filter: SSH_AUTH_SOCK is unavailable (fail closed)');
  }

  const backingAgent = runtime.createAgent(socketPath);
  const BaseAgent = runtime.BaseAgent;

  class IdentityFilteredAgent extends BaseAgent {
    override getIdentities(callback: SshAgentCallback<unknown[]>): void {
      backingAgent.getIdentities((error, identities) => {
        if (error) {
          callback(error);
          return;
        }
        const filtered = (identities ?? []).filter((identity) => {
          const keyFingerprint = fingerprintForPublicKey(identity, runtime);
          return keyFingerprint !== null && allowed.has(keyFingerprint);
        });
        callback(undefined, filtered);
      });
    }

    override sign(
      publicKey: unknown,
      data: Buffer,
      optionsOrCallback?: Record<string, unknown> | SshAgentCallback<Buffer>,
      callback?: SshAgentCallback<Buffer>,
    ): void {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : callback;
      if (!done) {
        throw new Error('ssh-identity-filter: missing sign callback');
      }

      const keyFingerprint = fingerprintForPublicKey(publicKey, runtime);
      if (keyFingerprint === null || !allowed.has(keyFingerprint)) {
        done(new Error('ssh-identity-filter: signing key is not allowlisted'));
        return;
      }

      if (typeof optionsOrCallback === 'function') {
        backingAgent.sign(publicKey, data, optionsOrCallback);
        return;
      }
      backingAgent.sign(publicKey, data, optionsOrCallback ?? {}, callback);
    }
  }

  return new IdentityFilteredAgent();
}

function strictAllowedFingerprintSet(
  allowedFingerprints: readonly string[],
): ReadonlySet<string> {
  assertIdentityAllowlistNonEmpty(allowedFingerprints);
  if (identityAllowlistIsWildcard(allowedFingerprints)) {
    throw new Error('ssh-identity-filter: wildcard identity allowlist rejected (fail closed)');
  }

  const normalized = new Set<string>();
  for (const fingerprint of allowedFingerprints) {
    normalized.add(normalizeStrictFingerprint(fingerprint));
  }
  return normalized;
}

function normalizeStrictFingerprint(fingerprint: string): string {
  const body = normalizeFingerprint(fingerprint);
  if (!SHA256_BODY_RE.test(body)) {
    throw new Error('ssh-identity-filter: malformed identity fingerprint (fail closed)');
  }

  const decoded = Buffer.from(`${body}=`, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/u, '');
  if (decoded.length !== 32 || canonical !== body) {
    throw new Error('ssh-identity-filter: malformed identity fingerprint (fail closed)');
  }
  return `SHA256:${body}`;
}

function fingerprintForPublicKey(
  identity: unknown,
  runtime: Ssh2AgentRuntime,
): string | null {
  const publicBlob = publicBlobForKey(identity, runtime);
  if (!publicBlob) return null;
  const digest = createHash('sha256')
    .update(publicBlob)
    .digest('base64')
    .replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

function publicBlobForKey(
  identity: unknown,
  runtime: Ssh2AgentRuntime,
): Buffer | null {
  try {
    const comparable = unwrapPublicKeyEntry(identity);
    const parsed = isParsedPublicKey(comparable)
      ? comparable
      : runtime.utils.parseKey(comparable);
    if (parsed instanceof Error || Array.isArray(parsed) || !isParsedPublicKey(parsed)) {
      return null;
    }
    const publicBlob = parsed.getPublicSSH();
    return Buffer.isBuffer(publicBlob) && publicBlob.length > 0
      ? publicBlob
      : null;
  } catch {
    return null;
  }
}

function unwrapPublicKeyEntry(identity: unknown): unknown {
  let value = identity;
  for (let depth = 0; depth < 2; depth += 1) {
    if (
      typeof value !== 'object'
      || value === null
      || !('pubKey' in value)
    ) {
      break;
    }
    const nested = (value as { pubKey?: unknown }).pubKey;
    if (nested === value || nested === undefined) break;
    value = nested;
  }
  return value;
}

function isParsedPublicKey(value: unknown): value is ParsedPublicKey {
  return (
    typeof value === 'object'
    && value !== null
    && 'getPublicSSH' in value
    && typeof (value as { getPublicSSH?: unknown }).getPublicSSH === 'function'
  );
}

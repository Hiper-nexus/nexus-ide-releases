// Nexus forge token resolution (Gap C).
// Tokens come from an injectable keychain/settings resolver — never from
// project-local `.nexus/` trees. Secrets must not be written into checkout dirs.
// Patterns inspired by stablyai/orca account vault concepts @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA ideas); Nexus-authored API.
// See third_party/licenses/orca-MIT.txt.

import type { ForgeProviderId } from './forge-provider';

export type ForgeTokenAccount = {
  readonly provider: ForgeProviderId;
  readonly accountId: string;
  /** Optional host for self-hosted GitLab/Gitea etc. */
  readonly host?: string;
};

export type ForgeTokenResolver = {
  /**
   * Resolve a secret token for the given account. Implementations should read
   * OS keychain or user-global settings under the home directory — never
   * project `.nexus/` paths.
   */
  resolve(account: ForgeTokenAccount): Promise<string | null>;
};

/** In-memory resolver for tests / DI. */
export function createMemoryForgeTokenResolver(
  tokens: ReadonlyMap<string, string> | Record<string, string>,
): ForgeTokenResolver {
  const map =
    tokens instanceof Map
      ? tokens
      : new Map(Object.entries(tokens));
  return {
    async resolve(account) {
      const key = tokenCacheKey(account);
      return map.get(key) ?? map.get(`${account.provider}:${account.accountId}`) ?? null;
    },
  };
}

export function tokenCacheKey(account: ForgeTokenAccount): string {
  const host = account.host?.toLowerCase() ?? 'default';
  return `${account.provider}:${host}:${account.accountId}`;
}

/**
 * Guard: reject any path that looks like a project-scoped secret store.
 * Callers that would load tokens from disk must pass paths through this.
 *
 * Allowed under `.nexus/`: only user-global non-secret config files
 * (`settings.json`) and managed agent-hooks scripts. Everything else under
 * `.nexus/` is treated as project or secret surface and refused.
 */
export function assertNotProjectNexusSecretPath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/');
  if (!/(?:^|\/)\.nexus\//.test(normalized)) {
    return;
  }
  // Explicit secret / project-authority paths under .nexus
  if (
    /\/\.nexus\/(project\.json|identity|checkouts|worktrees)\b/.test(normalized) ||
    /\/\.nexus\/.*token/i.test(normalized) ||
    /\/\.nexus\/.*secret/i.test(normalized) ||
    /\/\.nexus\/.*credential/i.test(normalized) ||
    /\/\.nexus\/.*keychain/i.test(normalized)
  ) {
    throw new Error(
      'forge-token-resolver: refusing project-scoped .nexus secret path',
    );
  }
  // Allowlist: global settings + managed hook scripts only
  if (
    /\/\.nexus\/settings\.json$/.test(normalized) ||
    /\/\.nexus\/agent-hooks\//.test(normalized)
  ) {
    return;
  }
  // Fail closed for any other `.nexus/` path (likely checkout-local).
  throw new Error(
    'forge-token-resolver: refusing non-allowlisted .nexus path for secrets',
  );
}

let injected: ForgeTokenResolver | null = null;

export function setForgeTokenResolver(resolver: ForgeTokenResolver | null): void {
  injected = resolver;
}

export function getForgeTokenResolver(): ForgeTokenResolver | null {
  return injected;
}

export async function resolveForgeToken(
  account: ForgeTokenAccount,
): Promise<string | null> {
  if (!injected) return null;
  return injected.resolve(account);
}

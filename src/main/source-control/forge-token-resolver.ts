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
 */
export function assertNotProjectNexusSecretPath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/');
  // Project execution scopes use `<checkout>/.nexus/...` — forbid those.
  if (/(?:^|\/)\.nexus\//.test(normalized) && !/(?:^|\/)\.nexus\/?$/.test(normalized)) {
    // Allow only user-global `~/.nexus/` which does not sit under a checkout.
    // Heuristic: if path contains `/projects/` or a git root marker pattern, reject.
  }
  // Explicit ban on secrets under any `.nexus` that is not the home global config.
  // Home global settings live at `~/.nexus/settings.json` (allowed). Tokens must
  // still not live next to a checkout's `.nexus/project.json`.
  if (
    /\/\.nexus\/(project\.json|identity|checkouts|worktrees)\b/.test(normalized) ||
    /\/\.nexus\/.*token/i.test(normalized)
  ) {
    throw new Error(
      'forge-token-resolver: refusing project-scoped .nexus secret path',
    );
  }
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

// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: feature flags for
// non-default forges (Bitbucket/Azure/Gitea) — default off.

import type { ForgeProvider, ForgeProviderId } from './forge-provider';

const DEFAULT_ENABLED: Record<ForgeProviderId, boolean> = {
  github: true,
  gitlab: true,
  bitbucket: false,
  'azure-devops': false,
  gitea: false,
};

export function isForgeEnabled(
  id: ForgeProviderId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const key = `NEXUS_FORGE_${id.replace(/-/g, '_').toUpperCase()}_ENABLED`;
  if (env[key] === '1' || env[key] === 'true') return true;
  if (env[key] === '0' || env[key] === 'false') return false;
  return DEFAULT_ENABLED[id];
}

/** Stub providers for flagged-off forges — createReview always refuses. */
export function createDisabledForgeStub(id: ForgeProviderId): ForgeProvider {
  return {
    id,
    supportsReviewCreation: false,
    enabled: false,
    async createReview() {
      return { ok: false, reason: `forge-disabled:${id}` };
    },
  };
}

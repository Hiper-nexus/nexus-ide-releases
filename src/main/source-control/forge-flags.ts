// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: feature flags for
// non-default forges (Bitbucket/Azure/Gitea) — default off.
// Resync 2026-09-11: upstream turned on Bitbucket PR creation (createReview)
// at this pin, but that is a product-flag decision independent of upstream
// capability, not a bug fix — Nexus keeps Bitbucket disabled by default.

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
    async getReviewForBranch() {
      return { ok: false, reason: `forge-disabled:${id}` };
    },
  };
}

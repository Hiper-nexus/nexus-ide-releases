// Nexus production bootstrap for managed agent hook installers (Gap A).
// Registers Claude + Codex services into the managed-agent-hook-controls registry.
// Adapted patterns from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: only Claude+Codex (not all 14).

import {
  installManagedAgentHooks,
  registerManagedAgentHookService,
} from './managed-agent-hook-controls';
import { createClaudeHookService } from './claude-hook-service';
import { createCodexHookService } from './codex-hook-service';

let registered = false;

/**
 * Sole production registration of managed hook installers.
 * Idempotent — safe to call from main bootstrap and tests.
 */
export function registerDefaultManagedAgentHookInstallers(options?: {
  home?: string;
}): void {
  // Always re-register when an explicit home is provided (tests / sandbox).
  // Production bootstrap without home is idempotent.
  if (registered && options?.home === undefined) return;
  registerManagedAgentHookService('claude', createClaudeHookService({ home: options?.home }));
  registerManagedAgentHookService('codex', createCodexHookService({ home: options?.home }));
  registered = true;
}

/** Install registered managed hooks (Claude + Codex after registerDefault…). */
export function bootstrapManagedAgentHooks(options?: {
  home?: string;
  enabled?: boolean;
}): void {
  registerDefaultManagedAgentHookInstallers({ home: options?.home });
  if (options?.enabled === false) return;
  installManagedAgentHooks();
}

/** Test-only: allow re-registration after clearManagedAgentHookServices. */
export function __resetDefaultInstallerRegistrationForTests(): void {
  registered = false;
}

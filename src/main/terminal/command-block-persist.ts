import type { CommandBlock } from '../../shared/command-block';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { CommandBlockStore } from './command-block-store';
import { CommandRefineryStore } from './command-refinery-store';
import { resolveCommandBlockScope } from './command-block-scope-registry';

/**
 * Production persistence for finished CommandBlocks.
 * Fail-closed: missing scope/runtime or flag off → no write.
 */

export interface CommandBlockPersistDeps {
  readonly runtimeManager: ProjectRuntimeManager | null;
  readonly isEnabled?: () => boolean;
  readonly keepLatest?: number;
  readonly maxBytes?: number;
}

const DEFAULT_KEEP = 5_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // soft cap for history table growth probes

export function createCommandBlockPersister(
  deps: CommandBlockPersistDeps,
): (block: CommandBlock) => void {
  let insertsSincePrune = 0;
  return (block: CommandBlock): void => {
    const enabled =
      deps.isEnabled?.() ??
      getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.terminalCommandBlocks);
    if (!enabled) return;
    if (!deps.runtimeManager) return;
    const scope = resolveCommandBlockScope(block.sessionId, block.workspaceId);
    if (!scope) return;
    try {
      const store = new CommandBlockStore(deps.runtimeManager, scope);
      const persisted = store.insert({
        id: block.id,
        sessionId: block.sessionId,
        paneId: block.paneId,
        workspaceId: block.workspaceId,
        missionId: block.missionId,
        command: block.command,
        cwd: block.cwd,
        projectRoot: block.projectRoot,
        shell: block.shell,
        gitBranch: block.gitBranch,
        startedAt: block.startedAt,
        endedAt: block.endedAt,
        durationMs: block.durationMs,
        exitCode: block.exitCode,
        status: block.status,
        outputRange: block.outputRange,
        redaction: block.redaction,
        idempotencyKey: block.idempotencyKey,
      });
      try {
        new CommandRefineryStore(deps.runtimeManager, scope).record(persisted);
      } catch (err) {
        // The refinery is a rebuildable convenience index. Its failure must
        // never invalidate the canonical block or skip retention maintenance.
        console.warn('[command-refinery] index update failed:', err);
      }
      insertsSincePrune += 1;
      if (insertsSincePrune >= 50) {
        insertsSincePrune = 0;
        store.prune(deps.keepLatest ?? DEFAULT_KEEP);
        store.enforceSizeBudget(deps.maxBytes ?? DEFAULT_MAX_BYTES);
      }
    } catch (err) {
      console.warn('[command-block] persist failed:', err);
    }
  };
}

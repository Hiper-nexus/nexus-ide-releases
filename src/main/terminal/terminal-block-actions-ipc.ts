import { ipcMain } from 'electron';
import { z } from 'zod';
import { TERMINAL_BLOCK_CHANNELS } from '../../shared/channels';
import type { CommandBlock } from '../../shared/command-block';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  defaultTerminalBlockActionDeps,
  executeTerminalBlockAction,
  type TerminalBlockActionResult,
} from './terminal-block-actions';
import { getCommandBlockTracker } from './command-block-tracker';

const listRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(128).optional(),
    paneId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.sessionId || v.paneId), {
    message: 'sessionId or paneId required',
  });

/**
 * Product path for CommandBlock contextual actions + list for UI.
 * Re-run always goes through writeSession (ownership + policy).
 */
export function registerTerminalBlockActionsIpc(): void {
  const deps = defaultTerminalBlockActionDeps();
  ipcMain.handle(
    TERMINAL_BLOCK_CHANNELS.action,
    async (event, raw): Promise<TerminalBlockActionResult> => {
      try {
        return await executeTerminalBlockAction(event.sender, raw, deps);
      } catch (err) {
        return {
          ok: false,
          action: 'copy_command',
          error: err instanceof Error ? err.message : 'terminal block action failed',
        };
      }
    },
  );

  ipcMain.handle(
    TERMINAL_BLOCK_CHANNELS.list,
    (
      _event,
      raw,
    ): { blocks: CommandBlock[]; error?: string } => {
      try {
        if (
          !getFeatureFlagRegistry().isEnabled(
            FEATURE_FLAG_IDS.terminalCommandBlocks,
          )
        ) {
          return { blocks: [] };
        }
        const req = listRequestSchema.parse(raw ?? {});
        const tracker = getCommandBlockTracker();
        if (!tracker) return { blocks: [] };
        const limit = req.limit ?? 12;
        let blocks: readonly CommandBlock[] = [];
        if (req.sessionId) {
          blocks = tracker.listBlocks(req.sessionId);
          if (req.paneId) {
            blocks = blocks.filter((b) => b.paneId === req.paneId);
          }
        } else if (req.paneId) {
          blocks = tracker.listByPane(req.paneId);
        }
        // Newest first for UI.
        const ordered = [...blocks].reverse().slice(0, limit);
        return { blocks: ordered };
      } catch (err) {
        return {
          blocks: [],
          error: err instanceof Error ? err.message : 'list failed',
        };
      }
    },
  );
}

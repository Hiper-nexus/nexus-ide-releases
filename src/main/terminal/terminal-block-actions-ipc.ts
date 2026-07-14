import { ipcMain } from 'electron';
import { TERMINAL_BLOCK_CHANNELS } from '../../shared/channels';
import {
  defaultTerminalBlockActionDeps,
  executeTerminalBlockAction,
  type TerminalBlockActionResult,
} from './terminal-block-actions';

/**
 * Product path for CommandBlock contextual actions.
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
}

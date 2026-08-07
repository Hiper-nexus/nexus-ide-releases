import { ipcMain } from 'electron';
import { z } from 'zod';
import { TERMINAL_BLOCK_CHANNELS } from '../../shared/channels';
import type { CommandBlock } from '../../shared/command-block';
import {
  commandRefineryCommandRequestSchema,
  commandRefinerySuggestRequestSchema,
  type CommandRefineryMutationResult,
  type CommandRefinerySuggestResult,
} from '../../shared/command-refinery';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { isSessionOwnedBy, writeSession } from '../pty/pty-manager';
import {
  assertRerunAllowed,
  defaultTerminalBlockActionDeps,
  executeTerminalBlockAction,
  type TerminalBlockActionResult,
} from './terminal-block-actions';
import {
  getCommandBlockTracker,
  type CommandBlockSessionContext,
} from './command-block-tracker';
import { resolveCommandBlockScope } from './command-block-scope-registry';
import { CommandRefineryStore } from './command-refinery-store';

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
export function registerTerminalBlockActionsIpc(
  runtimeManager: ProjectRuntimeManager | null,
): void {
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
      event,
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
          if (!isSessionOwnedBy(event.sender, req.sessionId)) {
            return { blocks: [] };
          }
          blocks = tracker.listBlocks(req.sessionId);
          if (req.paneId) {
            blocks = blocks.filter((b) => b.paneId === req.paneId);
          }
        } else if (req.paneId) {
          blocks = tracker
            .listByPane(req.paneId)
            .filter((block) => isSessionOwnedBy(event.sender, block.sessionId));
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

  ipcMain.handle(
    TERMINAL_BLOCK_CHANNELS.suggest,
    (event, raw): CommandRefinerySuggestResult => {
      try {
        if (!isCommandHistoryEnabled() || !runtimeManager) {
          return { suggestions: [] };
        }
        const req = commandRefinerySuggestRequestSchema.parse(raw);
        const owned = resolveOwnedRefineryContext(event.sender, req);
        if (!owned) return { suggestions: [] };
        const store = new CommandRefineryStore(runtimeManager, owned.scope);
        return {
          suggestions: [
            ...store.suggest({
              cwd: owned.context.cwd,
              projectRoot: owned.context.projectRoot,
              prefix: req.prefix,
              limit: req.limit,
            }),
          ],
        };
      } catch (err) {
        return {
          suggestions: [],
          error: reportRefineryFailure(
            err,
            'Não foi possível carregar sugestões',
          ),
        };
      }
    },
  );

  ipcMain.handle(
    TERMINAL_BLOCK_CHANNELS.dismiss,
    (event, raw): CommandRefineryMutationResult => {
      try {
        if (!isCommandHistoryEnabled() || !runtimeManager) {
          return { ok: false, error: 'Histórico de comandos indisponível' };
        }
        const req = commandRefineryCommandRequestSchema.parse(raw);
        const owned = resolveOwnedRefineryContext(event.sender, req);
        if (!owned) return { ok: false, error: 'Sessão indisponível' };
        const store = new CommandRefineryStore(runtimeManager, owned.scope);
        const ok = store.dismiss({ command: req.command, cwd: req.cwd });
        return ok ? { ok: true } : { ok: false, error: 'Sugestão indisponível' };
      } catch (err) {
        return {
          ok: false,
          error: reportRefineryFailure(err, 'Não foi possível dispensar'),
        };
      }
    },
  );

  ipcMain.handle(
    TERMINAL_BLOCK_CHANNELS.runSuggestion,
    (event, raw): CommandRefineryMutationResult => {
      try {
        if (!isCommandHistoryEnabled() || !runtimeManager) {
          return { ok: false, error: 'Histórico de comandos indisponível' };
        }
        const req = commandRefineryCommandRequestSchema.parse(raw);
        const owned = resolveOwnedRefineryContext(event.sender, req);
        if (!owned) return { ok: false, error: 'Sessão indisponível' };
        const store = new CommandRefineryStore(runtimeManager, owned.scope);
        const command = store.resolveRunnable({
          command: req.command,
          cwd: req.cwd,
        });
        if (!command) return { ok: false, error: 'Sugestão indisponível' };
        assertRerunAllowed(command);
        const ok = writeSession(event.sender, req.sessionId, `${command}\n`);
        return ok
          ? { ok: true }
          : { ok: false, error: 'Escrita na sessão recusada' };
      } catch (err) {
        return {
          ok: false,
          error: reportRefineryFailure(err, 'Execução recusada'),
        };
      }
    },
  );
}

interface OwnedRefineryContext {
  readonly context: CommandBlockSessionContext;
  readonly scope: ProjectExecutionScope;
}

function resolveOwnedRefineryContext(
  sender: Electron.WebContents,
  req: { readonly sessionId: string; readonly paneId: string },
): OwnedRefineryContext | null {
  if (!isSessionOwnedBy(sender, req.sessionId)) return null;
  const context = getCommandBlockTracker()?.getSessionContext(req.sessionId);
  if (!context || context.paneId !== req.paneId) return null;
  const scope = resolveCommandBlockScope(req.sessionId, context.workspaceId);
  return scope ? { context, scope } : null;
}

function isCommandHistoryEnabled(): boolean {
  return getFeatureFlagRegistry().isEnabled(
    FEATURE_FLAG_IDS.terminalCommandBlocks,
  );
}

function reportRefineryFailure(error: unknown, fallback: string): string {
  console.warn('[command-refinery] IPC request failed:', error);
  return fallback;
}

import { z } from 'zod';
import type { CommandBlock } from '../../shared/command-block';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import type { WebContents } from 'electron';
import { writeSession } from '../pty/pty-manager';
import { getCommandBlockTracker } from './command-block-tracker';

/**
 * Contextual actions on CommandBlocks. Re-run always goes through writeSession
 * (same ownership + policy as live terminal input) — never a side channel.
 */

export const terminalBlockActionSchema = z.enum([
  'copy_command',
  'copy_path',
  'copy_output_ref',
  'attach_mission',
  'handoff_from_block',
  'create_worktree',
  'rerun',
]);

export type TerminalBlockAction = z.infer<typeof terminalBlockActionSchema>;

export const terminalBlockActionRequestSchema = z
  .object({
    action: terminalBlockActionSchema,
    block: z.object({
      id: z.string().min(1).max(128),
      sessionId: z.string().min(1).max(128),
      paneId: z.string().min(1).max(128),
      workspaceId: z.string().min(1).max(128),
      missionId: z.string().min(1).max(128).optional(),
      command: z.string().max(16_384),
      cwd: z.string().min(1).max(4096),
      projectRoot: z.string().max(4096).optional(),
      shell: z.string().min(1).max(256),
      status: z.string().min(1).max(32),
    }),
    missionId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type TerminalBlockActionRequest = z.infer<
  typeof terminalBlockActionRequestSchema
>;

export interface TerminalBlockActionResult {
  readonly ok: boolean;
  readonly action: TerminalBlockAction;
  readonly payload?: Record<string, unknown>;
  readonly error?: string;
  /** Clipboard-ready text for renderer copy actions. */
  readonly clipboardText?: string;
}

export interface TerminalBlockActionDeps {
  readonly writeToSession: (
    wc: WebContents,
    sessionId: string,
    data: string,
  ) => boolean;
  /**
   * Prefer server-side command for re-run (fail-closed against client
   * forging a different command on the same block id).
   */
  readonly resolveBlockCommand?: (
    sessionId: string,
    blockId: string,
  ) => string | null;
  readonly createWorktree?: (input: {
    readonly missionId: string;
    readonly cwd: string;
    readonly blockId: string;
  }) => Promise<{ path: string } | { error: string }>;
  readonly isEnabled?: () => boolean;
}

const DENY_RERUN = [/^\s*rm\s+-rf\b/i, /^\s*sudo\b/i, /^\s*:\(\)\s*\{/];

export function assertRerunAllowed(command: string): void {
  if (!command.trim()) throw new Error('empty command cannot be re-run');
  if (command.includes('\0')) throw new Error('invalid command');
  for (const re of DENY_RERUN) {
    if (re.test(command)) {
      throw new Error('command blocked by re-run safety policy');
    }
  }
  // Secrets already redacted in stored blocks; still refuse obvious tokens.
  if (/\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,})\b/i.test(command)) {
    throw new Error('command still contains secret-like material');
  }
}

export async function executeTerminalBlockAction(
  wc: WebContents,
  raw: unknown,
  deps: TerminalBlockActionDeps,
): Promise<TerminalBlockActionResult> {
  const enabled =
    deps.isEnabled?.() ??
    getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.terminalCommandBlocks);
  if (!enabled) {
    return {
      ok: false,
      action: 'copy_command',
      error: 'feature.terminal.commandBlocks is disabled',
    };
  }

  const req = terminalBlockActionRequestSchema.parse(raw);
  const { action, block } = req;

  switch (action) {
    case 'copy_command':
      return { ok: true, action, clipboardText: block.command };
    case 'copy_path':
      return { ok: true, action, clipboardText: block.cwd };
    case 'copy_output_ref':
      return {
        ok: true,
        action,
        clipboardText: `command-block://${block.id}`,
        payload: { blockId: block.id, sessionId: block.sessionId },
      };
    case 'attach_mission': {
      const missionId = req.missionId ?? block.missionId;
      if (!missionId) {
        return { ok: false, action, error: 'missionId required' };
      }
      return {
        ok: true,
        action,
        payload: {
          missionId,
          blockId: block.id,
          command: block.command,
          cwd: block.cwd,
        },
      };
    }
    case 'handoff_from_block':
      return {
        ok: true,
        action,
        payload: {
          summary: `Command \`${block.command}\` in ${block.cwd} (status=${block.status})`,
          artifacts: [{ kind: 'command-block', id: block.id }],
          missionId: req.missionId ?? block.missionId,
        },
      };
    case 'create_worktree': {
      if (!deps.createWorktree) {
        return { ok: false, action, error: 'worktree provider unavailable' };
      }
      const missionId = req.missionId ?? block.missionId;
      if (!missionId) {
        return { ok: false, action, error: 'missionId required for worktree' };
      }
      const result = await deps.createWorktree({
        missionId,
        cwd: block.cwd,
        blockId: block.id,
      });
      if ('error' in result) return { ok: false, action, error: result.error };
      return { ok: true, action, payload: { path: result.path } };
    }
    case 'rerun': {
      // Prefer tracker/store command over client payload when available.
      const authoritative =
        deps.resolveBlockCommand?.(block.sessionId, block.id) ?? null;
      const command = authoritative ?? block.command;
      if (authoritative !== null && authoritative !== block.command) {
        // Client tried to forge a different command for this block id.
        return {
          ok: false,
          action,
          error: 'block command mismatch — re-run denied',
        };
      }
      try {
        assertRerunAllowed(command);
      } catch (err) {
        return {
          ok: false,
          action,
          error: err instanceof Error ? err.message : 're-run denied',
        };
      }
      // Same path as live keyboard input: ownership enforced in writeSession.
      const data = `${command}\n`;
      const written = deps.writeToSession(wc, block.sessionId, data);
      if (!written) {
        return {
          ok: false,
          action,
          error: 'session write denied (ownership or dead session)',
        };
      }
      return { ok: true, action, payload: { sessionId: block.sessionId } };
    }
    default:
      return { ok: false, action, error: 'unknown action' };
  }
}

/** Default deps bound to pty-manager.writeSession + in-memory tracker. */
export function defaultTerminalBlockActionDeps(): TerminalBlockActionDeps {
  return {
    writeToSession: writeSession,
    resolveBlockCommand: (sessionId, blockId) => {
      const tracker = getCommandBlockTracker();
      return tracker?.findBlock(sessionId, blockId)?.command ?? null;
    },
  };
}

export function handoffSummaryFromBlock(block: CommandBlock): string {
  return `Command \`${block.command}\` @ ${block.cwd} → ${block.status}`;
}

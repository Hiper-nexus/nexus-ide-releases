import { createHash } from 'node:crypto';
import {
  CLI_HISTORY_PANE_ID,
  CLI_HISTORY_SESSION_PREFIX,
} from '../../shared/cli-history';
import type { CreateCommandBlockInput } from '../../shared/command-block';
import { redactCommandLine } from '../../shared/secret-redaction';
import type { ImportedCommandBlock } from './cli-history-import';
import { computeCommandBlockIdempotencyKey } from './command-block-id';

/**
 * Adaptador ImportedCommandBlock → CreateCommandBlockInput (F-1171).
 *
 * - Redige com o mesmo `redactCommandLine` do tracker OSC 133: o segredo
 *   nunca sai daqui, nem dentro do hash.
 * - id e chave de idempotência derivam de (sessão sintética, início, comando
 *   redigido, cwd): reimportar o mesmo transcript não duplica.
 * - Origem: sessionId `cli-import:<adapter>:<hash>` + paneId fixo; o status
 *   fica `unknown` (transcript não prova exit code).
 */

export interface CliHistoryAdaptTarget {
  /** Workspace do pane que pediu o import (checkout do escopo). */
  readonly workspaceId: string;
  readonly projectRoot?: string;
}

const MAX_ID = 128;
const MAX_PATH = 4096;
const MAX_SHELL = 256;

/** Sessão sintética estável por transcript (adapter + caminho relativo). */
export function cliHistorySessionId(adapterId: string, relativePath: string): string {
  const adapter = adapterId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'cli';
  const digest = createHash('sha256').update(relativePath).digest('hex').slice(0, 24);
  return `${CLI_HISTORY_SESSION_PREFIX}${adapter}:${digest}`;
}

export function adaptImportedCommandBlock(
  block: ImportedCommandBlock,
  target: CliHistoryAdaptTarget,
): CreateCommandBlockInput | null {
  if (!block.command.trim()) return null;
  if (!block.cwd || block.cwd.length > MAX_PATH) return null;
  if (!block.sessionId || block.sessionId.length > MAX_ID) return null;
  if (!Number.isFinite(block.startedAt) || block.startedAt < 0) return null;
  if (!target.workspaceId || target.workspaceId.length > MAX_ID) return null;

  const scrubbed = redactCommandLine(block.command);
  const startedAt = Math.trunc(block.startedAt);
  const idempotencyKey = computeCommandBlockIdempotencyKey({
    sessionId: block.sessionId,
    startedAt,
    command: scrubbed.command,
    cwd: block.cwd,
  });
  const projectRoot =
    target.projectRoot && target.projectRoot.length <= MAX_PATH
      ? target.projectRoot
      : undefined;

  return {
    id: `cli-import-${idempotencyKey.slice(0, 48)}`,
    sessionId: block.sessionId,
    paneId: CLI_HISTORY_PANE_ID,
    workspaceId: target.workspaceId,
    command: scrubbed.command,
    cwd: block.cwd,
    ...(projectRoot ? { projectRoot } : {}),
    shell: (block.shell || 'bash').slice(0, MAX_SHELL),
    startedAt,
    status: 'unknown',
    redaction: {
      redacted: scrubbed.redacted || scrubbed.denylisted,
      denylisted: scrubbed.denylisted,
      secretHits: scrubbed.secretHits,
    },
    idempotencyKey,
  };
}

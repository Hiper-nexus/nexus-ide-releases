import { z } from 'zod';
import { commandBlockStatusSchema } from './command-block';

/**
 * Contrato do histórico persistido de comandos (F-1171): importar os
 * transcripts das CLIs para o `command_blocks` do projeto e buscar nele.
 * Sem Node builtins — o renderer importa daqui.
 */

const idSchema = z.string().min(1).max(128);

/**
 * Marca de origem: blocos importados de transcript nascem com sessionId
 * `cli-import:<adapter>:<hash>` e paneId fixo. Nenhuma sessão PTY real usa
 * esse prefixo, então a origem é derivável sem coluna nova no SQLite.
 */
export const CLI_HISTORY_SESSION_PREFIX = 'cli-import:';
export const CLI_HISTORY_PANE_ID = 'cli-import';

export type CommandHistoryOrigin = 'imported' | 'recorded';

export function commandHistoryOriginOf(sessionId: string): CommandHistoryOrigin {
  return sessionId.startsWith(CLI_HISTORY_SESSION_PREFIX) ? 'imported' : 'recorded';
}

export const cliHistoryImportRequestSchema = z
  .object({
    sessionId: idSchema,
    paneId: idSchema,
  })
  .strict();

export type CliHistoryImportRequest = z.infer<typeof cliHistoryImportRequestSchema>;

/** `imported + duplicates + skipped === found` (comandos achados nos transcripts). */
export interface CliHistoryImportCounts {
  /** Transcripts lidos. */
  readonly files: number;
  /** Transcripts ignorados (grandes demais ou ilegíveis). */
  readonly filesSkipped: number;
  /** Comandos de shell achados nos transcripts lidos. */
  readonly found: number;
  readonly imported: number;
  /** Já estavam no histórico (reimportar não duplica). */
  readonly duplicates: number;
  /** Comandos fora do teto ou inválidos para o histórico. */
  readonly skipped: number;
  /** Algum teto (arquivos ou comandos) cortou a varredura. */
  readonly capped: boolean;
}

export interface CliHistoryImportResult {
  readonly ok: boolean;
  readonly counts?: CliHistoryImportCounts;
  readonly error?: string;
}

export const commandHistorySearchRequestSchema = z
  .object({
    sessionId: idSchema,
    paneId: idSchema,
    query: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export type CommandHistorySearchRequest = z.infer<
  typeof commandHistorySearchRequestSchema
>;

export const commandHistoryEntrySchema = z
  .object({
    id: idSchema,
    command: z.string().max(16_384),
    cwd: z.string().min(1).max(4096),
    status: commandBlockStatusSchema,
    startedAt: z.number().int().nonnegative(),
    origin: z.enum(['imported', 'recorded']),
  })
  .strict();

export type CommandHistoryEntry = z.infer<typeof commandHistoryEntrySchema>;

export interface CommandHistorySearchResult {
  readonly entries: CommandHistoryEntry[];
  readonly hasMore: boolean;
  readonly error?: string;
}

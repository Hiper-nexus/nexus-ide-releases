/**
 * Importação de histórico de CLI (item T3 `claudeHistoryWorker`).
 *
 * Lê o transcript JSONL de uma CLI (Claude Code / Codex style) e extrai os
 * blocos de comando (tool_use Bash / shell) no formato que o
 * `command-block-store` persiste. Parser PURO: nenhum I/O, nenhum banco —
 * quem chama decide onde gravar.
 *
 * Fonte típica: `provider-state/<cli>/<checkout>/…/*.jsonl` com entradas
 * `{ type: 'assistant'|'user', message: { content: [{ type: 'tool_use'|… }] } }`.
 */

export interface ImportedCommandBlock {
  readonly sessionId: string;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly missionId?: string;
  readonly command: string;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly shell: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly status: 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';
}

export interface CliHistoryImportOptions {
  readonly sessionId: string;
  readonly paneId?: string;
  readonly workspaceId?: string;
  readonly missionId?: string;
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly shell?: string;
}

interface ToolUseBlock {
  type?: string;
  name?: string;
  input?: { command?: unknown; [key: string]: unknown };
  id?: string;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    content?: unknown;
  };
  cwd?: string;
}

function asArray(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const command = (input as ToolUseBlock['input'])?.command;
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Extrai blocos de comando de um transcript JSONL. Linhas ilegíveis são
 * puladas (histórico parcial não aborta o import). `idempotencyKey` fica por
 * conta do store (sessionId + startedAt + command + cwd).
 */
export function importCliHistoryBlocks(
  jsonl: string,
  options: CliHistoryImportOptions,
): ImportedCommandBlock[] {
  const shell = options.shell ?? 'bash';
  const cwd = options.cwd ?? process.cwd();
  const blocks: ImportedCommandBlock[] = [];
  const lines = (jsonl ?? '').split(/\r?\n/);
  let index = 0;
  for (const line of lines) {
    index += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    const content = asArray(parsed.message?.content);
    for (const item of content) {
      const block = item as ToolUseBlock;
      const isShellTool =
        block?.type === 'tool_use' &&
        typeof block.name === 'string' &&
        /^(Bash|bash|Shell|shell|exec)$/i.test(block.name);
      if (!isShellTool) continue;
      const command = extractCommand(block.input);
      if (!command) continue;
      const startedAt = parseTimestamp(parsed.timestamp, index);
      blocks.push({
        sessionId: options.sessionId,
        paneId: options.paneId ?? 'imported',
        workspaceId: options.workspaceId ?? 'imported',
        ...(options.missionId ? { missionId: options.missionId } : {}),
        command,
        cwd: typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : cwd,
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        shell,
        startedAt,
        // Histórico importado não tem saída/exit provados: status honesto.
        status: 'unknown',
      });
    }
  }
  return blocks;
}

/** Conveniência: várias linhas de vários transcripts (um sessionId por arquivo). */
export function importCliHistoryFiles(
  files: readonly { readonly sessionId: string; readonly jsonl: string }[],
  options: Omit<CliHistoryImportOptions, 'sessionId'> = {},
): ImportedCommandBlock[] {
  const out: ImportedCommandBlock[] = [];
  for (const file of files) {
    out.push(
      ...importCliHistoryBlocks(file.jsonl, {
        ...options,
        sessionId: file.sessionId,
      }),
    );
  }
  return out;
}

/**
 * Importação de histórico de CLI (item T3 `claudeHistoryWorker`).
 *
 * Lê o transcript JSONL de uma CLI (Claude Code / Codex style) e extrai os
 * blocos de comando (tool_use Bash / shell) no formato que o
 * `command-block-store` persiste. Parser PURO: nenhum I/O, nenhum banco —
 * quem chama decide onde gravar.
 *
 * Fonte típica Claude: `{ type, message: { content: [{ type: 'tool_use' }] } }`.
 * Fonte típica Codex (rollout JSONL): registro de topo
 * `{ type: 'response_item', payload: { type: 'function_call', name, arguments } }`.
 * `arguments` pode ser objeto ou JSON; `command` string ou `[shell, -lc, script]`;
 * `exec_command` usa `cmd`.
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
  payload?: {
    type?: string;
    name?: string;
    arguments?: unknown;
  };
}

const SHELL_TOOL_NAME =
  /(?:^|[./])(?:bash|shell|local_shell|exec|exec_command|shell_command)$/i;

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

function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

/** Codex shell manda `[shell, -lc, script]`; exec_command manda `cmd`. */
function commandFromToolArgs(args: Record<string, unknown>): string | null {
  if (typeof args.cmd === 'string') {
    const cmd = args.cmd.trim();
    if (cmd.length > 0) return cmd;
  }
  const command = args.command;
  if (typeof command === 'string') {
    const trimmed = command.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(command)) return null;
  const parts = command.filter((part): part is string => typeof part === 'string');
  if (parts.length === 0) return null;
  const flag = parts.length >= 3 ? parts[1] : undefined;
  if (flag === '-c' || flag === '-lc') {
    const script = parts.slice(2).join(' ').trim();
    return script.length > 0 ? script : null;
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : null;
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
  const push = (
    parsed: TranscriptLine,
    command: string,
    workdir: string | undefined,
  ) => {
    const startedAt = parseTimestamp(parsed.timestamp, index);
    const lineCwd =
      workdir ??
      (typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : cwd);
    blocks.push({
      sessionId: options.sessionId,
      paneId: options.paneId ?? 'imported',
      workspaceId: options.workspaceId ?? 'imported',
      ...(options.missionId ? { missionId: options.missionId } : {}),
      command,
      cwd: lineCwd,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      shell,
      startedAt,
      // Histórico importado não tem saída/exit provados: status honesto.
      status: 'unknown',
    });
  };
  for (const line of lines) {
    index += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: TranscriptLine;
    try {
      const value: unknown = JSON.parse(trimmed);
      // F-1050: `null` e não-objetos passam no JSON.parse e quebram no
      // acesso a `.message`. Ignora a linha incompatível e continua.
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      parsed = value as TranscriptLine;
    } catch {
      continue;
    }
    const content = asArray(parsed.message?.content);
    for (const item of content) {
      const block = item as ToolUseBlock;
      const isShellTool =
        block?.type === 'tool_use' &&
        typeof block.name === 'string' &&
        SHELL_TOOL_NAME.test(block.name);
      if (!isShellTool) continue;
      const command = extractCommand(block.input);
      if (!command) continue;
      push(parsed, command, undefined);
    }
    if (parsed.type !== 'response_item' || parsed.payload?.type !== 'function_call') {
      continue;
    }
    const name = parsed.payload.name;
    if (typeof name !== 'string' || !SHELL_TOOL_NAME.test(name)) continue;
    const args = parseArguments(parsed.payload.arguments);
    if (!args) continue;
    const command = commandFromToolArgs(args);
    if (!command) continue;
    const workdir =
      typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : undefined;
    push(parsed, command, workdir);
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

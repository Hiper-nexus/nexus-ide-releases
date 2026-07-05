/**
 * Parser PURO do transcript JSONL do Claude Code (~/.claude/projects/<slug>/
 * <sessionId>.jsonl) — a fonte de USO REAL de tokens, em contraste com a
 * estimativa por bytes do cost-tracker. Cada turno do assistant traz
 * `message.usage` com contagens exatas (input, output, cache read/write).
 *
 * O CLI regrava a MESMA mensagem várias vezes durante o streaming (uma por
 * content block) — o consumidor deve deduplicar por (sessionId, messageId)
 * com "último snapshot vence" (ver usage-store).
 */

export interface UsageEvent {
  sessionId: string;
  /** id da mensagem do assistant (dedupe); null em formatos sem id. */
  messageId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** epoch ms do turno (quando presente no transcript). */
  timestamp: number | null;
}

/**
 * Slug de projeto do Claude Code: o caminho absoluto do workspace com todo
 * caractere não alfanumérico virando '-' (ex.: /Users/x/app → -Users-x-app).
 */
export function claudeProjectSlug(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]/g, '-');
}

interface TranscriptLine {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Extrai o evento de uso de UMA linha do JSONL. Retorna null para linhas que
 * não são turno de assistant com usage (user, tool results, meta, lixo).
 * NUNCA lança — transcript é formato de terceiro e muda sem aviso.
 */
export function parseTranscriptLine(line: string): UsageEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: TranscriptLine;
  try {
    obj = JSON.parse(trimmed) as TranscriptLine;
  } catch {
    return null;
  }
  if (obj.type !== 'assistant') return null;
  const usage = obj.message?.usage;
  if (!usage || typeof obj.sessionId !== 'string' || !obj.sessionId) return null;

  const cacheCreation = usage.cache_creation;
  // Split 5m/1h quando existe; senão todo cache_creation cai no bucket 5m
  // (comportamento do campo legado agregado).
  const write5m = cacheCreation
    ? num(cacheCreation.ephemeral_5m_input_tokens)
    : num(usage.cache_creation_input_tokens);
  const write1h = cacheCreation ? num(cacheCreation.ephemeral_1h_input_tokens) : 0;

  const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;

  return {
    sessionId: obj.sessionId,
    messageId: typeof obj.message?.id === 'string' ? obj.message.id : null,
    model: typeof obj.message?.model === 'string' ? obj.message.model : 'unknown',
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    timestamp: Number.isFinite(ts) ? ts : null,
  };
}

/**
 * Consome um chunk de bytes de um tail de arquivo JSONL: junta com o resto da
 * leitura anterior, devolve as linhas COMPLETAS e o novo resto (última linha
 * parcial, ainda sem \n). Puro — o watcher guarda o resto por arquivo.
 */
export function splitTailChunk(
  remainder: string,
  chunk: string,
): { lines: string[]; remainder: string } {
  const text = remainder + chunk;
  const parts = text.split('\n');
  const newRemainder = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.trim().length > 0), remainder: newRemainder };
}

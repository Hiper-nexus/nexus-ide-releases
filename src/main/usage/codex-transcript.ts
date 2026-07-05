import type { UsageEvent } from './claude-transcript';

/**
 * Parser do rollout JSONL do Codex (~/.codex/sessions/YYYY/MM/DD/
 * rollout-<ts>-<uuid>.jsonl) — uso REAL de tokens do CLI Codex/GPT.
 *
 * Diferenças estruturais vs Claude (validadas contra arquivos reais):
 * - o diretório é por DATA, não por workspace: o `cwd` vem do `session_meta`
 *   (head do arquivo) e é o critério de atribuição a um workspace;
 * - o modelo vem do `turn_context`, não do evento de uso;
 * - o uso vem em event_msg `token_count` → `payload.info.last_token_usage`
 *   (usar o LAST, nunca `total_token_usage` — o total é acumulado e dobraria);
 * - `input_tokens` JÁ INCLUI os `cached_input_tokens` (subtrair para obter o
 *   input não cacheado); `output_tokens` já inclui reasoning;
 * - não há message id: sintetizamos um id determinístico do timestamp do
 *   evento para o re-ingest pós-restart ser idempotente no dedupe do store.
 */

export interface CodexMeta {
  sessionId: string;
  cwd: string | null;
}

export type CodexLine =
  | { kind: 'meta'; meta: CodexMeta }
  | { kind: 'model'; model: string }
  | {
      kind: 'usage';
      usage: {
        messageId: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        timestamp: number | null;
      };
    };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Classifica uma linha do rollout. Retorna null para linhas irrelevantes. NUNCA lança. */
export function parseCodexLine(line: string): CodexLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: {
    type?: string;
    timestamp?: string;
    payload?: {
      type?: string;
      session_id?: string;
      cwd?: string;
      model?: string;
      info?: {
        last_token_usage?: {
          input_tokens?: number;
          cached_input_tokens?: number;
          output_tokens?: number;
        };
      };
    };
  };
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const payload = obj.payload;
  if (!payload) return null;

  if (obj.type === 'session_meta' && typeof payload.session_id === 'string') {
    return {
      kind: 'meta',
      meta: {
        sessionId: payload.session_id,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      },
    };
  }
  if (obj.type === 'turn_context' && typeof payload.model === 'string') {
    return { kind: 'model', model: payload.model };
  }
  if (obj.type === 'event_msg' && payload.type === 'token_count') {
    const last = payload.info?.last_token_usage;
    if (!last) return null;
    const cached = num(last.cached_input_tokens);
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    return {
      kind: 'usage',
      usage: {
        messageId: `codex:${obj.timestamp ?? 'sem-ts'}`,
        inputTokens: Math.max(0, num(last.input_tokens) - cached),
        outputTokens: num(last.output_tokens),
        cacheReadTokens: cached,
        timestamp: Number.isFinite(ts) ? ts : null,
      },
    };
  }
  return null;
}

/**
 * Ingestor com estado por ARQUIVO: costura session_meta (sessionId/cwd) e
 * turn_context (modelo corrente) nos eventos de uso, produzindo UsageEvent
 * completos para o usage-store. `cwd` fica exposto para o caller decidir a
 * qual workspace o arquivo pertence.
 */
export class CodexFileIngest {
  private sessionId: string | null = null;
  cwd: string | null = null;
  private model = 'gpt-5';

  /** Processa uma linha; retorna o UsageEvent quando ela fecha um uso. */
  ingestLine(line: string): UsageEvent | null {
    const parsed = parseCodexLine(line);
    if (!parsed) return null;
    if (parsed.kind === 'meta') {
      this.sessionId = parsed.meta.sessionId;
      this.cwd = parsed.meta.cwd;
      return null;
    }
    if (parsed.kind === 'model') {
      this.model = parsed.model;
      return null;
    }
    if (!this.sessionId) return null; // uso antes do session_meta: inatribuível
    return {
      sessionId: this.sessionId,
      messageId: parsed.usage.messageId,
      model: this.model,
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cacheReadTokens: parsed.usage.cacheReadTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: parsed.usage.timestamp,
    };
  }
}

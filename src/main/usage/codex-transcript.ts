import { createHash } from 'node:crypto';
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
 * - não há message id: sintetizamos um id determinístico do thread físico +
 *   ordinal do token_count + timestamp. O store reconhece o antigo id baseado
 *   só no timestamp para não reingerir eventos após upgrade.
 */

export interface CodexMeta {
  /** Canonical provider session used by resume/dictation and persisted usage. */
  sessionId: string;
  /** Physical thread that owns this rollout file (`payload.id`). */
  threadId: string;
  cwd: string | null;
  parentThreadId?: string;
  /** Provider thread creation time used to ignore copied parent history. */
  startedAt?: number;
}

export type CodexLine =
  | { kind: 'meta'; meta: CodexMeta }
  | { kind: 'model'; model: string }
  | {
      kind: 'turn-start';
      turnId: string | null;
      startedAt: number | null;
    }
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

interface RawCodexPayload {
  id?: string;
  type?: string;
  session_id?: string;
  parent_thread_id?: string;
  timestamp?: string;
  turn_id?: string;
  started_at?: number;
  cwd?: string;
  model?: string;
  info?: {
    last_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

interface RawCodexLine {
  type?: string;
  timestamp?: string;
  payload?: RawCodexPayload;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

const LEGACY_CODEX_USAGE_PREFIX = 'codex:';
const STABLE_CODEX_USAGE_ID =
  /^codex:v2:[a-f0-9]{64}:[1-9]\d*:(.+)$/;

function stableCodexUsageMessageId(
  threadFingerprint: string,
  ordinal: number,
  legacyMessageId: string,
): string {
  const sourceKey = legacyMessageId.slice(LEGACY_CODEX_USAGE_PREFIX.length);
  return `codex:v2:${threadFingerprint}:${ordinal}:${sourceKey}`;
}

/** Maps a v2 physical event id to the timestamp-only id used before v0.19.38. */
export function legacyCodexUsageMessageId(
  messageId: string,
): string | null {
  const matched = STABLE_CODEX_USAGE_ID.exec(messageId);
  return matched ? `${LEGACY_CODEX_USAGE_PREFIX}${matched[1]}` : null;
}

function parseSessionMeta(
  type: string | undefined,
  payload: RawCodexPayload,
): CodexLine | null {
  const threadId =
    typeof payload.id === 'string' && payload.id.trim()
      ? payload.id
      : payload.session_id;
  if (type !== 'session_meta' || typeof threadId !== 'string') return null;
  const providerSessionId =
    typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id
      : threadId;
  const explicitParent = payload.parent_thread_id?.trim();
  const parentThreadId =
    explicitParent || (providerSessionId !== threadId ? providerSessionId : '');
  const startedAt = payload.timestamp ? Date.parse(payload.timestamp) : NaN;
  return {
    kind: 'meta',
    meta: {
      sessionId: providerSessionId,
      threadId,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    },
  };
}

function parseTurnStart(
  type: string | undefined,
  payload: RawCodexPayload,
): CodexLine | null {
  if (type !== 'event_msg' || payload.type !== 'task_started') return null;
  return {
    kind: 'turn-start',
    turnId:
      typeof payload.turn_id === 'string' && payload.turn_id.trim()
        ? payload.turn_id
        : null,
    startedAt:
      typeof payload.started_at === 'number' &&
      Number.isFinite(payload.started_at) &&
      payload.started_at >= 0
        ? Math.floor(payload.started_at * 1_000)
        : null,
  };
}

function parseUsage(
  raw: RawCodexLine,
  payload: RawCodexPayload,
): CodexLine | null {
  if (raw.type !== 'event_msg' || payload.type !== 'token_count') return null;
  const last = payload.info?.last_token_usage;
  if (!last) return null;
  const cached = num(last.cached_input_tokens);
  const timestamp = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
  return {
    kind: 'usage',
    usage: {
      messageId: `codex:${raw.timestamp ?? 'sem-ts'}`,
      inputTokens: Math.max(0, num(last.input_tokens) - cached),
      outputTokens: num(last.output_tokens),
      cacheReadTokens: cached,
      timestamp: Number.isFinite(timestamp) ? timestamp : null,
    },
  };
}

/** Classifica uma linha do rollout. Retorna null para linhas irrelevantes. NUNCA lança. */
export function parseCodexLine(line: string): CodexLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: RawCodexLine;
  try {
    raw = JSON.parse(trimmed) as RawCodexLine;
  } catch {
    return null;
  }
  const payload = raw.payload;
  if (!payload) return null;
  const meta = parseSessionMeta(raw.type, payload);
  if (meta) return meta;
  if (raw.type === 'turn_context' && typeof payload.model === 'string') {
    return { kind: 'model', model: payload.model };
  }
  return parseTurnStart(raw.type, payload) ?? parseUsage(raw, payload);
}

/**
 * Snapshot serializável do ingestor para resume verificado entre restarts.
 * `usageOrdinal` é o campo crítico: ele compõe o messageId estável, então
 * retomá-lo errado duplicaria eventos no store sob ids diferentes.
 */
export interface CodexIngestSnapshot {
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly cwd: string | null;
  readonly parentThreadId: string | null;
  readonly sessionStartedAt: number | null;
  readonly model: string;
  readonly usageOrdinal: number;
  readonly requiresPhysicalTurnFence: boolean;
  readonly hasPhysicalTurnStarted: boolean;
}

export function isCodexIngestSnapshot(value: unknown): value is CodexIngestSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snap = value as Record<string, unknown>;
  return (
    (snap.sessionId === null || typeof snap.sessionId === 'string') &&
    (snap.threadId === null || typeof snap.threadId === 'string') &&
    (snap.cwd === null || typeof snap.cwd === 'string') &&
    (snap.parentThreadId === null || typeof snap.parentThreadId === 'string') &&
    (snap.sessionStartedAt === null ||
      (typeof snap.sessionStartedAt === 'number' &&
        Number.isFinite(snap.sessionStartedAt))) &&
    typeof snap.model === 'string' &&
    snap.model.length > 0 &&
    Number.isSafeInteger(snap.usageOrdinal) &&
    (snap.usageOrdinal as number) >= 0 &&
    typeof snap.requiresPhysicalTurnFence === 'boolean' &&
    typeof snap.hasPhysicalTurnStarted === 'boolean'
  );
}

/**
 * Ingestor com estado por ARQUIVO: costura session_meta (sessionId/cwd) e
 * turn_context (modelo corrente) nos eventos de uso, produzindo UsageEvent
 * completos para o usage-store. `cwd` fica exposto para o caller decidir a
 * qual workspace o arquivo pertence.
 */
export class CodexFileIngest {
  private sessionId: string | null = null;
  threadId: string | null = null;
  cwd: string | null = null;
  parentThreadId: string | null = null;
  sessionStartedAt: number | null = null;
  private model = 'gpt-5';
  private threadFingerprint: string | null = null;
  private usageOrdinal = 0;
  private requiresPhysicalTurnFence = false;
  private hasPhysicalTurnStarted = true;

  /** Captura o estado para persistência de resume; null = nada atribuível ainda. */
  snapshot(): CodexIngestSnapshot | null {
    if (!this.sessionId) return null;
    return {
      sessionId: this.sessionId,
      threadId: this.threadId,
      cwd: this.cwd,
      parentThreadId: this.parentThreadId,
      sessionStartedAt: this.sessionStartedAt,
      model: this.model,
      usageOrdinal: this.usageOrdinal,
      requiresPhysicalTurnFence: this.requiresPhysicalTurnFence,
      hasPhysicalTurnStarted: this.hasPhysicalTurnStarted,
    };
  }

  /**
   * Restaura um snapshot validado. O fingerprint deriva do threadId, igual ao
   * caminho da primeira session_meta — nunca persistido para não divergir.
   */
  restore(snapshot: CodexIngestSnapshot): void {
    this.sessionId = snapshot.sessionId;
    this.threadId = snapshot.threadId;
    this.threadFingerprint = snapshot.threadId
      ? createHash('sha256').update(snapshot.threadId).digest('hex')
      : null;
    this.cwd = snapshot.cwd;
    this.parentThreadId = snapshot.parentThreadId;
    this.sessionStartedAt = snapshot.sessionStartedAt;
    this.model = snapshot.model;
    this.usageOrdinal = snapshot.usageOrdinal;
    this.requiresPhysicalTurnFence = snapshot.requiresPhysicalTurnFence;
    this.hasPhysicalTurnStarted = snapshot.hasPhysicalTurnStarted;
  }

  /** Processa uma linha; retorna o UsageEvent quando ela fecha um uso. */
  ingestLine(line: string): UsageEvent | null {
    const parsed = parseCodexLine(line);
    if (!parsed) return null;
    switch (parsed.kind) {
      case 'meta':
        return this.acceptMeta(parsed.meta);
      case 'turn-start':
        return this.acceptTurnStart(parsed);
      case 'model':
        if (this.hasPhysicalTurnStarted) this.model = parsed.model;
        return null;
      case 'usage':
        return this.acceptUsage(parsed.usage);
    }
  }

  private acceptMeta(meta: CodexMeta): null {
    // A forked rollout embeds the parent's complete session_meta/history.
    // Only the first session_meta may own this physical file.
    if (this.sessionId) return null;
    this.sessionId = meta.sessionId;
    this.threadId = meta.threadId;
    this.threadFingerprint = createHash('sha256')
      .update(meta.threadId)
      .digest('hex');
    this.cwd = meta.cwd;
    this.parentThreadId = meta.parentThreadId ?? null;
    this.sessionStartedAt = meta.startedAt ?? null;
    this.requiresPhysicalTurnFence =
      this.parentThreadId !== null || meta.sessionId !== meta.threadId;
    this.hasPhysicalTurnStarted = !this.requiresPhysicalTurnFence;
    return null;
  }

  private acceptTurnStart(
    turn: Extract<CodexLine, { kind: 'turn-start' }>,
  ): null {
    if (
      this.requiresPhysicalTurnFence &&
      !this.hasPhysicalTurnStarted &&
      this.isPhysicalTurnStart(turn)
    ) {
      this.hasPhysicalTurnStarted = true;
    }
    return null;
  }

  private acceptUsage(
    usage: Extract<CodexLine, { kind: 'usage' }>['usage'],
  ): UsageEvent | null {
    this.usageOrdinal += 1;
    if (!this.sessionId || !this.threadFingerprint) return null;
    if (!this.hasPhysicalTurnStarted) return null;
    if (
      this.sessionStartedAt !== null &&
      usage.timestamp !== null &&
      usage.timestamp < this.sessionStartedAt
    ) {
      return null;
    }
    return {
      sessionId: this.sessionId,
      messageId: stableCodexUsageMessageId(
        this.threadFingerprint,
        this.usageOrdinal,
        usage.messageId,
      ),
      model: this.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: usage.timestamp,
    };
  }

  private isPhysicalTurnStart(
    turn: Extract<CodexLine, { kind: 'turn-start' }>,
  ): boolean {
    const threadTimestamp = uuidV7Timestamp(this.threadId);
    const turnTimestamp = uuidV7Timestamp(turn.turnId);
    if (threadTimestamp !== null && turnTimestamp !== null) {
      return turnTimestamp >= threadTimestamp;
    }
    if (this.sessionStartedAt === null || turn.startedAt === null) {
      return false;
    }
    // `started_at` is reported in whole seconds by older Codex builds.
    return turn.startedAt >= this.sessionStartedAt - 1_000;
  }
}

function uuidV7Timestamp(value: string | null): number | null {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return null;
  }
  const timestamp = Number.parseInt(value.replaceAll('-', '').slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

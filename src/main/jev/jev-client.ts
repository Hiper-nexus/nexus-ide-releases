import type { JevTestResult } from '../../shared/jev-ipc';
import { resolveJevApiKey } from './jev-secrets';
import { USD_PER_INPUT_TOKEN } from './jev-pricing';
import {
  recordJevNoAnswer,
  type JevDecisionSurface,
  type JevNoAnswerReason,
} from './jev-decision-log';

export { USD_PER_INPUT_TOKEN };

/**
 * Cliente do TypeSafe "System One" (modelo Jev): julgamentos tipados
 * (noul/choice/score) sobre um state. CONTRATO FAIL-OPEN: `judge` nunca lança —
 * sem chave, timeout ou falha da API retornam `null` e o chamador segue com o
 * comportamento atual. Nenhum segredo sai no state (redactState) nem em logs.
 */

const BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 400;
const WARN_INTERVAL_MS = 60_000;

export type JevQuestion =
  | {
      type: 'noul';
      instructions: string;
      criteria?: { true: string; false: string };
    }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | { type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: 'score';
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

interface JevStats {
  calls: number;
  failures: number;
  inputTokens: number;
  estimatedUsd: number;
  skippedNoKey: number;
}

const stats: JevStats = {
  calls: 0,
  failures: 0,
  inputTokens: 0,
  estimatedUsd: 0,
  skippedNoKey: 0,
};

export function getJevStats(): Readonly<JevStats> {
  return { ...stats };
}

export function resetJevStatsForTesting(): void {
  stats.calls = 0;
  stats.failures = 0;
  stats.inputTokens = 0;
  stats.estimatedUsd = 0;
  stats.skippedNoKey = 0;
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xai-[A-Za-z0-9]{16,}/g,
  /gsk_[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /apikey_[A-Za-z0-9_]{20,}/g,
  /xi_[A-Za-z0-9]{16,}/g,
  /hf_[A-Za-z0-9]{16,}/g,
  /npm_[A-Za-z0-9]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ASSIGNMENT_PATTERN =
  /([A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*\s*[=:]\s*)(["']?)([^\s"']+)/g;

/**
 * Variante case-insensitive (camelCase tipo `apiKey:`) que exige um valor com
 * cara de credencial — ≥12 chars do alfabeto de tokens e ao menos um dígito —
 * para não comer prosa ("token: the design token system").
 */
const CI_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd)\s*[=:]\s*)(["']?)([A-Za-z0-9_\-./+=]{12,})/gi;

/** Substitui segredos conhecidos por [REDACTED] antes do state sair do processo. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  out = out.replace(ASSIGNMENT_PATTERN, '$1[REDACTED]');
  return out.replace(CI_ASSIGNMENT_PATTERN, (match, p1: string, _q: string, val: string) =>
    /\d/.test(val) ? `${p1}[REDACTED]` : match,
  );
}

/** Nomes de campo que carregam credencial: o valor inteiro vira [REDACTED]. */
const SENSITIVE_FIELD_PATTERN =
  /api[_-]?key|access[_-]?key|authorization|bearer|token|secret|password|passwd|credential/i;

function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_FIELD_PATTERN.test(key);
}

/** Aplica redactSecrets recursivamente em toda string do state. */
export function redactState(state: unknown): unknown {
  if (typeof state === 'string') return redactSecrets(state);
  if (Array.isArray(state)) return state.map(redactState);
  if (state && typeof state === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
      out[k] = isSensitiveFieldName(k) ? '[REDACTED]' : redactState(v);
    }
    return out;
  }
  return state;
}

/** Trunca texto longo; keepTail preserva o fim (saída de teste, tail de log). */
export function capText(
  text: string,
  maxChars: number,
  opts?: { keepTail?: boolean },
): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return opts?.keepTail
    ? `\n[... ${omitted} chars omitted]${text.slice(omitted)}`
    : `${text.slice(0, maxChars)}\n[... ${omitted} chars omitted]`;
}

let lastWarnAt = 0;

function warnRateLimited(message: string, now: () => number): void {
  const at = now();
  if (at - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = at;
  console.warn(`[jev] ${message}`);
}

export interface JudgeInput {
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
  timeoutMs?: number;
  /** Abort externo (ex.: autoridade MCP revogada) combinado ao timeout. */
  signal?: AbortSignal;
  /**
   * Superfície chamadora — só contabilidade: quando a consulta falha, o
   * diário de decisões grava uma linha `no-answer` (nunca o erro em texto).
   */
  surface?: JevDecisionSurface;
  sessionId?: string;
  missionId?: string;
}

export interface JudgeDeps {
  fetch?: typeof fetch;
  resolveKey?: () => string | undefined;
  now?: () => number;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    const err = rec.error;
    if (typeof rec.message === 'string') return rec.message;
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, unknown>).message as string;
    }
    if (typeof err === 'string') return err;
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 300);
  return `HTTP ${status}`;
}

function isValidResult(data: unknown): data is JevResult {
  return (
    !!data &&
    typeof data === 'object' &&
    !!(data as Record<string, unknown>).answers &&
    typeof (data as Record<string, unknown>).answers === 'object' &&
    !Array.isArray((data as Record<string, unknown>).answers)
  );
}

export async function judge(
  input: JudgeInput,
  deps?: JudgeDeps,
): Promise<JevResult | null> {
  const doFetch = deps?.fetch ?? fetch;
  const key = (deps?.resolveKey ?? resolveJevApiKey)();
  const now = deps?.now ?? Date.now;
  if (!key) {
    stats.skippedNoKey += 1;
    return null;
  }

  const model = input.model ?? process.env.NEXUS_JEV_MODEL ?? DEFAULT_MODEL;
  const body = JSON.stringify({
    state: redactState(input.state),
    model,
    questions: input.questions,
  });

  let lastFailure = 'unknown error';
  let lastReason: JevNoAnswerReason = 'network';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Sinal novo por tentativa: um retry após timeout não pode herdar o
      // AbortSignal já disparado da tentativa anterior.
      const res = await doFetch(`${BASE_URL}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: input.signal
          ? AbortSignal.any([
              AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
              input.signal,
            ])
          : AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (res.ok) {
        if (!isValidResult(data)) {
          lastFailure = 'malformed response body';
          lastReason = 'malformed';
          break;
        }
        stats.calls += 1;
        const inputTokens = data.usage?.input_tokens ?? 0;
        stats.inputTokens += inputTokens;
        stats.estimatedUsd += inputTokens * USD_PER_INPUT_TOKEN;
        return data;
      }
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      lastFailure = `HTTP ${res.status}: ${errorMessage(data, res.status)}`;
      lastReason =
        res.status === 429
          ? 'rate-limited'
          : res.status === 529 || res.status >= 500
            ? 'server-error'
            : res.status >= 400 && res.status < 500
              ? 'client-error'
              : 'network';
      if (retryable && attempt === 0) {
        const retryAfter = Number(res.headers.get('retry-after'));
        // retry-after do servidor é um hint, não uma ordem: teto de 2s
        // evita que um valor absurdo congele a tentativa de retry.
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 2_000)
            : RETRY_DELAY_MS;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : '';
      lastReason = input.signal?.aborted
        ? 'aborted'
        : name === 'AbortError' || name === 'TimeoutError'
          ? 'timeout'
          : 'network';
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
  }
  stats.failures += 1;
  if (input.surface) {
    // Contabilidade central: a consulta falhou e a superfície caiu no caminho
    // determinístico. Só o motivo categórico — nunca o texto do erro.
    recordJevNoAnswer({
      surface: input.surface,
      reason: lastReason,
      model,
      sessionId: input.sessionId,
      missionId: input.missionId,
    });
  }
  warnRateLimited(lastFailure, now);
  return null;
}

export interface TestJevDeps {
  fetch?: typeof fetch;
  resolveKey?: () => string | undefined;
}

/** Teste de conexão iniciado pelo usuário (GET /v1/models). Nunca vaza a chave. */
export async function testJevConnection(deps?: TestJevDeps): Promise<JevTestResult> {
  const doFetch = deps?.fetch ?? fetch;
  const key = (deps?.resolveKey ?? resolveJevApiKey)();
  if (!key) return { ok: false, detail: 'sem chave configurada' };
  try {
    const res = await doFetch(`${BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}: ${errorMessage(data, res.status)}` };
    }
    const models =
      data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).models)
        ? ((data as { models: Array<{ name?: unknown }> }).models)
            .map((m) => (typeof m.name === 'string' ? m.name : ''))
            .filter(Boolean)
        : [];
    return { ok: true, detail: `Conectado — modelos: ${models.join(', ') || 'nenhum'}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

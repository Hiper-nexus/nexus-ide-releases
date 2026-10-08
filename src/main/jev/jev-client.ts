import type { DecisionImage, DecisionRoute } from '../../shared/decision-models';
import { redactState, redactQuestions } from '../decision-models/decision-redaction';
import { judgeDecision, type DecisionJudgeDeps } from '../decision-models/decision-judge';
import { getDecisionAvailability } from '../decision-models/decision-availability';
import { JEV_RESPONSE_POLICY, validateDecisionResponse } from '../decision-models/decision-response';
export { redactSecrets, redactState, capText } from '../decision-models/decision-redaction';
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

/**
 * Instruções estruturadas para a superfície `businessModel`: cada pergunta
 * carrega a regra/fluxo/hurdle tipada em vez de um blob de texto — o julgamento
 * de relevância fica sobre campos nomeados e o state não precisa repetir o
 * candidato inteiro. Texto plano continua aceito pelas demais superfícies.
 */
export interface JevBusinessModelInstructions {
  readonly question: string;
  readonly rule?: { readonly flow: string; readonly text: string };
  readonly flow?: {
    readonly name: string;
    readonly writes?: readonly string[];
    readonly reads?: readonly string[];
  };
  readonly hurdle?: { readonly title: string; readonly summary: string };
}

export type JevQuestionInstructions = string | JevBusinessModelInstructions;

export type JevQuestion =
  | {
      type: 'noul';
      instructions: JevQuestionInstructions;
      criteria?: { true: string; false: string };
    }
  | {
      type: 'choice';
      instructions: JevQuestionInstructions;
      criteria: Record<string, string | null>;
    }
  | { type: 'score'; instructions: JevQuestionInstructions; criteria: string[] };

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
  route?: DecisionRoute;
  durationMs?: number;
  requestCount?: number;
  estimatedUsd?: number;
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  /** O provedor não informou `usage`: `usage` vale zero só para satisfazer o tipo; tokens e custo seguem desconhecidos. */
  usageMissing?: true;
  /** Juntos discordou. Os números por pergunta e provedor não carregam texto. */
  diverged?: boolean;
  ensemblePeers?: Record<string, Record<string, number>>;
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

let lastWarnAt = 0;

function warnRateLimited(message: string, now: () => number): void {
  const at = now();
  if (at - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = at;
  console.warn(`[jev] ${message}`);
}

export interface JudgeInput {
  onUsage?: (receipt: import('../../shared/decision-models').DecisionUsageReceipt) => void;
  /** Imagens validadas: Clef, ou a Luna quando a rota de visão aponta para a Decisions API. */
  images?: readonly DecisionImage[];
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
  /**
   * Chamado uma vez quando a consulta termina sem resposta, com o motivo
   * categórico (o mesmo que vai ao diário). Permite à superfície dizer POR QUE
   * caiu no caminho determinístico sem mudar o retorno `null`.
   */
  onNoAnswer?: (reason: JevNoAnswerReason) => void;
  /**
   * `false` = um timeout encerra na hora (fail-open), sem a 2ª tentativa.
   * Para superfícies auto-on com teto próprio: o retry dobrava o pior caso.
   */
  retryOnTimeout?: boolean;
}

export interface JudgeDeps {
  fetch?: typeof fetch;
  resolveKey?: () => string | undefined;
  now?: () => number;
  getSettings?: DecisionJudgeDeps['getSettings'];
  getConfigurationKey?: DecisionJudgeDeps['getConfigurationKey'];
  getAvailability?: DecisionJudgeDeps['getAvailability'];
  getClefConnection?: DecisionJudgeDeps['getClefConnection'];
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

export async function judgeJevTransport(
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
    // As perguntas também saem do processo: instruções estruturadas carregam
    // texto do repositório (regra, armadilha, fluxo) e recebem a mesma
    // redação do state — segredo colado numa fonte nunca vaza para a API.
    // A chave é identificador: redactQuestions redige valores, não nomes.
    questions: redactQuestions(input.questions),
  });

  let lastFailure = 'unknown error';
  let lastReason: JevNoAnswerReason = 'network';
  let requestCount = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      input.signal?.throwIfAborted();
      requestCount += 1;
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
        const validated = validateDecisionResponse(data, input.questions, JEV_RESPONSE_POLICY);
        if (!validated) {
          lastFailure = 'malformed response body';
          lastReason = 'malformed';
          break;
        }
        stats.calls += 1;
        const inputTokens = validated.usage.input_tokens;
        stats.inputTokens += inputTokens;
        stats.estimatedUsd += inputTokens * USD_PER_INPUT_TOKEN;
        return { ...validated, requestCount };
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
      if (lastReason === 'aborted') break;
      if (lastReason === 'timeout' && input.retryOnTimeout === false) break;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
  }
  stats.failures += 1;
  try {
    input.onNoAnswer?.(lastReason);
  } catch {
    // callback do chamador nunca derruba o contrato fail-open
  }
  if (input.surface) {
    // Contabilidade central: a consulta falhou e a superfície caiu no caminho
    // determinístico. Só o motivo categórico — nunca o texto do erro.
    recordJevNoAnswer({
      surface: input.surface,
      reason: lastReason,
      model,
      provider: 'jev',
      requestCount,
      sessionId: input.sessionId,
      missionId: input.missionId,
    });
  }
  warnRateLimited(lastFailure, now);
  return null;
}

export async function judge(input: JudgeInput, deps?: JudgeDeps): Promise<JevResult | null> {
  return judgeDecision(input, { ...deps, nativeJudge: nativeInput => judgeJevTransport(nativeInput, deps),
    getAvailability: deps?.getAvailability ?? (deps?.resolveKey
      ? () => ({ ...getDecisionAvailability(), jev: Boolean(deps.resolveKey?.()) }) : undefined),
  });
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

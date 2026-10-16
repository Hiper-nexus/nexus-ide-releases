import { LUNA_DECISION_MODEL } from '../../shared/decision-models';
import type { JevTestResult } from '../../shared/jev-ipc';
import type { JudgeInput, JevAnswer, JevQuestion, JevResult } from '../jev/jev-client';
import type { JevNoAnswerReason } from '../jev/jev-decision-log';
import { validateDecisionImages } from './decision-images';
import { decisionResultCostUsd } from './decision-pricing';
import { redactQuestions, redactState } from './decision-redaction';
import { mapLunaResponse, readLunaUsage, toLunaQuestion } from './luna-map';

const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
const MAX_QUESTIONS_PER_REQUEST = 64;
const MAX_BODY_BYTES = 13 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 2;

export interface LunaDeps { fetch?: typeof fetch; now?: () => number }
interface LunaBatch { questions: Record<string, JevQuestion>; ids: ReadonlyMap<string, string>; wire: Record<string, unknown>[] }
class LunaFailure extends Error {
  constructor(readonly reason: JevNoAnswerReason) { super(reason); }
}

function buildBatches(questions: Record<string, JevQuestion>): LunaBatch[] | null {
  const entries = Object.entries(redactQuestions(questions));
  const batches: LunaBatch[] = [];
  for (let offset = 0; offset < entries.length; offset += MAX_QUESTIONS_PER_REQUEST) {
    const slice = entries.slice(offset, offset + MAX_QUESTIONS_PER_REQUEST);
    const ids = new Map(slice.map(([original], index) => [`q${offset + index}`, original]));
    const wire: Record<string, unknown>[] = [];
    const local: Record<string, JevQuestion> = {};
    for (const [index, [original, question]] of slice.entries()) {
      const name = `q${offset + index}`;
      const mapped = toLunaQuestion(name, question);
      if (!mapped) return null;
      wire.push(mapped);
      local[original] = question;
    }
    batches.push({ ids, questions: local, wire });
  }
  return batches;
}

function decisionInput(state: unknown, images: JudgeInput['images']): unknown {
  const redacted = redactState(state);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  if (!images?.length) return text;
  return [{ role: 'user', content: [
    { type: 'input_text', text },
    ...images.map(image => ({ type: 'input_image', image_url: `data:${image.content_type};base64,${image.base64}` })),
  ] }];
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new LunaFailure('malformed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new LunaFailure('malformed'); }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new LunaFailure('malformed');
    throw error;
  } finally { reader.releaseLock(); }
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function failureReason(error: unknown, input: JudgeInput, signal: AbortSignal): JevNoAnswerReason {
  if (input.signal?.aborted) return 'aborted';
  if (signal.aborted) return 'timeout';
  return error instanceof LunaFailure ? error.reason : 'network';
}

function notifyFailure(input: JudgeInput, reason: JevNoAnswerReason): null {
  try { input.onNoAnswer?.(reason); }
  catch { console.warn('[decision-models] no-answer callback failed'); }
  return null;
}

async function requestDecision(body: string, token: string, signal: AbortSignal, doFetch: typeof fetch, countRequest: () => void): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    countRequest();
    const response = await doFetch(DECISIONS_URL, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal });
    signal.throwIfAborted();
    if (response.ok) return readResponse(response);
    await response.body?.cancel();
    const transient = response.status === 429 || response.status >= 500;
    const reason = response.status === 429 ? 'rate-limited' : response.status >= 500 ? 'server-error' : 'client-error';
    if (!transient || attempt + 1 === MAX_ATTEMPTS) throw new LunaFailure(reason);
    const retryAfter = Number(response.headers.get('retry-after'));
    await waitForRetry(Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1_000, MAX_RETRY_DELAY_MS) : RETRY_DELAY_MS, signal);
  }
  throw new LunaFailure('server-error');
}

/** Uma decisão da Decisions API. Timeout não repete: a chamada pode já ter sido cobrada. */
export async function judgeLuna(input: JudgeInput, token: string, deps: LunaDeps = {}): Promise<JevResult | null> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  let signal = input.signal ?? new AbortController().signal;
  let inputTokens = 0;
  let outputTokens = 0;
  let requestCount = 0;
  let measuredBatches = 0;
  try {
    input.signal?.throwIfAborted();
    if (!token.trim() || (input.images !== undefined && !validateDecisionImages(input.images))) throw new LunaFailure('client-error');
    const batches = buildBatches(input.questions);
    if (!batches?.length) throw new LunaFailure('client-error');
    const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const answers = new Map<string, JevAnswer>();
    let usageMissing = false;
    for (const batch of batches) {
      signal.throwIfAborted();
      const body = JSON.stringify({ model: LUNA_DECISION_MODEL, input: decisionInput(input.state, input.images), questions: batch.wire });
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new LunaFailure('client-error');
      const envelope = await requestDecision(body, token, signal, deps.fetch ?? fetch, () => { requestCount++; });
      // A paid response can be refused, unusable or revoked; its valid measurement survives.
      const measurement = readLunaUsage(envelope);
      if (measurement) { inputTokens += measurement.input_tokens; outputTokens += measurement.output_tokens; measuredBatches++; }
      else usageMissing = true;
      signal.throwIfAborted();
      const mapped = mapLunaResponse(envelope, batch.questions, batch.ids);
      if (!mapped.ok) throw new LunaFailure(mapped.reason);
      for (const [id, answer] of Object.entries(mapped.result.answers)) answers.set(id, answer);
    }
    const result: JevResult = { model: LUNA_DECISION_MODEL, answers: Object.fromEntries(answers),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }, requestCount, durationMs: now() - started,
      ...(usageMissing || measuredBatches !== requestCount ? { usageMissing: true as const } : {}) };
    result.usageReceipt = { inputTokens: measuredBatches ? inputTokens : null,
      usd: measuredBatches ? decisionResultCostUsd(result) : null, requestCount, durationMs: result.durationMs!,
      usageIncomplete: measuredBatches !== requestCount };
    return usageMissing || measuredBatches !== requestCount ? result : { ...result, estimatedUsd: decisionResultCostUsd(result) };
  } catch (error) {
    // Antes do primeiro envio o custo é zero medido, não gasto desconhecido.
    const hasMeasurement = measuredBatches > 0 || requestCount === 0;
    try { input.onUsage?.({ inputTokens: hasMeasurement ? inputTokens : null, requestCount, durationMs: now() - started,
      usd: hasMeasurement ? decisionResultCostUsd({ model: LUNA_DECISION_MODEL, answers: {},
        usage: { input_tokens: inputTokens, output_tokens: outputTokens } }) : null,
      usageIncomplete: requestCount > measuredBatches }); }
    catch { console.warn('[decision-models] usage callback failed'); }
    return notifyFailure(input, failureReason(error, input, signal));
  }
}

/** O que o status HTTP da Decisions API diz ao operador. A chave em si nunca entra na mensagem. */
export function lunaStatusDetail(status: number | null, reason: JevNoAnswerReason | null): string {
  if (status === 401) return 'A OpenAI recusou a chave (401). Confira a chave OpenAI em Chaves de API.';
  if (status === 403 || status === 404) return `A chave OpenAI funciona, mas a conta não tem acesso à Decisions API (beta) do gpt-6-luna (${status}). Peça o acesso na OpenAI; enquanto isso o Automático usa Jev e Clef.`;
  if (status === 429) return 'A OpenAI limitou a chave (429): limite de uso ou sem crédito na conta.';
  if (status !== null && status >= 500) return `A Decisions API está com erro no servidor (${status}). Tente de novo mais tarde.`;
  if (status !== null && status >= 400) return `A OpenAI recusou a consulta (${status}). Confira a chave OpenAI em Chaves de API.`;
  if (reason === 'timeout') return 'A OpenAI não respondeu a tempo. Tente de novo.';
  if (reason === 'network') return 'Sem conexão com a OpenAI.';
  return 'A OpenAI não devolveu uma decisão válida. Confira a chave em Chaves de API e a disponibilidade da Decisions API (beta).';
}

export async function testLunaConnection(token: string, deps?: LunaDeps): Promise<JevTestResult> {
  let status: number | null = null;
  let reason: JevNoAnswerReason | null = null;
  const baseFetch = deps?.fetch ?? fetch;
  const result = await judgeLuna({ state: { sample: 'connection-check' }, questions: {
    connection: { type: 'noul', instructions: 'Is sample equal to connection-check?' },
  }, retryOnTimeout: false, onNoAnswer: value => { reason ??= value; } }, token, { ...deps,
    fetch: (async (...args: Parameters<typeof fetch>) => { const response = await baseFetch(...args); status = response.status; return response; }) as typeof fetch });
  return result?.answers.connection?.type === 'noul'
    ? { ok: true, detail: 'Conectado — gpt-6-luna (beta)' }
    : { ok: false, detail: lunaStatusDetail(status !== null && status >= 200 && status < 300 ? null : status, reason) };
}

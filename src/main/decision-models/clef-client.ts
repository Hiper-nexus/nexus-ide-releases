import type { ClefModel } from '../../shared/decision-models';
import type { JevTestResult } from '../../shared/jev-ipc';
import type { JudgeInput, JevQuestion, JevResult, JevAnswer } from '../jev/jev-client';
import type { JevNoAnswerReason } from '../jev/jev-decision-log';
import { decisionUsageSchema, validateDecisionResponse } from './decision-response';
import { redactState, redactQuestions } from './decision-redaction';
import { validateDecisionImages } from './decision-images';
import { decisionResultCostUsd } from './decision-pricing';

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const MAX_QUESTIONS_PER_REQUEST = 64;
const MAX_BODY_BYTES = 13 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 2;

export interface ClefConnection { accountId: string; token: string; model: ClefModel }
export interface ClefDeps { fetch?: typeof fetch; now?: () => number }
interface ClefBatch { questions: Record<string, JevQuestion>; ids: ReadonlyMap<string, string> }
class ClefFailure extends Error {
  constructor(readonly reason: JevNoAnswerReason) { super(reason); }
}

function buildBatches(questions: Record<string, JevQuestion>): ClefBatch[] {
  const entries = Object.entries(redactQuestions(questions));
  const batches: ClefBatch[] = [];
  for (let offset = 0; offset < entries.length; offset += MAX_QUESTIONS_PER_REQUEST) {
    const slice = entries.slice(offset, offset + MAX_QUESTIONS_PER_REQUEST);
    const ids = new Map(slice.map(([original], index) => [`q${offset + index}`, original]));
    batches.push({ ids, questions: Object.fromEntries(slice.map(([, question], index) => [`q${offset + index}`, question])) });
  }
  return batches;
}

function inputIsValid(input: JudgeInput, connection: ClefConnection): boolean {
  if (!/^[a-fA-F0-9]{32}$/.test(connection.accountId) || !connection.token.trim()) return false;
  if (connection.model !== 'clef' && connection.model !== 'clef-flash') return false;
  if (input.images !== undefined && !validateDecisionImages(input.images)) return false;
  const questions = Object.values(input.questions);
  return questions.length > 0 && questions.every(question => {
    if (!question || !question.instructions || !['noul', 'choice', 'score'].includes(question.type)) return false;
    if (question.type === 'score') return question.criteria.length >= 2 && question.criteria.length <= 10;
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      return count >= 2 && count <= 255;
    }
    return true;
  });
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new ClefFailure('malformed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ClefFailure('malformed'); }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ClefFailure('malformed');
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
  return error instanceof ClefFailure ? error.reason : 'network';
}

function notifyFailure(input: JudgeInput, reason: JevNoAnswerReason): null {
  try { input.onNoAnswer?.(reason); }
  catch { console.warn('[decision-models] no-answer callback failed'); }
  return null;
}

async function requestBatch(body: string, connection: ClefConnection, signal: AbortSignal, doFetch: typeof fetch,
  countRequest: () => void): Promise<unknown> {
  const url = `${API_BASE}/${connection.accountId}/ai/run/@cf/cloudflare/${connection.model}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    countRequest();
    const response = await doFetch(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body, signal });
    signal.throwIfAborted();
    if (response.ok) return readResponse(response);
    await response.body?.cancel();
    const transient = response.status === 429 || response.status >= 500;
    const reason = response.status === 429 ? 'rate-limited' : response.status >= 500 ? 'server-error' : 'client-error';
    if (!transient || attempt + 1 === MAX_ATTEMPTS) throw new ClefFailure(reason);
    const retryAfter = Number(response.headers.get('retry-after'));
    await waitForRetry(Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1_000, MAX_RETRY_DELAY_MS) : RETRY_DELAY_MS, signal);
  }
  throw new ClefFailure('server-error');
}

/** One total deadline and one all-or-nothing logical answer across bounded requests. */
export async function judgeClef(input: JudgeInput, connection: ClefConnection, deps: ClefDeps = {}): Promise<JevResult | null> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  let signal = input.signal ?? new AbortController().signal;
  let inputTokens = 0; let outputTokens = 0; let requestCount = 0; let measuredBatches = 0;
  try {
    input.signal?.throwIfAborted();
    if (!inputIsValid(input, connection)) return notifyFailure(input, 'client-error');
    const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const answers = new Map<string, JevAnswer>();
    for (const batch of buildBatches(input.questions)) {
      signal.throwIfAborted();
      const body = JSON.stringify({ model: connection.model, state: redactState(input.state), questions: batch.questions,
        ...(input.images?.length ? { images: input.images } : {}) });
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new ClefFailure('client-error');
      const envelope = await requestBatch(body, connection, signal, deps.fetch ?? fetch, () => { requestCount++; });
      const rawResult = (envelope as { result?: { model?: string; usage?: unknown } })?.result;
      const measured = decisionUsageSchema.safeParse(rawResult?.usage);
      if (typeof rawResult?.model === 'string' && rawResult.model.replace('@cf/cloudflare/', '') === connection.model && measured.success) {
        inputTokens += measured.data.input_tokens; outputTokens += measured.data.output_tokens; measuredBatches++;
      }
      signal.throwIfAborted();
      if (!envelope || typeof envelope !== 'object' || (envelope as Record<string, unknown>).success !== true) throw new ClefFailure('server-error');
      const result = validateDecisionResponse((envelope as Record<string, unknown>).result, batch.questions);
      if (!result || result.model.replace('@cf/cloudflare/', '') !== connection.model) throw new ClefFailure('malformed');
      for (const [id, answer] of Object.entries(result.answers)) answers.set(batch.ids.get(id)!, answer);
    }
    const result: JevResult = { model: connection.model, answers: Object.fromEntries(answers),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }, requestCount, durationMs: now() - started };
    return { ...result, estimatedUsd: decisionResultCostUsd(result) };
  } catch (error) {
    if (requestCount) {
      try { input.onUsage?.({ inputTokens: measuredBatches ? inputTokens : null, requestCount, durationMs: now() - started,
        usd: measuredBatches ? decisionResultCostUsd({ model: connection.model, answers: {}, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }) : null,
        usageIncomplete: requestCount > measuredBatches }); }
      catch { console.warn('[decision-models] usage callback failed'); }
    }
    return notifyFailure(input, failureReason(error, input, signal));
  }
}

export async function testClefConnection(connection: ClefConnection, deps?: ClefDeps): Promise<JevTestResult> {
  const result = await judgeClef({ state: { sample: 'connection-check' }, questions: {
    connection: { type: 'noul', instructions: 'Is sample equal to connection-check?' },
  }, retryOnTimeout: false }, connection, deps);
  return result ? { ok: true, detail: `Conectado — ${result.model}` }
    : { ok: false, detail: 'Cloudflare não devolveu uma decisão válida. Confira a conta, o token e a disponibilidade do Workers AI.' };
}

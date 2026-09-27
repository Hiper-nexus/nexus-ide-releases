/** MiniMax Token Plan quota. Only a user-supplied Subscription Key is sent. */
import type { QuotaWindow, QuotaWindowKind } from '../../shared/quota-types';
import type { FetchLike } from './claude-oauth-usage';
import { knownWindow, unknownWindow } from './quota-normalize';

const URLS = {
  overseas: 'https://www.minimax.io/v1/token_plan/remains',
  cn: 'https://www.minimaxi.com/v1/token_plan/remains',
} as const;

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}

function remainingRatio(percent: unknown, count: unknown, total: unknown): number | null {
  const remaining = typeof percent === 'number' && Number.isFinite(percent)
    ? percent / 100
    : typeof count === 'number' && Number.isFinite(count)
      && typeof total === 'number' && Number.isFinite(total) && total > 0
      ? count / total : null;
  return remaining !== null && remaining >= 0 && remaining <= 1 ? remaining : null;
}

function windowFromPlan(
  item: RecordValue,
  kind: QuotaWindowKind,
  label: string,
  prefix: 'current_interval' | 'current_weekly',
  resetField: 'end_time' | 'weekly_end_time',
  now: number,
): QuotaWindow | null {
  if (item[`${prefix}_status`] === 3) {
    // Unlimited has no denominator, so its used percentage is genuinely unknown.
    return { ...unknownWindow(kind, label), remainingLabel: 'Ilimitado' };
  }
  const remaining = remainingRatio(
    item[`${prefix}_remaining_percent`],
    item[`${prefix}_usage_count`],
    item[`${prefix}_total_count`],
  );
  if (remaining === null) return null;
  const reset = item[resetField];
  return knownWindow({
    kind, label, usedRatio: 1 - remaining,
    source: 'provider-api', confidence: 'high', now,
    resetsAt: typeof reset === 'number' && Number.isSafeInteger(reset) && reset > 0
      ? reset : undefined,
  });
}

export function parseMinimaxTokenPlan(body: unknown, now = Date.now()): QuotaWindow[] {
  const root = object(body);
  if (!root || object(root.base_resp)?.status_code !== 0 || !Array.isArray(root.model_remains)) return [];
  const item = object(root.model_remains[0]);
  if (!item) return [];
  return [
    windowFromPlan(item, 'hours', '5 Horas', 'current_interval', 'end_time', now),
    windowFromPlan(item, 'weekly', 'Semanal', 'current_weekly', 'weekly_end_time', now),
  ].filter((window): window is QuotaWindow => window !== null);
}

type RegionAttempt =
  | { readonly kind: 'ok'; readonly windows: QuotaWindow[] }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'failed' };

async function fetchRegion(
  url: string,
  key: string,
  fetchImpl: FetchLike,
  now: number | undefined,
  timeoutMs: number,
): Promise<RegionAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { kind: 'rejected' };
    if (!response.ok) return { kind: 'failed' };
    const body = await response.json();
    const windows = parseMinimaxTokenPlan(body, now);
    if (windows.length > 0) return { kind: 'ok', windows };
    // A API responde 200 com base_resp de erro quando a chave é de outra região.
    const status = object(object(body)?.base_resp)?.status_code;
    return typeof status === 'number' && status !== 0 ? { kind: 'rejected' } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A Subscription Key vale numa região só. Começa pela preferida (a região do
 * `mcode login`) e, se a chave for recusada ali, tenta a outra uma vez —
 * ambas são endpoints oficiais da MiniMax. Falha de rede ou 5xx não troca.
 */
export async function fetchMinimaxTokenPlan(
  apiKey: string,
  opts?: { fetchImpl?: FetchLike; now?: number; timeoutMs?: number; region?: keyof typeof URLS },
): Promise<QuotaWindow[] | null> {
  const key = apiKey.trim();
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const first = opts?.region ?? 'overseas';
  const order = [first, first === 'overseas' ? 'cn' : 'overseas'] as const;
  for (const region of order) {
    const attempt = await fetchRegion(URLS[region], key, fetchImpl, opts?.now, opts?.timeoutMs ?? 8_000);
    if (attempt.kind === 'ok') return attempt.windows;
    if (attempt.kind === 'failed') return null;
  }
  return null;
}

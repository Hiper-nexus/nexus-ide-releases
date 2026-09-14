/**
 * Z.ai GLM Coding Plan quota probe.
 *
 * GET https://api.z.ai/api/monitor/usage/quota/limit
 * Authorization: <api key>   (NO "Bearer" prefix — Z.ai convention)
 *
 * limits[]:
 *   TOKENS_LIMIT unit=3 number=5 → 5-hour window
 *   TOKENS_LIMIT unit=6 number=1 → weekly window
 *   TIME_LIMIT → MCP monthly (optional credits bar)
 *
 * Never invents percentages on failure.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const GLM_QUOTA_LIMIT_URL =
  'https://api.z.ai/api/monitor/usage/quota/limit';
export const ZHIPU_QUOTA_LIMIT_URL =
  'https://open.bigmodel.cn/api/monitor/usage/quota/limit';

export const GLM_USAGE_TIMEOUT_MS = 8_000;

interface GlmLimitItem {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  /** Total allowance for the window (Z.ai "usage" = the limit itself). */
  usage?: unknown;
  /** Used count so far in this window. */
  currentValue?: unknown;
  /** Limit minus used. */
  remaining?: unknown;
  nextResetTime?: unknown;
}

function percentToRatio(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // Z.ai reports 0–100 percent (incl. 0, 1, 12…). Always /100 so 1 → 1%.
  if (raw < 0) return 0;
  return Math.min(1, raw / 100);
}

/**
 * Exact counts beat the coarse `percentage` field: the community (CodexBar
 * zai.md) documents that when a positive `usage` limit and a
 * `currentValue`/`remaining` count are present, the counts determine the used
 * percentage — `percentage` alone can lag behind real consumption. Returns
 * null when counts are absent or unusable (caller falls back to percentage).
 */
function countsToRatio(limit: GlmLimitItem): number | null {
  const total = limit.usage;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  const used =
    typeof limit.currentValue === 'number' && Number.isFinite(limit.currentValue)
      ? limit.currentValue
      : typeof limit.remaining === 'number' && Number.isFinite(limit.remaining)
        ? total - limit.remaining
        : null;
  if (used === null) return null;
  return Math.max(0, Math.min(1, used / total));
}

function resetAtMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return raw > 1e12 ? raw : raw * 1000;
}

function isFiveHour(limit: GlmLimitItem): boolean {
  return (
    limit.type === 'TOKENS_LIMIT' &&
    limit.unit === 3 &&
    limit.number === 5
  );
}

function isWeekly(limit: GlmLimitItem): boolean {
  return (
    limit.type === 'TOKENS_LIMIT' &&
    limit.unit === 6 &&
    limit.number === 1
  );
}

function isMcpMonthly(limit: GlmLimitItem): boolean {
  return limit.type === 'TIME_LIMIT';
}

/**
 * Parse Z.ai / BigModel quota/limit JSON into quota windows.
 */
export function parseGlmQuotaLimit(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    data?: { limits?: unknown };
    limits?: unknown;
  };
  const limitsRaw = root.data?.limits ?? root.limits;
  if (!Array.isArray(limitsRaw)) return [];

  const out: QuotaWindow[] = [];
  for (const item of limitsRaw) {
    if (!item || typeof item !== 'object') continue;
    const limit = item as GlmLimitItem;
    // Exact counts first (usage/currentValue/remaining); coarse percentage is
    // the fallback when the provider omits counts.
    const ratio = countsToRatio(limit) ?? percentToRatio(limit.percentage);
    if (ratio === null) continue;

    if (isFiveHour(limit)) {
      out.push(
        knownWindow({
          kind: 'hours',
          label: '5 Horas',
          usedRatio: ratio,
          source: 'provider-api',
          confidence: 'high',
          resetsAt: resetAtMs(limit.nextResetTime),
          now,
        }),
      );
      continue;
    }
    if (isWeekly(limit)) {
      out.push(
        knownWindow({
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: ratio,
          source: 'provider-api',
          confidence: 'high',
          resetsAt: resetAtMs(limit.nextResetTime),
          now,
        }),
      );
      continue;
    }
    if (isMcpMonthly(limit)) {
      out.push(
        knownWindow({
          kind: 'monthly',
          label: 'MCP mensal',
          usedRatio: ratio,
          source: 'provider-api',
          confidence: 'medium',
          resetsAt: resetAtMs(limit.nextResetTime),
          now,
        }),
      );
    }
  }
  return out;
}

export async function fetchGlmUsageWindows(
  apiKey: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
    /** Prefer CN BigModel endpoint. */
    platform?: 'zai' | 'zhipu';
  },
): Promise<QuotaWindow[] | null> {
  const key = apiKey?.trim();
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = opts?.timeoutMs ?? GLM_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const url =
    opts?.platform === 'zhipu' ? ZHIPU_QUOTA_LIMIT_URL : GLM_QUOTA_LIMIT_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Z.ai expects the raw key — no "Bearer " prefix.
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: key,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const windows = parseGlmQuotaLimit(body, now);
    return windows.length > 0 ? windows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

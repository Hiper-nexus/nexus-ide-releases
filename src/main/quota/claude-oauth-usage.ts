/**
 * Anthropic Claude Code OAuth usage probe.
 *
 * GET https://api.anthropic.com/api/oauth/usage
 * Authorization: Bearer <oauth access token>
 * anthropic-beta: oauth-2025-04-20
 *
 * Returns authoritative five_hour / seven_day utilization (0–100).
 * Pure parse is unit-tested; network is best-effort and never invents %.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';

export const CLAUDE_OAUTH_USAGE_URL =
  'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

/** Default network timeout for usage probe. */
export const CLAUDE_USAGE_TIMEOUT_MS = 8_000;

interface UsageBucket {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * Extract Claude Code OAuth access token from a credential blob
 * (keychain or vault snapshot JSON).
 */
export function extractClaudeAccessToken(blob: string): string | null {
  if (!blob || typeof blob !== 'string') return null;
  try {
    const parsed = JSON.parse(blob) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) return token;
    return null;
  } catch {
    return null;
  }
}

function utilizationToRatio(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // Anthropic OAuth usage reports percent 0–100 (incl. 0, 1, 2.0, 50…).
  // Always scale by 100 so utilization:1 → 1%, never 100% false positive.
  if (raw < 0) return 0;
  return Math.min(1, raw / 100);
}

function parseResetsAt(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function bucketWindow(
  bucket: UsageBucket | null | undefined,
  kind: 'session' | 'weekly',
  label: string,
  now: number,
): QuotaWindow | null {
  if (!bucket || typeof bucket !== 'object') return null;
  const ratio = utilizationToRatio(bucket.utilization);
  if (ratio === null) return null;
  return knownWindow({
    kind,
    label,
    usedRatio: ratio,
    source: 'provider-api',
    confidence: 'high',
    resetsAt: parseResetsAt(bucket.resets_at),
    now,
  });
}

/**
 * Parse Anthropic OAuth usage JSON into quota windows.
 * Empty array = could not extract any known window (caller keeps unknowns).
 */
export function parseClaudeOauthUsage(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    five_hour?: UsageBucket | null;
    seven_day?: UsageBucket | null;
  };
  const out: QuotaWindow[] = [];
  // five_hour ↔ Claude "Current session" rolling window (limits.kind=session).
  const session = bucketWindow(root.five_hour, 'session', 'Sessão', now);
  if (session) out.push(session);
  const weekly = bucketWindow(root.seven_day, 'weekly', 'Semanal', now);
  if (weekly) out.push(weekly);
  return out;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Fetch live Claude OAuth usage windows. Returns null on any failure
 * (network, auth, parse) so UI stays on honest "—" instead of inventing 0%.
 */
export async function fetchClaudeOauthUsageWindows(
  accessToken: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<QuotaWindow[] | null> {
  const token = accessToken?.trim();
  if (!token) return null;

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = opts?.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const windows = parseClaudeOauthUsage(body, now);
    return windows.length > 0 ? windows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

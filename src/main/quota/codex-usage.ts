/**
 * ChatGPT / Codex subscription usage probe.
 *
 * GET https://chatgpt.com/backend-api/wham/usage
 * Authorization: Bearer <ChatGPT access_token from ~/.codex/auth.json>
 * ChatGPT-Account-ID: <tokens.account_id>
 *
 * Returns primary (and secondary if present) used_percent windows.
 * Never invents percentages on failure.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const CODEX_WHAM_USAGE_URL =
  'https://chatgpt.com/backend-api/wham/usage';

export const CODEX_USAGE_TIMEOUT_MS = 8_000;

export interface CodexChatGptAuth {
  accessToken: string;
  /** ChatGPT-Account-ID header when present. */
  accountId?: string;
}

/**
 * Parse Codex / ChatGPT auth.json (system or vault blob).
 */
export function parseCodexAuthJson(blob: string): CodexChatGptAuth | null {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob) as {
      tokens?: {
        access_token?: unknown;
        account_id?: unknown;
      };
      access_token?: unknown;
      account_id?: unknown;
    };
    const accessToken =
      (typeof parsed.tokens?.access_token === 'string'
        ? parsed.tokens.access_token
        : null) ??
      (typeof parsed.access_token === 'string' ? parsed.access_token : null);
    if (!accessToken) return null;
    const accountId =
      (typeof parsed.tokens?.account_id === 'string'
        ? parsed.tokens.account_id
        : undefined) ??
      (typeof parsed.account_id === 'string' ? parsed.account_id : undefined);
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

interface RateWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
}

function usedPercentToRatio(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // ChatGPT reports 0–100 percent (incl. 0, 1, 6…). Always /100 so 1 → 1%.
  if (raw < 0) return 0;
  return Math.min(1, raw / 100);
}

function resetAtFromWindow(w: RateWindow, now: number): number | undefined {
  if (typeof w.reset_at === 'number' && Number.isFinite(w.reset_at)) {
    // epoch seconds vs ms
    return w.reset_at > 1e12 ? w.reset_at : w.reset_at * 1000;
  }
  if (
    typeof w.reset_after_seconds === 'number' &&
    Number.isFinite(w.reset_after_seconds)
  ) {
    return now + Math.max(0, w.reset_after_seconds) * 1000;
  }
  return undefined;
}

function windowKindFromSeconds(
  seconds: unknown,
): { kind: 'hours' | 'weekly' | 'session'; label: string } {
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    // ~5h rolling
    if (seconds >= 3 * 3600 && seconds <= 6 * 3600) {
      return { kind: 'hours', label: '5 Horas' };
    }
    // ~7d
    if (seconds >= 5 * 86400 && seconds <= 9 * 86400) {
      return { kind: 'weekly', label: 'Semanal' };
    }
    // ~1 day
    if (seconds >= 20 * 3600 && seconds <= 30 * 3600) {
      return { kind: 'session', label: 'Diário' };
    }
  }
  return { kind: 'session', label: 'Sessão' };
}

function mapRateWindow(
  w: RateWindow | null | undefined,
  fallback: { kind: 'hours' | 'weekly' | 'session'; label: string },
  now: number,
): QuotaWindow | null {
  if (!w || typeof w !== 'object') return null;
  const ratio = usedPercentToRatio(w.used_percent);
  if (ratio === null) return null;
  const meta =
    typeof w.limit_window_seconds === 'number'
      ? windowKindFromSeconds(w.limit_window_seconds)
      : fallback;
  return knownWindow({
    kind: meta.kind,
    label: meta.label,
    usedRatio: ratio,
    source: 'provider-api',
    confidence: 'high',
    resetsAt: resetAtFromWindow(w, now),
    now,
  });
}

/**
 * Parse ChatGPT wham/usage JSON into quota windows.
 */
export function parseCodexWhamUsage(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    rate_limit?: {
      primary_window?: RateWindow | null;
      secondary_window?: RateWindow | null;
    } | null;
  };
  const rl = root.rate_limit;
  if (!rl) return [];
  const out: QuotaWindow[] = [];
  const primary = mapRateWindow(
    rl.primary_window,
    { kind: 'weekly', label: 'Semanal' },
    now,
  );
  if (primary) out.push(primary);
  const secondary = mapRateWindow(
    rl.secondary_window,
    { kind: 'hours', label: '5 Horas' },
    now,
  );
  if (secondary) out.push(secondary);
  return out;
}

export async function fetchCodexUsageWindows(
  auth: CodexChatGptAuth,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<QuotaWindow[] | null> {
  const token = auth.accessToken?.trim();
  if (!token) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = opts?.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'nexus-ide-quota-probe',
    };
    if (auth.accountId) {
      headers['ChatGPT-Account-ID'] = auth.accountId;
    }
    const res = await fetchImpl(CODEX_WHAM_USAGE_URL, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const windows = parseCodexWhamUsage(body, now);
    return windows.length > 0 ? windows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

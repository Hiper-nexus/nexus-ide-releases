/**
 * Dispatch live usage probes per adapter. Each probe is best-effort and
 * returns null when credentials or network fail — never invents usedRatio.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import {
  fetchClaudeOauthUsageWindows,
  type FetchLike,
} from './claude-oauth-usage';
import { fetchCodexUsageWindows, type CodexChatGptAuth } from './codex-usage';
import { fetchGlmUsageWindows } from './glm-usage';
import { knownWindow } from './quota-normalize';

export interface LiveUsageAuthResolvers {
  resolveClaudeToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveCodexAuth?: (
    accountId?: string,
  ) => CodexChatGptAuth | null | Promise<CodexChatGptAuth | null>;
  resolveGlmApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGrokToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveKimiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGeminiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveLongcatApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  fetchImpl?: FetchLike;
}

/**
 * Fetch live windows for one adapter row. null = keep local/unknown only.
 */
export async function fetchLiveProviderWindows(
  adapterId: string,
  accountId: string | undefined,
  deps: LiveUsageAuthResolvers,
  now = Date.now(),
): Promise<QuotaWindow[] | null> {
  const fetchImpl = deps.fetchImpl;

  switch (adapterId) {
    case 'claude': {
      if (!deps.resolveClaudeToken) return null;
      const token = await Promise.resolve(deps.resolveClaudeToken(accountId));
      if (!token) return null;
      return fetchClaudeOauthUsageWindows(token, { fetchImpl, now });
    }
    case 'codex': {
      if (!deps.resolveCodexAuth) return null;
      const auth = await Promise.resolve(deps.resolveCodexAuth(accountId));
      if (!auth) return null;
      return fetchCodexUsageWindows(auth, { fetchImpl, now });
    }
    case 'glm': {
      if (!deps.resolveGlmApiKey) return null;
      const key = await Promise.resolve(deps.resolveGlmApiKey(accountId));
      if (!key) return null;
      return fetchGlmUsageWindows(key, { fetchImpl, now });
    }
    case 'longcat': {
      // LongCat has no public quota % API yet. If a key exists we still stay
      // honest (null). Hook reserved for when Meituan exposes usage.
      if (deps.resolveLongcatApiKey) {
        await Promise.resolve(deps.resolveLongcatApiKey(accountId));
      }
      return null;
    }
    case 'grok': {
      // xAI has no public subscription used% endpoint for CLI OAuth (models
      // list works but carries no quota %). Stay honest unless rate-limit hit.
      if (deps.resolveGrokToken) {
        await Promise.resolve(deps.resolveGrokToken(accountId));
      }
      return null;
    }
    case 'kimi': {
      // Token often short-lived; endpoint auth is brittle. Probe best-effort.
      if (!deps.resolveKimiToken) return null;
      const token = await Promise.resolve(deps.resolveKimiToken(accountId));
      if (!token) return null;
      return fetchKimiUsageWindows(token, { fetchImpl, now });
    }
    case 'agy': {
      // AGY/Gemini: no stable public used% for consumer OAuth yet.
      if (deps.resolveGeminiToken) {
        await Promise.resolve(deps.resolveGeminiToken(accountId));
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Best-effort Kimi Coding usage. Returns null on any failure.
 * Endpoint may change; parse is defensive.
 */
export async function fetchKimiUsageWindows(
  accessToken: string,
  opts?: { fetchImpl?: FetchLike; now?: number; timeoutMs?: number },
): Promise<QuotaWindow[] | null> {
  const token = accessToken?.trim();
  if (!token) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const now = opts?.now ?? Date.now();
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const urls = [
    'https://api.kimi.com/coding/v1/usages',
    'https://www.kimi.com/api/usage',
  ];

  try {
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        if (!res.ok) continue;
        const body = await res.json();
        const windows = parseKimiUsage(body, now);
        if (windows.length > 0) return windows;
      } catch {
        // try next url
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Defensive parse for Kimi usage JSON shapes (best-effort). */
export function parseKimiUsage(body: unknown, now = Date.now()): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  // Nested data wrappers
  const data =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;

  const out: QuotaWindow[] = [];

  const tryPercent = (
    raw: unknown,
    kind: 'hours' | 'weekly' | 'session',
    label: string,
  ): void => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
    const ratio = raw > 1 ? Math.min(1, raw / 100) : Math.max(0, Math.min(1, raw));
    out.push(
      knownWindow({
        kind,
        label,
        usedRatio: ratio,
        source: 'provider-api',
        confidence: 'medium',
        now,
      }),
    );
  };

  // Common field names across Moonshot / Kimi coding responses
  for (const [key, kind, label] of [
    ['five_hour_usage_percent', 'hours', '5 Horas'],
    ['five_hour_percent', 'hours', '5 Horas'],
    ['usage_percent_5h', 'hours', '5 Horas'],
    ['weekly_usage_percent', 'weekly', 'Semanal'],
    ['week_percent', 'weekly', 'Semanal'],
    ['usage_percent_7d', 'weekly', 'Semanal'],
  ] as const) {
    if (key in data) tryPercent(data[key], kind, label);
  }

  // Nested rate_limit-like
  const rl = data.rate_limit;
  if (rl && typeof rl === 'object') {
    const r = rl as Record<string, unknown>;
    const primary = r.primary_window;
    if (primary && typeof primary === 'object') {
      const pw = primary as Record<string, unknown>;
      if (typeof pw.used_percent === 'number') {
        tryPercent(pw.used_percent, 'weekly', 'Semanal');
      }
    }
  }

  return out;
}

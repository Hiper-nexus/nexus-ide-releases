/**
 * Grok / xAI usage probe (best-effort).
 *
 * xAI does not currently expose a public used% endpoint for CLI OAuth like
 * Anthropic's /api/oauth/usage. We still try:
 *  1) management-api teams (auth proof + tier metadata)
 *  2) rate-limit style headers on cli-chat-proxy / api.x.ai when present
 *
 * Returns windows only when a numeric used ratio is actually available.
 * Never invents percentages.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const GROK_TEAMS_URL = 'https://management-api.x.ai/auth/teams';
export const GROK_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
export const GROK_USAGE_TIMEOUT_MS = 6_000;

function headerMap(res: {
  headers?: { get?: (name: string) => string | null };
}): Record<string, string> {
  const out: Record<string, string> = {};
  // undici/fetch Headers
  const h = res.headers;
  if (h && typeof h.get === 'function') {
    for (const name of [
      'x-ratelimit-remaining',
      'x-ratelimit-limit',
      'x-ratelimit-reset',
      'x-rate-limit-remaining',
      'x-rate-limit-limit',
      'ratelimit-remaining',
      'ratelimit-limit',
    ]) {
      const v = h.get(name);
      if (v) out[name.toLowerCase()] = v;
    }
  }
  return out;
}

/**
 * Build a session window from remaining/limit headers when both parse as numbers.
 */
export function windowsFromRateLimitHeaders(
  headers: Record<string, string>,
  now = Date.now(),
): QuotaWindow[] {
  const remainingRaw =
    headers['x-ratelimit-remaining'] ??
    headers['x-rate-limit-remaining'] ??
    headers['ratelimit-remaining'];
  const limitRaw =
    headers['x-ratelimit-limit'] ??
    headers['x-rate-limit-limit'] ??
    headers['ratelimit-limit'];
  const remaining = remainingRaw != null ? Number(remainingRaw) : NaN;
  const limit = limitRaw != null ? Number(limitRaw) : NaN;
  if (
    !Number.isFinite(remaining) ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    remaining < 0
  ) {
    return [];
  }
  const used = Math.max(0, Math.min(1, 1 - remaining / limit));
  return [
    knownWindow({
      kind: 'hours',
      label: '5 Horas',
      usedRatio: used,
      source: 'provider-api',
      confidence: 'medium',
      now,
    }),
  ];
}

export async function fetchGrokUsageWindows(
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

  const timeoutMs = opts?.timeoutMs ?? GROK_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'nexus-ide-quota-probe',
    'x-grok-client-version': 'nexus-ide',
    'x-grok-client-surface': 'nexus-ide',
  };

  try {
    // 1) Prove auth + look for any usage fields on teams payload.
    try {
      const teamsRes = await fetchImpl(GROK_TEAMS_URL, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      });
      if (teamsRes.ok) {
        const body = await teamsRes.json();
        const fromBody = parseGrokTeamsUsage(body, now);
        if (fromBody.length > 0) return fromBody;
      }
    } catch {
      // continue
    }

    // 2) Models call — sometimes carries rate-limit headers.
    try {
      const modelsRes = await fetchImpl(GROK_MODELS_URL, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      });
      if (modelsRes.ok) {
        const hdrWindows = windowsFromRateLimitHeaders(
          headerMap(modelsRes as { headers?: { get?: (n: string) => string | null } }),
          now,
        );
        if (hdrWindows.length > 0) return hdrWindows;
      }
    } catch {
      // continue
    }

    // No numeric used% available — honest null (tier alone is not usage).
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Defensive parse if xAI ever embeds used/limit on teams response.
 */
export function parseGrokTeamsUsage(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  // Direct percent fields (future-proof)
  for (const [key, kind, label] of [
    ['used_percent', 'hours', '5 Horas'],
    ['usage_percent', 'hours', '5 Horas'],
    ['five_hour_percent', 'hours', '5 Horas'],
    ['weekly_used_percent', 'weekly', 'Semanal'],
    ['weekly_percent', 'weekly', 'Semanal'],
  ] as const) {
    const raw = root[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const ratio = raw > 1 ? Math.min(1, raw / 100) : Math.max(0, Math.min(1, raw));
      return [
        knownWindow({
          kind,
          label,
          usedRatio: ratio,
          source: 'provider-api',
          confidence: 'medium',
          now,
        }),
      ];
    }
  }
  return [];
}

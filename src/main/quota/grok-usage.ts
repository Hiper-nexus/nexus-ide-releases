/**
 * Grok / xAI usage probe (CLI OAuth).
 *
 * Real endpoint used by the Grok CLI proxy:
 *   GET https://cli-chat-proxy.grok.com/v1/billing
 *   Authorization: Bearer <oauth JWT from ~/.grok/auth.json>
 *
 * Probe with the token already on disk. Never spawn `grok models` / `grok`
 * here — the CLI silently refreshes (and rotates) the user's refresh token.
 *
 * Shape:
 *   config.monthlyLimit.val / config.used.val
 *   config.billingPeriodStart / billingPeriodEnd
 *
 * Also accepts rate-limit headers if present (no paid chat required).
 * Never invents percentages.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow, unknownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
export const GROK_CREDITS_URL = `${GROK_BILLING_URL}?format=credits`;
export const GROK_TEAMS_URL = 'https://management-api.x.ai/auth/teams';
export const GROK_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
export const GROK_USAGE_TIMEOUT_MS = 8_000;

function valNum(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const v = (raw as { val?: unknown }).val;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return null;
}

function parseIsoMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "GrokBuild" → "Grok Build" — o nome no wire é uma palavra só. */
function humanizeProductName(name: string): string {
  let out = '';
  for (const ch of name) {
    if (ch >= 'A' && ch <= 'Z' && out) out += ' ';
    out += ch;
  }
  return out;
}

function creditsConfig(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as { config?: unknown };
  const config =
    root.config && typeof root.config === 'object'
      ? root.config
      : body;
  return typeof config === 'object' && config !== null
    ? (config as Record<string, unknown>)
    : null;
}

/**
 * Parse GET /v1/billing?format=credits — o anel semanal do SuperGrok
 * (mesma leitura do /usage do CLI; ver Codenotch GrokUsage.swift):
 *
 *   config.creditUsagePercent           → percent 0–100
 *   config.productUsage[].usagePercent  → por produto (fallback)
 *   config.currentPeriod WEEKLY + start/end
 *
 * Período semanal fresco sem percent = 0% honesto com resetsAt (o /usage do
 * próprio Grok pinta a barra a 0%). Sem percent E sem período semanal → []
 * (desconhecido a montante; nunca inventar 0%).
 */
export function parseGrokCredits(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  const config = creditsConfig(body);
  if (!config) return [];

  const period =
    config.currentPeriod && typeof config.currentPeriod === 'object'
      ? (config.currentPeriod as Record<string, unknown>)
      : null;
  const isWeekly =
    typeof period?.type === 'string' && period.type.includes('WEEKLY');
  const resetsAt =
    parseIsoMs(period?.end) ?? parseIsoMs(config.billingPeriodEnd);

  const headline = valNum(config.creditUsagePercent);
  if (headline !== null) {
    return [
      knownWindow({
        kind: isWeekly ? 'weekly' : 'credits',
        label: isWeekly ? 'Semanal' : 'Créditos',
        usedRatio: headline / 100,
        source: 'provider-api',
        confidence: 'high',
        resetsAt,
        now,
      }),
    ];
  }

  const products = Array.isArray(config.productUsage)
    ? (config.productUsage as unknown[]).filter(
        (p): p is Record<string, unknown> =>
          !!p && typeof p === 'object',
      )
    : [];
  const out: QuotaWindow[] = [];
  for (const p of products) {
    const percent = valNum(p.usagePercent);
    if (percent === null) continue;
    const name =
      typeof p.product === 'string' && p.product
        ? humanizeProductName(p.product)
        : 'Créditos';
    out.push(
      knownWindow({
        kind: isWeekly ? 'weekly' : 'credits',
        label: isWeekly ? 'Semanal' : name,
        usedRatio: percent / 100,
        source: 'provider-api',
        confidence: 'high',
        resetsAt,
        now,
      }),
    );
    break; // headline único — a janela semanal é uma só
  }
  if (out.length > 0) return out;

  if (isWeekly) {
    return [
      knownWindow({
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: 0,
        source: 'provider-api',
        confidence: 'medium',
        resetsAt,
        now,
      }),
    ];
  }
  return [];
}

/**
 * Parse cli-chat-proxy /v1/billing JSON → quota windows.
 * Monthly spend is the real subscription signal for Grok CLI OAuth.
 */
export function parseGrokBilling(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as { config?: unknown };
  const config =
    root.config && typeof root.config === 'object'
      ? (root.config as Record<string, unknown>)
      : (body as Record<string, unknown>);

  const limit = valNum(config.monthlyLimit ?? config.limit);
  const used = valNum(config.used ?? config.monthlyUsed);
  if (limit === null || used === null || limit <= 0) return [];

  const ratio = Math.max(0, Math.min(1, used / limit));
  const resetsAt = parseIsoMs(config.billingPeriodEnd ?? config.periodEnd);

  // Real monthly window + fleet fleet shell (5h stays unknown unless headers).
  return [
    knownWindow({
      kind: 'monthly',
      label: 'Mensal',
      usedRatio: ratio,
      source: 'provider-api',
      confidence: 'high',
      resetsAt,
      now,
    }),
    // Also map onto "Semanal" slot? No — dishonest. Monthly only.
  ];
}

function headerMap(res: {
  headers?: { get?: (name: string) => string | null };
}): Record<string, string> {
  const out: Record<string, string> = {};
  const h = res.headers;
  if (h && typeof h.get === 'function') {
    for (const name of [
      'x-ratelimit-remaining-requests',
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-remaining',
      'x-ratelimit-limit',
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
 * Build 5h-style window from request rate-limit headers (API RPM, not
 * SuperGrok 5h chat quota — labeled honestly as "RPM API").
 */
export function windowsFromRateLimitHeaders(
  headers: Record<string, string>,
  now = Date.now(),
): QuotaWindow[] {
  const remainingRaw =
    headers['x-ratelimit-remaining-requests'] ??
    headers['x-ratelimit-remaining'] ??
    headers['x-rate-limit-remaining'] ??
    headers['ratelimit-remaining'];
  const limitRaw =
    headers['x-ratelimit-limit-requests'] ??
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
      label: 'RPM API',
      usedRatio: used,
      source: 'provider-api',
      confidence: 'medium',
      now,
    }),
  ];
}

export interface GrokUsageProbe {
  windows: QuotaWindow[] | null;
  /** true quando algum endpoint respondeu 401/403 — grant morto, não rede. */
  authFailed?: boolean;
}

export async function fetchGrokUsageWindows(
  accessToken: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<QuotaWindow[] | null> {
  return (await probeGrokUsageWindows(accessToken, opts)).windows;
}

export async function probeGrokUsageWindows(
  accessToken: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<GrokUsageProbe> {
  const token = accessToken?.trim();
  if (!token) return { windows: null };
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return { windows: null };

  const timeoutMs = opts?.timeoutMs ?? GROK_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'grok-cli/nexus-ide',
    'x-grok-client-version': 'nexus-ide',
    'x-grok-client-surface': 'grok-cli',
  };

  const out: QuotaWindow[] = [];
  let authFailed = false;
  const sawAuthReject = (res: { status?: number } | null | undefined): void => {
    if (res && (res.status === 401 || res.status === 403)) authFailed = true;
  };

  try {
    // 0) Credits (?format=credits) — o anel semanal do SuperGrok. É a única
    // leitura que contas com uso semanal expõem; o /billing cru fica sem
    // monthlyLimit/used para elas. Header dedicado do CLI (Codenotch).
    try {
      const creditsRes = await fetchImpl(GROK_CREDITS_URL, {
        method: 'GET',
        headers: { ...authHeaders, 'X-XAI-Token-Auth': 'xai-grok-cli' },
        signal: controller.signal,
      });
      if (creditsRes.ok) {
        const credits = await creditsRes.json();
        const windows = parseGrokCredits(credits, now);
        if (windows.length > 0) return { windows };
      } else {
        sawAuthReject(creditsRes);
      }
    } catch {
      // continue
    }

    // 1) Primary: CLI billing (monthly included quota).
    try {
      const billRes = await fetchImpl(GROK_BILLING_URL, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      });
      if (billRes.ok) {
        const body = await billRes.json();
        out.push(...parseGrokBilling(body, now));
      } else {
        sawAuthReject(billRes);
      }
    } catch {
      // continue
    }

    // 2) Models — only if rate-limit headers appear (usually they don't).
    try {
      const modelsRes = await fetchImpl(GROK_MODELS_URL, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      });
      if (modelsRes.ok) {
        out.push(
          ...windowsFromRateLimitHeaders(
            headerMap(
              modelsRes as {
                headers?: { get?: (n: string) => string | null };
              },
            ),
            now,
          ),
        );
      } else {
        sawAuthReject(modelsRes);
      }
    } catch {
      // continue
    }

    // 3) Teams auth proof — tier only, no invent %.
    if (out.length === 0) {
      try {
        const teamsRes = await fetchImpl(GROK_TEAMS_URL, {
          method: 'GET',
          headers: authHeaders,
          signal: controller.signal,
        });
        if (teamsRes.ok) {
          const body = await teamsRes.json();
          const tierOnly = parseGrokTeamsUsage(body, now);
          if (tierOnly.length > 0) return { windows: tierOnly };
          // Auth works but no % — leave unknown with note.
          const hours = unknownWindow('hours', '5 Horas');
          const weekly = unknownWindow('weekly', 'Semanal');
          return {
            windows: [
              { ...hours, remainingLabel: 'login OK, sem used%' },
              { ...weekly, remainingLabel: 'login OK, sem used%' },
            ],
          };
        }
        sawAuthReject(teamsRes);
      } catch {
        // fall through
      }
    }

    return {
      windows: out.length > 0 ? out : null,
      ...(authFailed && out.length === 0 ? { authFailed: true } : {}),
    };
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
  for (const [key, kind, label] of [
    ['used_percent', 'hours', '5 Horas'],
    ['usage_percent', 'hours', '5 Horas'],
    ['five_hour_percent', 'hours', '5 Horas'],
    ['weekly_used_percent', 'weekly', 'Semanal'],
    ['weekly_percent', 'weekly', 'Semanal'],
  ] as const) {
    const raw = root[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const ratio = Math.max(0, Math.min(1, raw / 100));
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

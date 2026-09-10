/**
 * Route any raw API key / token by shape to the best live usage probe.
 * Used by OpenCode, Aider, LongCat, and future CLIs that only store keys.
 * Never invents %.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import type { FetchLike } from './claude-oauth-usage';
import { fetchClaudeOauthUsageWindows } from './claude-oauth-usage';
import { fetchGlmUsageWindows } from './glm-usage';
import { fetchKimiCodingUsageWindows } from './kimi-usage';
import { fetchGrokUsageWindows } from './grok-usage';
import { knownWindow } from './quota-normalize';

export type KeyShape =
  | 'claude-oauth'
  | 'anthropic-api'
  | 'openai'
  | 'xai'
  | 'kimi-coding'
  | 'zai'
  | 'longcat'
  | 'unknown';

export function classifyKeyShape(key: string): KeyShape {
  const k = key.trim();
  if (!k) return 'unknown';
  if (k.startsWith('sk-ant-oat') || k.startsWith('sk-ant-sid')) {
    return 'claude-oauth';
  }
  if (k.startsWith('sk-ant-')) return 'anthropic-api';
  if (k.startsWith('sk-kimi-') || k.startsWith('sk-kimicode-')) {
    return 'kimi-coding';
  }
  if (k.startsWith('xai-')) return 'xai';
  if (k.startsWith('sk-proj-') || k.startsWith('sk-svcacct-')) return 'openai';
  return 'unknown';
}

type QuotaProvider = 'claude' | 'kimi' | 'grok' | 'glm' | 'longcat';
const DECLARED_PROVIDERS = new Map<string, QuotaProvider>([
  ['claude', 'claude'], ['anthropic', 'claude'],
  ['kimi', 'kimi'], ['kimi-for-coding', 'kimi'], ['moonshotai', 'kimi'],
  ['grok', 'grok'], ['xai', 'grok'],
  ['glm', 'glm'], ['glm-flash', 'glm'], ['zai', 'glm'], ['zai-coding-plan', 'glm'], ['zhipu', 'glm'],
  ['longcat', 'longcat'],
]);

function prefixProvider(shape: KeyShape): QuotaProvider | 'openai' | null {
  if (shape === 'claude-oauth' || shape === 'anthropic-api') return 'claude';
  if (shape === 'kimi-coding') return 'kimi';
  if (shape === 'xai') return 'grok';
  return shape === 'openai' ? 'openai' : null;
}

/**
 * Probe only the configured provider. Prefixes may reject mismatches, never
 * authorize a destination. Unverified JWTs require a provider-native resolver.
 * Failure never sends the credential to another vendor.
 */
export async function fetchWindowsForApiKey(
  key: string,
  opts?: {
    fetchImpl?: FetchLike;
    now?: number;
    /** Hint adapter for longcat/glm base routing. */
    adapterHint?: string;
  },
): Promise<QuotaWindow[] | null> {
  const token = key?.trim();
  if (!token) return null;
  const fetchImpl = opts?.fetchImpl;
  const now = opts?.now ?? Date.now();
  const hint = opts?.adapterHint;
  const provider = hint ? DECLARED_PROVIDERS.get(hint) : undefined;
  const shape = classifyKeyShape(token);
  const prefix = prefixProvider(shape);
  if (!provider || (prefix && prefix !== provider) || token.startsWith('eyJ')) return null;
  switch (provider) {
    case 'claude': return shape === 'claude-oauth'
      ? fetchClaudeOauthUsageWindows(token, { fetchImpl, now }) : null;
    case 'kimi': return fetchKimiCodingUsageWindows(token, { fetchImpl, now });
    case 'grok': return fetchGrokUsageWindows(token, { fetchImpl, now });
    case 'longcat': return fetchLongcatUsageWindows(token, { fetchImpl, now });
    case 'glm': return fetchGlmUsageWindows(token, { fetchImpl, now, platform: hint === 'zhipu' ? 'zhipu' : 'zai' });
  }
}

/**
 * Best-effort LongCat usage. Tries a few documented/compat endpoints.
 */
export async function fetchLongcatUsageWindows(
  apiKey: string,
  opts?: { fetchImpl?: FetchLike; now?: number; timeoutMs?: number },
): Promise<QuotaWindow[] | null> {
  const key = apiKey?.trim();
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const now = opts?.now ?? Date.now();
  const timeoutMs = opts?.timeoutMs ?? 6_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const urls = [
    'https://api.longcat.chat/v1/usage',
    'https://api.longcat.chat/anthropic/v1/usage',
    'https://api.longcat.chat/v1/dashboard/billing/usage',
  ];

  try {
    for (const url of urls) {
      for (const authHeader of [
        `Bearer ${key}`,
        key,
      ]) {
        try {
          const res = await fetchImpl(url, {
            method: 'GET',
            headers: {
              Authorization: authHeader,
              'x-api-key': key,
              Accept: 'application/json',
              'anthropic-version': '2023-06-01',
            },
            signal: controller.signal,
          });
          if (!res.ok) continue;
          const body = await res.json();
          const windows = parseGenericUsageJson(body, now);
          if (windows.length > 0) return windows;
        } catch {
          // next
        }
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Defensive parse for generic usage JSON (percent / used+limit). */
export function parseGenericUsageJson(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  const out: QuotaWindow[] = [];

  const tryRatio = (
    raw: unknown,
    kind: 'hours' | 'weekly' | 'session',
    label: string,
  ): void => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
    const ratio = Math.max(0, Math.min(1, raw / 100));
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

  for (const [key, kind, label] of [
    ['five_hour_percent', 'hours', '5 Horas'],
    ['five_hour_usage_percent', 'hours', '5 Horas'],
    ['used_percent', 'hours', '5 Horas'],
    ['usage_percent', 'hours', '5 Horas'],
    ['weekly_percent', 'weekly', 'Semanal'],
    ['weekly_usage_percent', 'weekly', 'Semanal'],
  ] as const) {
    if (key in root) tryRatio(root[key], kind, label);
  }

  // used + limit → 5h slot (fleet default when window type unknown)
  const used = root.used ?? root.usage;
  const limit = root.limit ?? root.quota;
  if (
    typeof used === 'number' &&
    typeof limit === 'number' &&
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    limit > 0
  ) {
    out.push(
      knownWindow({
        kind: 'hours',
        label: '5 Horas',
        usedRatio: Math.max(0, Math.min(1, used / limit)),
        source: 'provider-api',
        confidence: 'medium',
        now,
      }),
    );
  }

  return out;
}

/**
 * Merge multiple provider window sets for multi-key CLIs (OpenCode/Aider):
 * keep worst usedRatio per kind.
 */
export function mergeWorstWindows(
  sets: readonly (readonly QuotaWindow[])[],
): QuotaWindow[] {
  const byKind = new Map<string, QuotaWindow>();
  for (const set of sets) {
    for (const w of set) {
      if (w.usedRatio === null) continue;
      const key = `${w.kind}:${w.label}`;
      const prev = byKind.get(key);
      if (!prev || (prev.usedRatio ?? -1) < w.usedRatio) {
        byKind.set(key, w);
      }
    }
  }
  return [...byKind.values()];
}

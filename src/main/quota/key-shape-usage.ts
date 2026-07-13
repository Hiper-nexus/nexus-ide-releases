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
import {
  fetchCodexUsageWindows,
  parseCodexAuthJson,
} from './codex-usage';
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
  if (k.startsWith('xai-') || (k.startsWith('eyJ') && k.length > 100)) {
    // JWT often used by grok OAuth; xai- prefix for API keys
    if (k.startsWith('eyJ')) return 'xai';
    return 'xai';
  }
  if (k.startsWith('sk-') && k.length >= 10) return 'openai';
  // Z.ai coding keys are often hex-ish without sk- prefix (e.g. 43b72c…)
  if (/^[a-f0-9]{32,64}$/i.test(k)) return 'zai';
  // LongCat / Meituan often opaque long tokens
  if (k.length >= 20) return 'unknown';
  return 'unknown';
}

/**
 * Probe a single key against all known usage APIs that match its shape
 * (and a few best-effort fallbacks for unknown shapes).
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
  const shape = classifyKeyShape(token);
  const hint = opts?.adapterHint;

  // Shape-specific first
  if (shape === 'claude-oauth') {
    const w = await fetchClaudeOauthUsageWindows(token, { fetchImpl, now });
    if (w?.length) return w;
  }
  if (shape === 'kimi-coding' || hint === 'kimi') {
    const w = await fetchKimiCodingUsageWindows(token, { fetchImpl, now });
    if (w?.length) return w;
  }
  if (shape === 'xai' || hint === 'grok') {
    const w = await fetchGrokUsageWindows(token, { fetchImpl, now });
    if (w?.length) return w;
  }
  if (shape === 'zai' || hint === 'glm') {
    for (const platform of ['zai', 'zhipu'] as const) {
      const w = await fetchGlmUsageWindows(token, {
        fetchImpl,
        now,
        platform,
      });
      if (w?.length) return w;
    }
  }

  // Adapter-hinted: longcat tries GLM monitor then longcat URLs
  if (hint === 'longcat' || shape === 'longcat') {
    const lc = await fetchLongcatUsageWindows(token, { fetchImpl, now });
    if (lc?.length) return lc;
    // Some users put Z.ai keys under longcat by mistake — try glm too
    for (const platform of ['zai', 'zhipu'] as const) {
      const w = await fetchGlmUsageWindows(token, {
        fetchImpl,
        now,
        platform,
      });
      if (w?.length) return w;
    }
  }

  // OpenAI-shaped: no reliable used% without org billing key — skip invent.
  // Unknown / anthropic-api: try GLM monitor (works for many coding plan keys)
  // then longcat then kimi.
  if (shape === 'unknown' || shape === 'anthropic-api' || shape === 'zai') {
    for (const platform of ['zai', 'zhipu'] as const) {
      const w = await fetchGlmUsageWindows(token, {
        fetchImpl,
        now,
        platform,
      });
      if (w?.length) return w;
    }
    const lc = await fetchLongcatUsageWindows(token, { fetchImpl, now });
    if (lc?.length) return lc;
    const kimi = await fetchKimiCodingUsageWindows(token, { fetchImpl, now });
    if (kimi?.length) return kimi;
  }

  // OpenAI key that is actually a full auth.json blob
  if (token.startsWith('{')) {
    const auth = parseCodexAuthJson(token);
    if (auth) {
      const w = await fetchCodexUsageWindows(auth, { fetchImpl, now });
      if (w?.length) return w;
    }
  }

  return null;
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
    const ratio =
      raw > 1 ? Math.min(1, raw / 100) : Math.max(0, Math.min(1, raw));
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
    ['used_percent', 'session', 'Sessão'],
    ['usage_percent', 'session', 'Sessão'],
    ['weekly_percent', 'weekly', 'Semanal'],
    ['weekly_usage_percent', 'weekly', 'Semanal'],
  ] as const) {
    if (key in root) tryRatio(root[key], kind, label);
  }

  // used + limit
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
        kind: 'session',
        label: 'Sessão',
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

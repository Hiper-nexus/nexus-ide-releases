/**
 * Dispatch live usage probes per adapter. Each probe is best-effort and
 * returns null when credentials or network fail — never invents usedRatio.
 *
 * Tries multiple credential candidates (vault / launcher / system CLI) so a
 * single stale key cannot hide real telemetry.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import {
  fetchClaudeOauthUsageWindows,
  type FetchLike,
} from './claude-oauth-usage';
import {
  fetchCodexUsageWindows,
  type CodexChatGptAuth,
} from './codex-usage';
import { fetchGlmUsageWindows } from './glm-usage';
import { fetchGrokUsageWindows } from './grok-usage';
import { fetchAgyUsageWindows, type GeminiOauthCreds } from './agy-usage';
import { fetchKimiCodingUsageWindows } from './kimi-usage';
import {
  fetchWindowsForApiKey,
  mergeWorstWindows,
} from './key-shape-usage';
import { loadOpenCodeAuthKeys } from './opencode-auth';
import { knownWindow } from './quota-normalize';

export interface LiveUsageAuthResolvers {
  resolveClaudeToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  /** Prefer multi-candidate; single still supported. */
  resolveCodexAuth?: (
    accountId?: string,
  ) => CodexChatGptAuth | null | Promise<CodexChatGptAuth | null>;
  resolveCodexAuthCandidates?: (
    accountId?: string,
  ) => CodexChatGptAuth[] | Promise<CodexChatGptAuth[]>;
  resolveGlmApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGlmApiKeyCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveGrokToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGrokTokenCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveKimiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveKimiTokenCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveGeminiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  /** Full Gemini/AGY OAuth (access + refresh) for live quota. */
  resolveGeminiOauthCreds?: (
    accountId?: string,
  ) => GeminiOauthCreds | null | Promise<GeminiOauthCreds | null>;
  resolveLongcatApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveLongcatApiKeyCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  /** Generic vault/launcher/env keys for any adapter (opencode, aider, …). */
  resolveGenericApiKeyCandidates?: (
    adapterId: string,
    accountId?: string,
  ) => string[] | Promise<string[]>;
  fetchImpl?: FetchLike;
}

async function stringCandidates(
  multi:
    | ((accountId?: string) => string[] | Promise<string[]>)
    | undefined,
  single:
    | ((accountId?: string) => string | null | Promise<string | null>)
    | undefined,
  accountId?: string,
): Promise<string[]> {
  if (multi) {
    const list = await Promise.resolve(multi(accountId));
    return (list ?? []).filter((x) => typeof x === 'string' && x.trim());
  }
  if (single) {
    const one = await Promise.resolve(single(accountId));
    return one?.trim() ? [one.trim()] : [];
  }
  return [];
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
      let candidates: CodexChatGptAuth[] = [];
      if (deps.resolveCodexAuthCandidates) {
        candidates = await Promise.resolve(
          deps.resolveCodexAuthCandidates(accountId),
        );
      } else if (deps.resolveCodexAuth) {
        const one = await Promise.resolve(deps.resolveCodexAuth(accountId));
        if (one) candidates = [one];
      }
      for (const auth of candidates) {
        const windows = await fetchCodexUsageWindows(auth, { fetchImpl, now });
        if (windows && windows.length > 0) return windows;
      }
      return null;
    }
    case 'glm': {
      const keys = await stringCandidates(
        deps.resolveGlmApiKeyCandidates,
        deps.resolveGlmApiKey,
        accountId,
      );
      for (const key of keys) {
        // Global Z.ai first, then CN BigModel.
        for (const platform of ['zai', 'zhipu'] as const) {
          const windows = await fetchGlmUsageWindows(key, {
            fetchImpl,
            now,
            platform,
          });
          if (windows && windows.length > 0) return windows;
        }
      }
      return null;
    }
    case 'longcat': {
      const keys = await stringCandidates(
        deps.resolveLongcatApiKeyCandidates,
        deps.resolveLongcatApiKey,
        accountId,
      );
      for (const key of keys) {
        const w = await fetchWindowsForApiKey(key, {
          fetchImpl,
          now,
          adapterHint: 'longcat',
        });
        if (w?.length) return w;
      }
      return null;
    }
    case 'grok': {
      const tokens = await stringCandidates(
        deps.resolveGrokTokenCandidates,
        deps.resolveGrokToken,
        accountId,
      );
      for (const token of tokens) {
        const windows = await fetchGrokUsageWindows(token, { fetchImpl, now });
        if (windows && windows.length > 0) return windows;
      }
      return null;
    }
    case 'kimi': {
      const tokens = await stringCandidates(
        deps.resolveKimiTokenCandidates,
        deps.resolveKimiToken,
        accountId,
      );
      for (const token of tokens) {
        // Coding Plan API key (sk-kimi-…) first — authoritative usages.
        const coding = await fetchKimiCodingUsageWindows(token, {
          fetchImpl,
          now,
        });
        if (coding && coding.length > 0) return coding;
        // OAuth / alternate shapes
        const windows = await fetchKimiUsageWindows(token, { fetchImpl, now });
        if (windows && windows.length > 0) return windows;
      }
      return null;
    }
    case 'agy': {
      let creds: GeminiOauthCreds | null = null;
      if (deps.resolveGeminiOauthCreds) {
        creds = await Promise.resolve(deps.resolveGeminiOauthCreds(accountId));
      } else if (deps.resolveGeminiToken) {
        const access = await Promise.resolve(deps.resolveGeminiToken(accountId));
        if (access) creds = { accessToken: access };
      }
      if (!creds) return null;
      return fetchAgyUsageWindows(creds, { fetchImpl, now });
    }
    case 'opencode': {
      return fetchOpenCodeFleetWindows(deps, accountId, fetchImpl, now);
    }
    case 'aider': {
      // Aider is multi-provider: try every stored key (Anthropic/OpenAI/…).
      return fetchMultiKeyWindows(
        'aider',
        deps,
        accountId,
        fetchImpl,
        now,
      );
    }
    default: {
      // Any future / custom CLI: generic vault+launcher key routing.
      return fetchMultiKeyWindows(
        adapterId,
        deps,
        accountId,
        fetchImpl,
        now,
      );
    }
  }
}

async function fetchMultiKeyWindows(
  adapterId: string,
  deps: LiveUsageAuthResolvers,
  accountId: string | undefined,
  fetchImpl: FetchLike | undefined,
  now: number,
): Promise<QuotaWindow[] | null> {
  const keys: string[] = [];
  if (deps.resolveGenericApiKeyCandidates) {
    const list = await Promise.resolve(
      deps.resolveGenericApiKeyCandidates(adapterId, accountId),
    );
    for (const k of list ?? []) {
      if (k?.trim() && !keys.includes(k.trim())) keys.push(k.trim());
    }
  }
  // Also try adapter-specific resolvers when present
  if (adapterId === 'longcat') {
    for (const k of await stringCandidates(
      deps.resolveLongcatApiKeyCandidates,
      deps.resolveLongcatApiKey,
      accountId,
    )) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  if (keys.length === 0) return null;
  const sets: QuotaWindow[][] = [];
  for (const key of keys) {
    const w = await fetchWindowsForApiKey(key, {
      fetchImpl,
      now,
      adapterHint: adapterId,
    });
    if (w?.length) sets.push(w);
  }
  if (sets.length === 0) return null;
  const merged = mergeWorstWindows(sets);
  return merged.length > 0 ? merged : null;
}

async function fetchOpenCodeFleetWindows(
  deps: LiveUsageAuthResolvers,
  accountId: string | undefined,
  fetchImpl: FetchLike | undefined,
  now: number,
): Promise<QuotaWindow[] | null> {
  const keys: string[] = [];
  // 1) OpenCode auth.json (all providers the user connected)
  for (const e of loadOpenCodeAuthKeys()) {
    if (!keys.includes(e.key)) keys.push(e.key);
  }
  // 2) Vault / launcher / env for opencode + common upstreams
  if (deps.resolveGenericApiKeyCandidates) {
    for (const id of ['opencode', 'anthropic', 'openai', 'glm', 'kimi', 'grok']) {
      const list = await Promise.resolve(
        deps.resolveGenericApiKeyCandidates(id, accountId),
      );
      for (const k of list ?? []) {
        if (k?.trim() && !keys.includes(k.trim())) keys.push(k.trim());
      }
    }
  }
  if (keys.length === 0) return null;
  const sets: QuotaWindow[][] = [];
  for (const key of keys) {
    const w = await fetchWindowsForApiKey(key, { fetchImpl, now });
    if (w?.length) sets.push(w);
  }
  if (sets.length === 0) return null;
  const merged = mergeWorstWindows(sets);
  return merged.length > 0 ? merged : null;
}

/**
 * Best-effort Kimi Coding usage. Returns null on any failure.
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
  const timeoutMs = opts?.timeoutMs ?? 5_000;
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
        // try next
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseKimiUsage(body: unknown, now = Date.now()): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
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
    ['five_hour_usage_percent', 'hours', '5 Horas'],
    ['five_hour_percent', 'hours', '5 Horas'],
    ['usage_percent_5h', 'hours', '5 Horas'],
    ['weekly_usage_percent', 'weekly', 'Semanal'],
    ['week_percent', 'weekly', 'Semanal'],
    ['usage_percent_7d', 'weekly', 'Semanal'],
  ] as const) {
    if (key in data) tryPercent(data[key], kind, label);
  }

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

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
import { fetchMinimaxTokenPlan } from './minimax-code-usage';
import { minimaxCodeSignedInRegion } from '../adapters/minimax-code-auth';
import { probeAlibabaTokenPlanUsage } from './alibaba-token-plan-usage';
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

type QuotaProvider = 'claude' | 'kimi' | 'grok' | 'glm' | 'longcat' | 'minimax-code' | 'alibaba-token-plan';
const DECLARED_PROVIDERS = new Map<string, QuotaProvider>([
  ['claude', 'claude'], ['anthropic', 'claude'],
  ['kimi', 'kimi'], ['kimi-for-coding', 'kimi'], ['moonshotai', 'kimi'],
  ['grok', 'grok'], ['xai', 'grok'],
  ['glm', 'glm'], ['glm-flash', 'glm'], ['zai', 'glm'], ['zai-coding-plan', 'glm'], ['zhipu', 'glm'],
  ['longcat', 'longcat'],
  // F-1417: OpenClaude (fork do Claude Code) usa o mesmo OAuth `sk-ant-oat`.
  ['openclaude', 'claude'],
  ['minimax-code', 'minimax-code'],
  // Um Token Plan Alibaba = um Credits pool: Qwen Code, DeepSeek (rota
  // token-plan) e GLM no mesmo `BAILIAN_TOKEN_PLAN_API_KEY` / `sk-sp-`.
  ['qwen', 'alibaba-token-plan'], ['dashscope', 'alibaba-token-plan'],
  ['bailian', 'alibaba-token-plan'], ['deepseek-token-plan', 'alibaba-token-plan'],
  ['alibaba-token-plan', 'alibaba-token-plan'],
]);

function prefixProvider(shape: KeyShape): QuotaProvider | 'openai' | null {
  if (shape === 'claude-oauth' || shape === 'anthropic-api') return 'claude';
  if (shape === 'kimi-coding') return 'kimi';
  if (shape === 'xai') return 'grok';
  return shape === 'openai' ? 'openai' : null;
}

/**
 * F-1416/F-1417: Alibaba Model Studio Token Plan key (`sk-sp-`). A GLM row
 * carrying this key draws on the shared Token Plan pool, not on z.ai.
 */
export function isAlibabaTokenPlanKey(key: string): boolean {
  return key.trim().startsWith('sk-sp-');
}

/**
 * F-1417: the Token Plan percentage comes from the machine's console session
 * (`bl`), never from the inference key. Every row whose number came from that
 * session shares this credential identity, so the rows collapse into one pool
 * without labelling the session's number with the inference key's HMAC.
 */
export const ALIBABA_TOKEN_PLAN_SESSION_CREDENTIAL = 'alibaba-token-plan:console-session';

export interface KeyUsageProbe {
  windows: QuotaWindow[] | null;
  /**
   * Set when the windows were read from a shared machine session instead of
   * from this key. Callers tag the row with this identity, not the key.
   */
  sessionCredential?: string;
  /** The quota source rejected its credential (console/`bl` session). */
  authFailed?: boolean;
}

/**
 * Probe only the configured provider. Prefixes may reject mismatches, never
 * authorize a destination. Unverified JWTs require a provider-native resolver.
 * Failure never sends the credential to another vendor.
 */
export async function probeWindowsForApiKey(
  key: string,
  opts?: {
    fetchImpl?: FetchLike;
    now?: number;
    /** Hint adapter for longcat/glm base routing. */
    adapterHint?: string;
  },
): Promise<KeyUsageProbe> {
  const token = key?.trim();
  if (!token) return { windows: null };
  const fetchImpl = opts?.fetchImpl;
  const now = opts?.now ?? Date.now();
  const hint = opts?.adapterHint;
  let provider = hint ? DECLARED_PROVIDERS.get(hint) : undefined;
  const shape = classifyKeyShape(token);
  const prefix = prefixProvider(shape);
  if (!provider || (prefix && prefix !== provider) || token.startsWith('eyJ')) return { windows: null };
  // A GLM row on a Token Plan key belongs to the shared Token Plan pool; a
  // z.ai key keeps reading z.ai. The key never goes to the other vendor.
  if (provider === 'glm' && isAlibabaTokenPlanKey(token)) provider = 'alibaba-token-plan';
  const only = async (windows: Promise<QuotaWindow[] | null>): Promise<KeyUsageProbe> => ({ windows: await windows });
  switch (provider) {
    case 'claude': return shape === 'claude-oauth'
      ? only(fetchClaudeOauthUsageWindows(token, { fetchImpl, now })) : { windows: null };
    case 'kimi': return only(fetchKimiCodingUsageWindows(token, { fetchImpl, now }));
    case 'grok': return only(fetchGrokUsageWindows(token, { fetchImpl, now }));
    case 'longcat': return only(fetchLongcatUsageWindows(token, { fetchImpl, now }));
    case 'glm': return only(fetchGlmUsageWindows(token, { fetchImpl, now, platform: hint === 'zhipu' ? 'zhipu' : 'zai' }));
    case 'minimax-code': return only(fetchMinimaxTokenPlan(token, {
      fetchImpl, now, region: minimaxCodeSignedInRegion() === 'cn' ? 'cn' : 'overseas',
    }));
    case 'alibaba-token-plan': {
      // A chave de inferência (`sk-sp-`) não lê cota: o usage vem da sessão
      // de console da máquina (`bl`). Nada prova que essa sessão é do plano
      // desta chave — confiança baixa (não alimenta a folga como cota
      // medida) e identidade da sessão, não da chave.
      const probe = await probeAlibabaTokenPlanUsage({ fetchImpl, now, skipCli: false });
      const windows = probe.windows?.length
        ? probe.windows.map((window) => ({ ...window, confidence: 'low' as const }))
        : null;
      return {
        windows,
        ...(windows ? { sessionCredential: ALIBABA_TOKEN_PLAN_SESSION_CREDENTIAL } : {}),
        ...(probe.authFailed ? { authFailed: true } : {}),
      };
    }
  }
}

/** Windows only (legacy callers). Prefer `probeWindowsForApiKey`. */
export async function fetchWindowsForApiKey(
  key: string,
  opts?: { fetchImpl?: FetchLike; now?: number; adapterHint?: string },
): Promise<QuotaWindow[] | null> {
  return (await probeWindowsForApiKey(key, opts)).windows;
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

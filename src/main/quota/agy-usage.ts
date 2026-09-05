/**
 * AGY / Gemini Code Assist quota probe.
 *
 * 1) Refresh Google OAuth access token (public gemini-cli client credentials).
 * 2) POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 *    buckets[].remainingFraction (1 = unused, 0 = exhausted)
 *
 * Never invents percentages.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow, unknownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

/** Public OAuth client embedded in @google/gemini-cli (same pattern as CLI). */
export const GEMINI_OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GEMINI_OAUTH_CLIENT_SECRET =
  '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';

export const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AGY_RETRIEVE_USER_QUOTA_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
export const AGY_LOAD_CODE_ASSIST_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

export const AGY_USAGE_TIMEOUT_MS = 10_000;

export interface GeminiOauthCreds {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms expiry (gemini oauth_creds.json). */
  expiryDate?: number;
}

export function parseGeminiOauthCredsJson(blob: string): GeminiOauthCreds | null {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expiry_date?: unknown;
    };
    const accessToken =
      typeof parsed.access_token === 'string' ? parsed.access_token : undefined;
    const refreshToken =
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined;
    const expiryDate =
      typeof parsed.expiry_date === 'number' ? parsed.expiry_date : undefined;
    if (!accessToken && !refreshToken) return null;
    return { accessToken, refreshToken, expiryDate };
  } catch {
    return null;
  }
}

/**
 * Map retrieveUserQuota JSON → windows.
 * remainingFraction 1 → used 0%; remainingFraction 0 → used 100%.
 */
export function parseAgyUserQuota(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as { buckets?: unknown };
  if (!Array.isArray(root.buckets) || root.buckets.length === 0) return [];

  let worstUsed: number | null = null;
  let resetsAt: number | undefined;
  let count = 0;

  for (const raw of root.buckets) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as {
      remainingFraction?: unknown;
      resetTime?: unknown;
      tokenType?: unknown;
    };
    // Prefer REQUESTS buckets; skip empty
    if (
      typeof b.tokenType === 'string' &&
      b.tokenType &&
      b.tokenType !== 'REQUESTS' &&
      b.tokenType !== 'TOKENS'
    ) {
      continue;
    }
    if (typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) {
      continue;
    }
    const remaining = Math.max(0, Math.min(1, b.remainingFraction));
    const used = 1 - remaining;
    worstUsed = worstUsed === null ? used : Math.max(worstUsed, used);
    count += 1;
    if (typeof b.resetTime === 'string') {
      const ms = Date.parse(b.resetTime);
      if (Number.isFinite(ms)) {
        resetsAt =
          resetsAt === undefined ? ms : Math.min(resetsAt, ms);
      }
    }
  }

  if (worstUsed === null || count === 0) return [];

  // Buckets do not declare a five-hour window; preserve that uncertainty.
  return [
    knownWindow({
      kind: 'session',
      label: 'Cota Google',
      usedRatio: worstUsed,
      source: 'provider-api',
      confidence: 'high',
      resetsAt,
      now,
    }),
  ];
}

export async function refreshGeminiAccessToken(
  refreshToken: string,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<string | null> {
  const rt = refreshToken?.trim();
  if (!rt) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = opts?.timeoutMs ?? AGY_USAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: rt,
    }).toString();

    // Use global fetch with string body — FetchLike may not type body; cast.
    const res = await (fetchImpl as (
      input: string,
      init?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; json(): Promise<unknown> }>)(GEMINI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: unknown };
    return typeof json.access_token === 'string' && json.access_token
      ? json.access_token
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAgyUsageWindows(
  creds: GeminiOauthCreds,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
    /** Default false: o login nativo ~/.gemini é do CLI, não da sonda de cota. */
    allowRefresh?: boolean;
  },
): Promise<QuotaWindow[] | null> {
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const now = opts?.now ?? Date.now();
  const timeoutMs = opts?.timeoutMs ?? AGY_USAGE_TIMEOUT_MS;

  let access = creds.accessToken?.trim() || null;
  const expired =
    !access ||
    (typeof creds.expiryDate === 'number' && creds.expiryDate < now + 60_000);

  if (expired && creds.refreshToken && opts?.allowRefresh === true) {
    access = await refreshGeminiAccessToken(creds.refreshToken, {
      fetchImpl,
      timeoutMs,
    });
  }
  if (!access) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${access}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'antigravity',
  };
  const post = async (url: string, body: string) =>
    (fetchImpl as (
      input: string,
      init?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>)(
      url,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      },
    );

  try {
    // 1) Preferred: retrieveUserQuota (paid / eligible tiers).
    try {
      const res = await post(AGY_RETRIEVE_USER_QUOTA_URL, '{}');
      if (res.ok) {
        const body = await res.json();
        const windows = parseAgyUserQuota(body, now);
        if (windows.length > 0) return windows;
      }
    } catch {
      // fall through
    }

      // 2) Free / unlinked accounts: retrieveUserQuota → 403. loadCodeAssist
    //    still returns currentTier (free-tier vs paid). Surface tier as a
    //    remainingLabel on unknown windows — never invent used%.
    try {
      const res = await post(
        AGY_LOAD_CODE_ASSIST_URL,
        JSON.stringify({
          metadata: {
            ideType: 'ANTIGRAVITY',
            platform: 'PLATFORM_UNSPECIFIED',
          },
        }),
      );
      if (res.ok) {
        const body = await res.json();
        const tierWindows = windowsFromAgyTier(body);
        if (tierWindows.length > 0) return tierWindows;
      }
    } catch {
      // ignore
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * When Google withholds used%, still show which tier Antigravity reports for
 * this OAuth account (helps debug “I have Pro but API says free”).
 */
export function windowsFromAgyTier(body: unknown): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    currentTier?: { id?: unknown; name?: unknown; upgradeSubscriptionText?: unknown };
  };
  const tier = root.currentTier;
  if (!tier || typeof tier !== 'object') return [];
  const id = typeof tier.id === 'string' ? tier.id : '';
  const name = typeof tier.name === 'string' ? tier.name : 'AGY';
  if (!id && !name) return [];

  // remainingLabel is shown next to "—" — never a fake percentage.
  let note = name;
  if (id === 'free-tier') {
    note = 'Google: free-tier (sem used%)';
  } else if (id.includes('ultra')) {
    note = `Google: ${name}`;
  } else if (id) {
    note = `Google: ${id}`;
  }

  const hours = unknownWindow('hours', '5 Horas');
  const weekly = unknownWindow('weekly', 'Semanal');
  return [
    { ...hours, remainingLabel: note },
    { ...weekly, remainingLabel: note },
  ];
}

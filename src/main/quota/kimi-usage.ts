/**
 * Kimi Coding Plan usage probe (same path as Kimi CLI).
 *
 * 1) Refresh OAuth when access_token expired:
 *    POST https://auth.kimi.com/api/oauth/token
 *    (form: grant_type=refresh_token, client_id, refresh_token)
 * 2) GET https://api.kimi.com/coding/v1/usages
 *    Authorization: Bearer <access_token | sk-kimi-…>
 *
 * Live shape (2026-07):
 *   usage: { limit, remaining, resetTime }          → Semanal
 *   limits[].window.duration=300 TIME_UNIT_MINUTE   → 5 Horas
 *   totalQuota: { limit, remaining }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
export const KIMI_USAGE_FALLBACK_URL = 'https://api.kimi.com/coding/v1/usage';
export const KIMI_OAUTH_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';
/** Public client id embedded in Kimi Code CLI (device-code OAuth). */
export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_USAGE_TIMEOUT_MS = 10_000;
export const KIMI_USER_AGENT = 'KimiCLI/1.6';

export interface KimiOauthCreds {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch seconds (Kimi credentials file). */
  expiresAt?: number;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v));
  }
  return null;
}

function parseResetAt(data: Record<string, unknown>): number | undefined {
  const raw = data.resetTime ?? data.reset_at ?? data.reset_time;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === 'string' && raw) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function detailToWindow(
  data: Record<string, unknown>,
  kind: 'hours' | 'weekly' | 'session',
  label: string,
  now: number,
): QuotaWindow | null {
  const limit = toInt(data.limit ?? data.limit_amount);
  let used = toInt(data.used ?? data.used_amount);
  if (used === null) {
    const remaining = toInt(data.remaining);
    if (remaining !== null && limit !== null) used = Math.max(0, limit - remaining);
  }
  if (used === null || limit === null || limit <= 0) return null;
  return knownWindow({
    kind,
    label,
    usedRatio: Math.max(0, Math.min(1, used / limit)),
    source: 'provider-api',
    confidence: 'high',
    resetsAt: parseResetAt(data),
    now,
  });
}

function isFiveHourWindow(window: Record<string, unknown>): boolean {
  const duration = toInt(window.duration);
  const unit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase();
  if (duration === null) return false;
  // Live CLI: duration=300 TIME_UNIT_MINUTE → 5h
  if (unit.includes('MINUTE') && duration === 300) return true;
  if (unit.includes('HOUR') && duration === 5) return true;
  return false;
}

function isWeeklyWindow(window: Record<string, unknown>): boolean {
  const duration = toInt(window.duration);
  const unit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase();
  if (duration === null) return false;
  if (unit.includes('DAY') && duration === 7) return true;
  if (unit.includes('HOUR') && duration === 168) return true;
  return false;
}

function isDailyWindow(window: Record<string, unknown>): boolean {
  const duration = toInt(window.duration);
  const unit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase();
  return (unit.includes('DAY') && duration === 1) || (unit.includes('HOUR') && duration === 24);
}

/**
 * Parse Kimi Coding Plan /usages JSON (OAuth or sk-kimi).
 */
export function parseKimiUsagesPayload(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  const out: QuotaWindow[] = [];

  // Primary: usage block → weekly (rolling membership window)
  if (root.usage && typeof root.usage === 'object') {
    const w = detailToWindow(
      root.usage as Record<string, unknown>,
      'weekly',
      'Semanal',
      now,
    );
    if (w) out.push(w);
  }

  // totalQuota often mirrors weekly remaining
  if (root.totalQuota && typeof root.totalQuota === 'object' && !out.some((x) => x.kind === 'weekly')) {
    const w = detailToWindow(
      root.totalQuota as Record<string, unknown>,
      'weekly',
      'Semanal',
      now,
    );
    if (w) out.push(w);
  }

  // limits[] with window duration → 5h / weekly
  if (Array.isArray(root.limits)) {
    for (const item of root.limits) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const detail =
        rec.detail && typeof rec.detail === 'object'
          ? (rec.detail as Record<string, unknown>)
          : rec;
      const window =
        rec.window && typeof rec.window === 'object'
          ? (rec.window as Record<string, unknown>)
          : {};
      if (isFiveHourWindow(window)) {
        const w = detailToWindow(detail, 'hours', '5 Horas', now);
        if (w) out.push(w);
      } else if (isWeeklyWindow(window)) {
        const w = detailToWindow(detail, 'weekly', 'Semanal', now);
        if (w) out.push(w);
      } else if (isDailyWindow(window)) {
        const w = detailToWindow(detail, 'session', 'Diário', now);
        if (w) out.push(w);
      }
    }
  }

  // Legacy data[] array shape
  if (Array.isArray(root.data)) {
    for (const item of root.data) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const model = typeof rec.model_name === 'string' ? rec.model_name : '';
      if (model === 'all' || model === '') {
        const w = detailToWindow(rec, 'weekly', 'Semanal', now);
        if (w) out.push(w);
      } else {
        const w = detailToWindow(rec, 'hours', '5 Horas', now);
        if (w) out.push(w);
      }
    }
  }

  // Dedupe by kind — keep highest usedRatio
  const byKind = new Map<string, QuotaWindow>();
  for (const w of out) {
    const prev = byKind.get(w.kind);
    if (!prev || (w.usedRatio ?? -1) > (prev.usedRatio ?? -1)) {
      byKind.set(w.kind, w);
    }
  }
  return [...byKind.values()];
}

export function parseKimiCredentialsJson(blob: string): KimiOauthCreds | null {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    };
    const accessToken =
      typeof parsed.access_token === 'string' ? parsed.access_token : undefined;
    const refreshToken =
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined;
    const expiresAt =
      typeof parsed.expires_at === 'number' ? parsed.expires_at : undefined;
    if (!accessToken && !refreshToken) return null;
    return { accessToken, refreshToken, expiresAt };
  } catch {
    return null;
  }
}

export async function refreshKimiAccessToken(
  refreshToken: string,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number } | null> {
  const rt = refreshToken?.trim();
  if (!rt) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const timeoutMs = opts?.timeoutMs ?? KIMI_USAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: KIMI_OAUTH_CLIENT_ID,
    }).toString();
    const res = await (fetchImpl as (
      input: string,
      init?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; json(): Promise<unknown> }>)(KIMI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': KIMI_USER_AGENT,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof json.access_token !== 'string' || !json.access_token) return null;
    return {
      accessToken: json.access_token,
      refreshToken:
        typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expiresIn:
        typeof json.expires_in === 'number' ? json.expires_in : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Persist refreshed tokens so `kimi` CLI stays logged in. */
export function writeKimiCredentialsFile(
  update: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  },
  home = os.homedir(),
): void {
  const filePath = path.join(
    home,
    '.kimi-code',
    'credentials',
    'kimi-code.json',
  );
  try {
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      prev = {};
    }
    const next = {
      ...prev,
      access_token: update.accessToken,
      refresh_token: update.refreshToken ?? prev.refresh_token,
      token_type: 'Bearer',
      scope: prev.scope ?? 'kimi-code',
      expires_in: update.expiresIn ?? prev.expires_in ?? 900,
      expires_at:
        Math.floor(Date.now() / 1000) +
        (update.expiresIn ?? 900),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // best-effort — probe can still use in-memory token
  }
}

export async function fetchKimiCodingUsageWindows(
  apiKeyOrAccessToken: string,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number; now?: number },
): Promise<QuotaWindow[] | null> {
  const key = apiKeyOrAccessToken?.trim();
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const now = opts?.now ?? Date.now();
  const timeoutMs = opts?.timeoutMs ?? KIMI_USAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'User-Agent': KIMI_USER_AGENT,
  };

  try {
    for (const url of [KIMI_USAGES_URL, KIMI_USAGE_FALLBACK_URL]) {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        if (!res.ok) continue;
        const body = await res.json();
        const windows = parseKimiUsagesPayload(body, now);
        if (windows.length > 0) return windows;
      } catch {
        // next
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full probe: OAuth creds or raw API key → 5h + weekly windows.
 *
 * ATENÇÃO à linhagem (mesmo contrato do Claude em claude-oauth-refresh.ts):
 * o refresh do Kimi ROTACIONA o refresh token. `~/.kimi-code/credentials`
 * é do CLI — a sonda de cota NÃO pode trocar esse grant. Quem perde a
 * corrida (probe vs pane) cai em
 * `Stored token for "kimi-code" was rejected; re-login required`.
 * Default: só lê o access token atual. `allowRefresh` é só para linhagem
 * que o Nexus é o único dono (testes / vault isolado).
 */
export async function fetchKimiUsageWithOauth(
  creds: KimiOauthCreds | string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
    /**
     * Trocar o refresh token. Default false — o CLI nativo é o dono.
     * Sem persistir, um refresh ainda CONSOME o grant rotacionado.
     */
    allowRefresh?: boolean;
    /** Só vale com allowRefresh. Escreve ~/.kimi-code — perigoso no login nativo. */
    persistRefresh?: boolean;
  },
): Promise<QuotaWindow[] | null> {
  const now = opts?.now ?? Date.now();
  const nowSec = Math.floor(now / 1000);

  // Plain API key (sk-kimi-…)
  if (typeof creds === 'string') {
    return fetchKimiCodingUsageWindows(creds, opts);
  }

  let access = creds.accessToken?.trim() || null;
  const refresh = creds.refreshToken?.trim() || null;
  const expired =
    !access ||
    (typeof creds.expiresAt === 'number' && creds.expiresAt < nowSec + 30);

  if (expired && refresh && opts?.allowRefresh === true) {
    const refreshed = await refreshKimiAccessToken(refresh, {
      fetchImpl: opts?.fetchImpl,
      timeoutMs: opts?.timeoutMs,
    });
    if (refreshed) {
      access = refreshed.accessToken;
      if (opts.persistRefresh === true) {
        writeKimiCredentialsFile({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? refresh,
          expiresIn: refreshed.expiresIn,
        });
      }
    }
  }

  if (!access) return null;
  return fetchKimiCodingUsageWindows(access, opts);
}

/**
 * Kimi Coding Plan usage probe.
 *
 * GET https://api.kimi.com/coding/v1/usages
 * Authorization: Bearer sk-kimi-xxx   (Coding Plan key, NOT moonshot sk-xxx)
 * User-Agent: KimiCLI/1.6
 *
 * Shape (kimi-code-usage compatible):
 *   { data: [{ model_name, used, limit, resetTime }, ...] }
 *   or { usage: {...}, limits: [...] }
 */

import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
export const KIMI_USAGE_FALLBACK_URL = 'https://api.kimi.com/coding/v1/usage';
export const KIMI_USAGE_TIMEOUT_MS = 8_000;
export const KIMI_USER_AGENT = 'KimiCLI/1.6';

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

function rowToWindow(
  data: Record<string, unknown>,
  kind: 'hours' | 'weekly' | 'session',
  label: string,
  now: number,
): QuotaWindow | null {
  const limit = toInt(data.limit ?? data.limit_amount);
  let used = toInt(data.used ?? data.used_amount);
  if (used === null) {
    const remaining = toInt(data.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  // percent fields
  if (used === null && typeof data.percent === 'number') {
    const ratio =
      data.percent > 1
        ? Math.min(1, data.percent / 100)
        : Math.max(0, Math.min(1, data.percent));
    return knownWindow({
      kind,
      label,
      usedRatio: ratio,
      source: 'provider-api',
      confidence: 'high',
      resetsAt: parseResetAt(data),
      now,
    });
  }
  if (used === null || limit === null || limit <= 0) return null;
  const ratio = Math.max(0, Math.min(1, used / limit));
  return knownWindow({
    kind,
    label,
    usedRatio: ratio,
    source: 'provider-api',
    confidence: 'high',
    resetsAt: parseResetAt(data),
    now,
  });
}

function classifyLabel(
  label: string,
): { kind: 'hours' | 'weekly' | 'session'; label: string } {
  const l = label.toLowerCase();
  if (
    l.includes('5h') ||
    l.includes('5 h') ||
    l.includes('five') ||
    /\b5\s*hour/.test(l) ||
    l.includes('hour')
  ) {
    return { kind: 'hours', label: '5 Horas' };
  }
  if (l.includes('week') || l.includes('seman') || l.includes('7d')) {
    return { kind: 'weekly', label: 'Semanal' };
  }
  return { kind: 'session', label: label || 'Sessão' };
}

/**
 * Parse Kimi Coding Plan usages JSON.
 */
export function parseKimiUsagesPayload(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  const out: QuotaWindow[] = [];

  const dataList = root.data;
  if (Array.isArray(dataList)) {
    for (const item of dataList) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const model =
        typeof rec.model_name === 'string' ? rec.model_name : '';
      const meta =
        model === 'all' || model === ''
          ? { kind: 'weekly' as const, label: 'Semanal' }
          : classifyLabel(String(rec.name ?? rec.title ?? model));
      const w = rowToWindow(rec, meta.kind, meta.label, now);
      if (w) out.push(w);
    }
  }

  const usage = root.usage;
  if (usage && typeof usage === 'object') {
    const w = rowToWindow(
      usage as Record<string, unknown>,
      'weekly',
      'Semanal',
      now,
    );
    if (w) out.push(w);
  }

  const limits = root.limits;
  if (Array.isArray(limits)) {
    for (const item of limits) {
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
      const duration = toInt(window.duration);
      const timeUnit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase();
      let kind: 'hours' | 'weekly' | 'session' = 'session';
      let label = 'Sessão';
      if (timeUnit.includes('HOUR') && duration === 5) {
        kind = 'hours';
        label = '5 Horas';
      } else if (timeUnit.includes('DAY') && (duration === 7 || duration === 1)) {
        kind = duration === 7 ? 'weekly' : 'session';
        label = duration === 7 ? 'Semanal' : 'Diário';
      } else if (timeUnit.includes('MINUTE') && duration !== null && duration >= 240) {
        kind = 'hours';
        label = '5 Horas';
      }
      const w = rowToWindow(detail, kind, label, now);
      if (w) out.push(w);
    }
  }

  // Dedupe by kind — keep highest usedRatio (worst)
  const byKind = new Map<string, QuotaWindow>();
  for (const w of out) {
    const prev = byKind.get(w.kind);
    if (!prev || (w.usedRatio ?? -1) > (prev.usedRatio ?? -1)) {
      byKind.set(w.kind, w);
    }
  }
  return [...byKind.values()];
}

export async function fetchKimiCodingUsageWindows(
  apiKey: string,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number; now?: number },
): Promise<QuotaWindow[] | null> {
  const key = apiKey?.trim();
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

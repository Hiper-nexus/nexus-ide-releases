/**
 * Second-layer defense against phantom limits.
 *
 * The failover engine scrapes limit signals from the PTY, which also carries
 * echoed handoff text, agent prose, tool output and pasted logs — any of which
 * can look like a provider limit. When we hold a FRESH, authoritative
 * `provider-api` reading that shows the account is clearly healthy, that reading
 * refutes the terminal signal and failover is suppressed (no cooldown, no
 * account switch). Pure + unit-tested; the failover engine consults it before
 * acting on a hit.
 *
 * Deliberately conservative — it only ever refutes a claim it can actually
 * disprove:
 *  - usage-based kinds only (`quota` / `rate-limit`). `auth` is a credential
 *    problem orthogonal to usage; `transient` is already a seconds-long cooldown.
 *  - unscoped hits only. A per-tier claim (`tier:opus`) is not cleared by an
 *    account-wide reading.
 *  - a provider-api window of the MATCHING kind must exist, be fresh, and read
 *    clearly below the limit to refute a hit.
 *  - independently, a textual hit is never authoritative enough to create a
 *    long usage cooldown without a fresh matching provider-api window. Short
 *    backoff plus auth/transient recovery remain available without quota APIs.
 */

import {
  QUOTA_HIGH_USAGE_THRESHOLD,
  type ProviderQuotaEntry,
  type QuotaWindowKind,
} from '../../shared/quota-types';
import type { LimitHit } from './limit-detector';

/** A provider-api reading older than this is too stale to trust over a live PTY. */
export const REFUTE_FRESH_MS = 10 * 60 * 1000;

/**
 * One hour or more removes an account from useful work for long enough that a
 * PTY regex cannot be the sole authority. This gates the 1h/5h/12h patterns
 * while preserving 15-minute auth recovery and short transient backoff.
 */
export const LONG_COOLDOWN_MIN_MS = 60 * 60 * 1000;

/**
 * Below this used fraction the account clearly has room, so a "limit reached"
 * claim from the terminal is untrustworthy. Uses QUOTA_HIGH_USAGE_THRESHOLD (0.8)
 * so accounts with headroom (e.g. 72% weekly on Codex) are not falsely marked exhausted.
 */
export const REFUTE_HEALTHY_RATIO = QUOTA_HIGH_USAGE_THRESHOLD;

/** Windows a `quota` (plan/credits) claim would show up in. */
const QUOTA_WINDOW_KINDS: ReadonlySet<QuotaWindowKind> = new Set([
  'weekly',
  'monthly',
  'credits',
]);

/** Windows a `rate-limit` (rolling) claim would show up in. */
const RATE_WINDOW_KINDS: ReadonlySet<QuotaWindowKind> = new Set([
  'hours',
  'session',
]);

function relevantWindowKinds(
  kind: Pick<LimitHit, 'kind'>['kind'],
): ReadonlySet<QuotaWindowKind> | null {
  if (kind === 'quota') return QUOTA_WINDOW_KINDS;
  if (kind === 'rate-limit') return RATE_WINDOW_KINDS;
  return null;
}

/**
 * Whether a cooldown is a long-lived usage quarantine and therefore requires
 * fresh provider authority. Auth validity and transient capacity are distinct
 * signals and deliberately retain their existing recovery behavior.
 */
export function longCooldownNeedsFreshProviderApi(
  hit: Pick<LimitHit, 'kind' | 'cooldownMs'>,
): boolean {
  return (
    (hit.kind === 'quota' || hit.kind === 'rate-limit') &&
    hit.cooldownMs >= LONG_COOLDOWN_MIN_MS
  );
}

/**
 * Presence check only: healthy readings are handled by
 * `providerApiRefutesLimit`; this function prevents "unknown" from authorizing
 * a multi-hour quarantine. A ratio must be known and the window kind must match
 * the alleged limit.
 */
export function hasFreshProviderApiWindowForLimit(
  entry: ProviderQuotaEntry | undefined,
  hit: Pick<LimitHit, 'kind'>,
  now: number,
): boolean {
  if (!entry) return false;
  if (!Number.isFinite(entry.updatedAt) || now - entry.updatedAt > REFUTE_FRESH_MS) {
    return false;
  }
  const relevant = relevantWindowKinds(hit.kind);
  if (!relevant) return false;
  return entry.windows.some(
    (window) =>
      window.source === 'provider-api' &&
      window.usedRatio !== null &&
      relevant.has(window.kind),
  );
}

/**
 * Refuta um COOLDOWN já persistido (pós-hoc, sem saber o kind do hit que o
 * criou): leitura provider-api fresca em que TODA janela com ratio conhecido
 * está abaixo do limiar de uso elevado. Cobre o resíduo da cascata fantasma —
 * cooldowns gravados antes do fix ficavam pendurados por horas ("100%" na
 * barra) mesmo com a conta comprovadamente com folga (ex.: Semanal 54%).
 *
 * Gate deliberadamente mais folgado que o da refutação ao vivo
 * (REFUTE_HEALTHY_RATIO=0.5): aqui o cooldown já está gravado e a leitura é
 * autoritativa — um provider que realmente bloqueia reporta a janela
 * correspondente em ~100%, nunca em 54%. Janelas no intervalo 0.5–0.8 são
 * "uso alto, mas comprovadamente não bloqueado": manter a conta quarantinada
 * ali reproduzia exatamente o bug do cockpit mostrando 100% falso.
 * Conservador nos demais eixos: sem leitura fresca, ou com qualquer janela ≥
 * QUOTA_HIGH_USAGE_THRESHOLD, o cooldown fica.
 */
export function providerApiRefutesCooldown(
  windows: ReadonlyArray<{ source: string; usedRatio: number | null }>,
  readAt: number,
  now: number,
): boolean {
  if (!Number.isFinite(readAt) || now - readAt > REFUTE_FRESH_MS) return false;
  let sawRatio = false;
  for (const window of windows) {
    if (window.source !== 'provider-api' || window.usedRatio === null) continue;
    if (window.usedRatio >= QUOTA_HIGH_USAGE_THRESHOLD) return false;
    sawRatio = true;
  }
  return sawRatio;
}

export function providerApiRefutesLimit(
  entry: ProviderQuotaEntry | undefined,
  hit: Pick<LimitHit, 'kind' | 'scope'>,
  now: number,
): boolean {
  if (!entry) return false;
  // Only usage-based claims can be disproven by usage data.
  if (hit.kind !== 'quota' && hit.kind !== 'rate-limit') return false;
  // A per-tier claim is not cleared by an account-wide reading.
  if (hit.scope) return false;
  // The reading must be recent to be trusted over a live terminal signal.
  if (!Number.isFinite(entry.updatedAt) || now - entry.updatedAt > REFUTE_FRESH_MS) {
    return false;
  }

  const relevant = relevantWindowKinds(hit.kind);
  if (!relevant) return false;
  let sawHealthyProviderApi = false;
  for (const w of entry.windows) {
    if (w.source !== 'provider-api') continue;
    if (w.usedRatio === null) continue;
    if (!relevant.has(w.kind)) continue;
    // Any matching window at/near its limit means the claim could be real.
    if (w.usedRatio >= REFUTE_HEALTHY_RATIO) return false;
    sawHealthyProviderApi = true;
  }
  return sawHealthyProviderApi;
}

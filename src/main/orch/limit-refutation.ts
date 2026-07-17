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
 *    clearly below the limit. No such reading (the "unknown" case) ⇒ fall back
 *    to trusting the PTY (legacy behaviour). This is why source-isolation, not
 *    this gate, is the primary fix for the echoed-pack cascade.
 */

import type {
  ProviderQuotaEntry,
  QuotaWindowKind,
} from '../../shared/quota-types';
import type { LimitHit } from './limit-detector';

/** A provider-api reading older than this is too stale to trust over a live PTY. */
export const REFUTE_FRESH_MS = 10 * 60 * 1000;

/**
 * Below this used fraction the account clearly has room, so a "limit reached"
 * claim from the terminal is untrustworthy. Kept well under the high-usage
 * threshold (0.8) so we never suppress a hit on an account that is genuinely
 * close to its ceiling.
 */
export const REFUTE_HEALTHY_RATIO = 0.5;

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

/**
 * Refuta um COOLDOWN já persistido (pós-hoc, sem saber o kind do hit que o
 * criou): leitura provider-api fresca em que TODA janela com ratio conhecido
 * está claramente saudável. Cobre o resíduo da cascata fantasma — cooldowns
 * gravados antes do fix ficavam pendurados por horas ("5 Horas 100% ·
 * 10h16m") mesmo com a conta comprovadamente ok. Conservador: sem leitura
 * fresca, ou com qualquer janela ≥ REFUTE_HEALTHY_RATIO, o cooldown fica.
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
    if (window.usedRatio >= REFUTE_HEALTHY_RATIO) return false;
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

  const relevant =
    hit.kind === 'quota' ? QUOTA_WINDOW_KINDS : RATE_WINDOW_KINDS;
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

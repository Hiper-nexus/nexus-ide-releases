/**
 * A evidência que autoriza a drenagem proativa de uma conta, montada na
 * camada do Main (o núcleo puro não lê ambiente nem relógio).
 *
 * Duas exigências, ambas do anti-objetivo "trocar por engano" (F-249): a
 * leitura tem de vir do provedor e tem de ser fresca. Uma estimativa local
 * tirando um pane de uma conta saudável custa mais que o limite real.
 */
import { DRAIN_THRESHOLD, type DrainEvidence } from '../quota/account-headroom';
import { REFUTE_FRESH_MS } from '../orch/limit-refutation';

/** Válvula do operador: fração 0 < t <= 1. `1` drena só no esgotamento. */
export const DRAIN_THRESHOLD_ENV = 'NEXUS_ACCOUNT_DRAIN_THRESHOLD';

function thresholdFromEnv(): number {
  const raw = process.env[DRAIN_THRESHOLD_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return DRAIN_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return DRAIN_THRESHOLD;
  return parsed;
}

export function accountDrainEvidence(now: number): DrainEvidence {
  return {
    requireSource: 'provider-api',
    maxAgeMs: REFUTE_FRESH_MS,
    threshold: thresholdFromEnv(),
    now,
  };
}

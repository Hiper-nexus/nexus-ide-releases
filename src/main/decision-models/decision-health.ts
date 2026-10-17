/**
 * Disjuntor por provedor de decisão (jev, clef, luna).
 *
 * Três falhas seguidas de rede, timeout, 5xx ou 429, dentro de 2 min, abrem
 * o provedor. O cooldown nasce em 15 s e dobra a cada sonda que falha, até
 * 5 min. Abort, orçamento e erro de cliente quebram a sequência e não abrem;
 * também não fecham um disjuntor que já está aberto. Sucesso zera tudo.
 * Quem registra é o juiz. O cliente do Jev só lê, para falhar sem esperar.
 */
import type { DecisionProvider } from '../../shared/decision-models';
import type { JevNoAnswerReason } from '../jev/jev-decision-log';

export const DECISION_HEALTH_PROVIDERS = ['jev', 'clef', 'luna'] as const;
export type DecisionHealthProvider = typeof DECISION_HEALTH_PROVIDERS[number];

export const BREAKER_FAILURES_TO_OPEN = 3;
export const BREAKER_WINDOW_MS = 120_000;
export const BREAKER_INITIAL_COOLDOWN_MS = 15_000;
export const BREAKER_MAX_COOLDOWN_MS = 300_000;

const TRIP_REASONS: ReadonlySet<JevNoAnswerReason> = new Set(['network', 'timeout', 'server-error', 'rate-limited']);

export function decisionFailureTripsBreaker(reason: JevNoAnswerReason): boolean {
  return TRIP_REASONS.has(reason);
}

interface ProviderHealth {
  streak: number;
  lastTripAt: number;
  /** Aberto enquanto `now < openUntil`. Zero = fechado. */
  openUntil: number;
  /** Duração do próximo aberto. A sonda que falha dobra; o sucesso volta a 15 s. */
  cooldownMs: number;
}

function closedState(): ProviderHealth {
  return { streak: 0, lastTripAt: 0, openUntil: 0, cooldownMs: BREAKER_INITIAL_COOLDOWN_MS };
}

const health: Record<DecisionHealthProvider, ProviderHealth> = {
  jev: closedState(), clef: closedState(), luna: closedState(),
};

let clock: () => number = () => Date.now();

export function configureDecisionHealthClock(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

export function resetDecisionHealthForTesting(): void {
  for (const provider of DECISION_HEALTH_PROVIDERS) health[provider] = closedState();
  clock = () => Date.now();
}

function providerState(provider: DecisionProvider): ProviderHealth | undefined {
  return provider === 'jev' || provider === 'clef' || provider === 'luna' ? health[provider] : undefined;
}

/** Verdade só enquanto o cooldown não acabou. Depois dele cabe uma sonda. */
export function isDecisionProviderBlocked(provider: DecisionProvider, now = clock()): boolean {
  const state = providerState(provider);
  return Boolean(state && now < state.openUntil);
}

export function recordDecisionProviderFailure(provider: DecisionProvider, reason: JevNoAnswerReason, now = clock()): void {
  const state = providerState(provider);
  if (!state) return;
  if (!decisionFailureTripsBreaker(reason)) {
    // Aberto de verdade: não fecha e não mexe na sequência.
    if (now < state.openUntil) return;
    // Fechado ou sonda: a sequência quebra. A sonda que não é trip encerra
    // o meio-aberto sem sucesso — o cooldown elevado fica para a próxima abertura.
    state.streak = 0;
    state.lastTripAt = 0;
    if (state.openUntil > 0) state.openUntil = 0;
    return;
  }
  if (now < state.openUntil) return;
  // Sonda (o cooldown já passou): uma falha reabre com o dobro.
  if (state.openUntil > 0 && now >= state.openUntil) {
    const next = Math.min(state.cooldownMs * 2, BREAKER_MAX_COOLDOWN_MS);
    state.cooldownMs = next;
    state.openUntil = now + next;
    state.streak = BREAKER_FAILURES_TO_OPEN;
    state.lastTripAt = now;
    return;
  }
  if (state.lastTripAt > 0 && now - state.lastTripAt > BREAKER_WINDOW_MS) state.streak = 1;
  else state.streak += 1;
  state.lastTripAt = now;
  if (state.streak >= BREAKER_FAILURES_TO_OPEN) {
    state.openUntil = now + state.cooldownMs;
  }
}

export function recordDecisionProviderSuccess(provider: DecisionProvider, now = clock()): void {
  const state = providerState(provider);
  if (!state) return;
  health[provider === 'clef' || provider === 'luna' ? provider : 'jev'] = closedState();
  void now;
}

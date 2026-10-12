/**
 * F-1410: limite de uso CONFIRMADO no nível da CLI.
 *
 * O cooldown de conta (`account-store`) resolve o caso comum: uma CLI com
 * várias contas gerenciadas tem onde pôr a conta esgotada e para de oferecê-la
 * ao `pickAvailableForFailover`. Mas o login NATIVO por oauth não tem conta
 * gerenciada nenhuma — `hasAvailableAccount` devolve `true` para sempre
 * (`listAccounts(adapterId).length === 0`), logo o cooldown não marca nada e a
 * rota continua escolhendo a CLI. Foi o caso do Muse Code em 12/10/2026: a
 * conta acabou o limite, o operador pediu "manda para outro" e a rota
 * respondeu "exclude ignorado (CLI saudável): muse … conta disponível".
 *
 * Este registro é a via estreita que fecha a lacuna — e é deliberadamente
 * estreita (quem decide é `failover.ts`, aqui só se guarda):
 *  - só um hit CONFIRMADO entra (`hit.confirmed`: célula de status/erro que
 *    só a TUI da CLI desenha, ancorada na tela); a frase solta, o texto
 *    citado e o limite "não confirmado" (F-249) nunca chegam aqui;
 *  - só quando o hit é do MESMO adapter do pane — o rótulo do Muse lido num
 *    pane do Claude não põe o Muse na quarentena;
 *  - só sem conta gerenciada (`!current`): com contas, o cooldown de conta
 *    já faz o trabalho e nada muda;
 *  - a janela é a do próprio hit — o reset lido do texto quando existe, senão
 *    o piso do padrão (5 h para o Muse).
 *
 * Ponto de extensão (sonda de cota): uma sonda da CLI (ex.: `muse-usage`,
 * `usage/read` com `usedPercent`/`resetsAtMs`) não precisa de API nova —
 * leitura abaixo de 100% chama `clearCliLimit(adapterId)` (refuta), leitura
 * esgotada chama `noteCliLimit(adapterId, { …hit, cooldownMs: resetsAtMs - now })`.
 *
 * Memória do processo, como o disjuntor de adapter (`circuit-breaker.ts`):
 * partida fria = nenhuma CLI limitada.
 */

import type { LimitHit } from './limit-detector';

export interface CliLimit {
  readonly adapterId: string;
  readonly kind: LimitHit['kind'];
  /** Texto do rótulo, já sem moldura — só para o motivo da rota. */
  readonly reason: string;
  /** Epoch ms em que a janela foi marcada. */
  readonly at: number;
  /** Epoch ms em que a CLI volta a ser elegível. */
  readonly until: number;
}

const limits = new Map<string, CliLimit>();

/**
 * Janela sem prova de reset. 5 h é o mesmo piso do padrão `rate-limit` que o
 * detector já aplica a "usage limit reached" — conservador o bastante para a
 * conta não voltar antes da hora e curto o bastante para a CLI ser reavaliada
 * na mesma sessão sem intervenção.
 */
export const DEFAULT_CLI_LIMIT_MS = 5 * 60 * 60 * 1000;

function reasonText(hit: LimitHit): string {
  return hit.reason.replace(/^[\s⎿│]+/u, '').trim().slice(0, 120);
}

/**
 * Registers a CLI-level limit. Only the caller (`failover.ts`) decides whether
 * the evidence qualifies; this function just stores it.
 */
export function noteCliLimit(
  adapterId: string,
  hit: LimitHit,
  now: number = Date.now(),
): CliLimit {
  const window =
    Number.isFinite(hit.cooldownMs) && hit.cooldownMs > 0
      ? hit.cooldownMs
      : DEFAULT_CLI_LIMIT_MS;
  const limit: CliLimit = {
    adapterId,
    kind: hit.kind,
    reason: reasonText(hit),
    at: now,
    until: now + window,
  };
  limits.set(adapterId, limit);
  return limit;
}

/** Active limit for the adapter, or null when absent/expired. */
export function activeCliLimit(
  adapterId: string,
  now: number = Date.now(),
): CliLimit | null {
  const limit = limits.get(adapterId);
  if (!limit) return null;
  if (now >= limit.until) {
    limits.delete(adapterId);
    return null;
  }
  return limit;
}

export function isCliLimited(
  adapterId: string,
  now: number = Date.now(),
): boolean {
  return activeCliLimit(adapterId, now) !== null;
}

/** Devolve a CLI à rota na hora (sonda que refuta, desbloqueio manual). */
export function clearCliLimit(adapterId: string): void {
  limits.delete(adapterId);
}

/** Test seam — mirrors `CircuitBreakerRegistry.reset`. */
export function resetCliLimits(): void {
  limits.clear();
}
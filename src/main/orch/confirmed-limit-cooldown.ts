/**
 * F-1484: o limite que o próprio provedor confirmou (StopFailure `rate_limit`)
 * troca de conta na hora, com o teto curto do frame — o payload não traz o
 * reset (o texto do provedor nunca é lido, F-734). Em paralelo, uma leitura de
 * cota feita a partir do hit acha a janela que estourou (5 h, 7 d…) e estende
 * o cooldown até o reset real; sem isso a conta exausta voltava ao pool em
 * 15 min e o pane fazia ping-pong A↔B. Sem leitura, fica o teto curto.
 * Nada aqui encurta um cooldown: vale sempre o maior.
 */
import type { LimitHit } from './limit-detector';
import { windowScope } from './window-scope';
import type { QuotaFleetSnapshot } from '../../shared/quota-types';
import { requireQuotaService } from '../quota/quota-service';
import { getAccount, setCooldown } from '../persistence/account-store';

/** Teto do cooldown estendido: nenhuma janela de conta passa de uma semana. */
export const MAX_CONFIRMED_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export interface ConfirmedLimitCooldownDeps {
  readonly refresh: (hitAt: number) => Promise<QuotaFleetSnapshot>;
  readonly setCooldown: (accountId: string, until: number, reason: string, scope?: string) => void;
  /** Fim do cooldown GLOBAL vigente da conta (o account-store é last-write-wins). */
  readonly cooldownUntil: (accountId: string) => number | undefined;
  readonly now: () => number;
}

const productionDeps: ConfirmedLimitCooldownDeps = {
  refresh: (hitAt) => requireQuotaService().refreshForLimitHit(hitAt),
  setCooldown: (accountId, until, reason, scope) => setCooldown(accountId, until, reason, scope),
  cooldownUntil: (accountId) => getAccount(accountId)?.cooldownUntil,
  now: () => Date.now(),
};

interface ConfirmedLimitInput {
  readonly adapterId: string;
  readonly accountId: string;
  readonly hit: LimitHit;
}

/** Devolve o novo fim do cooldown GLOBAL, ou null quando ele não mudou. Nunca lança. */
export async function extendConfirmedLimitCooldown(
  input: ConfirmedLimitInput,
  deps: ConfirmedLimitCooldownDeps = productionDeps,
): Promise<number | null> {
  const hitAt = input.hit.confirmedAt;
  if (hitAt === undefined) return null;
  let snapshot: QuotaFleetSnapshot;
  try {
    snapshot = await deps.refresh(hitAt);
  } catch {
    return null;
  }
  const entry = snapshot.entries.find(
    (candidate) => candidate.adapterId === input.adapterId && candidate.accountId === input.accountId,
  );
  // Só a leitura que começou no hit ou depois fala pelo estado de agora.
  if (!entry || !(entry.updatedAt >= hitAt)) return null;
  const now = deps.now();
  const ceiling = now + MAX_CONFIRMED_COOLDOWN_MS;
  let general = 0;
  const scoped = new Map<string, number>();
  for (const window of entry.windows) {
    if (window.source !== 'provider-api' || window.usedRatio === null || window.usedRatio < 1) continue;
    const resetsAt = window.resetsAt;
    if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) continue;
    const until = Math.min(resetsAt, ceiling);
    const scope = windowScope(window.label);
    if (scope === undefined) general = Math.max(general, until);
    else if (scope) scoped.set(scope, Math.max(scoped.get(scope) ?? 0, until));
  }
  // Bloco escopado guarda o maior fim sozinho (account-store faz max()).
  for (const [scope, until] of scoped) deps.setCooldown(input.accountId, until, input.hit.reason, scope);
  const floor = Math.max(now, hitAt + input.hit.cooldownMs, deps.cooldownUntil(input.accountId) ?? 0);
  if (general <= floor) return null;
  deps.setCooldown(input.accountId, general, input.hit.reason, input.hit.scope);
  return general;
}

/**
 * Confirmação do provedor DEPOIS de o texto (ou a sonda) já ter comitado a
 * troca deste limite: nunca troca de novo nem encurta. Garante o teto curto
 * confirmado só se o cooldown vigente for menor, e estende pelo reset real.
 */
export function raiseConfirmedLimitCooldown(
  input: ConfirmedLimitInput,
  deps: ConfirmedLimitCooldownDeps = productionDeps,
): void {
  const floor = (input.hit.confirmedAt ?? deps.now()) + input.hit.cooldownMs;
  if ((deps.cooldownUntil(input.accountId) ?? 0) < floor) {
    deps.setCooldown(input.accountId, floor, input.hit.reason, input.hit.scope);
  }
  void extendConfirmedLimitCooldown(input, deps);
}

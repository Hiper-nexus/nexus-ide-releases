/**
 * Regra do operador: quando o MESMO modelo/família chega por duas rotas —
 * (a) uma CLI com login/assinatura (plano, sem custo por uso) e (b) uma CLI ou
 * adapter com API key paga por uso — o roteador prioriza (a). A rota (b) fica
 * de fallback: sem credencial pronta, em cooldown, em circuito aberto ou rota
 * falha na (a).
 *
 * Funções puras: quem chama injeta o estado (cobrança, prontidão, saúde).
 */

export type RouteBilling = 'subscription' | 'api-key';

export interface BillingRouteCandidate {
  adapterId: string;
  model?: string;
  /** Como a CLI cobra o uso agora. Ausente = desconhecido (tratado como pago). */
  billing?: RouteBilling;
  /** Credencial pronta e fora de cooldown/cota. */
  ready: boolean;
  /** Circuito fechado e sem falha comprovada. */
  healthy: boolean;
}

const isReadySubscription = (candidate: BillingRouteCandidate): boolean =>
  candidate.billing === 'subscription' && candidate.ready && candidate.healthy;

/**
 * Ordenação estável: assinatura pronta e saudável primeiro; o resto (API key,
 * assinatura sem credencial/em cooldown, cobrança desconhecida) mantém a ordem
 * relativa original e fica depois.
 */
export function preferSubscriptionRoute<T extends BillingRouteCandidate>(
  candidates: readonly T[],
): T[] {
  return [
    ...candidates.filter(isReadySubscription),
    ...candidates.filter((candidate) => !isReadySubscription(candidate)),
  ];
}

export interface SubscriptionPreference<T extends BillingRouteCandidate> {
  pick: T;
  /** Trecho do recibo de rota (`route.reason`). */
  note: string;
}

/**
 * `chosen` é a escolha do roteador; `sameFamily` são os demais candidatos que
 * servem a mesma família. Só troca quando `chosen` é explicitamente API key e
 * existe assinatura pronta e saudável; do contrário devolve null (sem troca).
 */
export function subscriptionOverApiKey<T extends BillingRouteCandidate>(
  chosen: T,
  sameFamily: readonly T[],
): SubscriptionPreference<T> | null {
  if (chosen.billing !== 'api-key') return null;
  const [best] = preferSubscriptionRoute(
    sameFamily.filter((candidate) => candidate.adapterId !== chosen.adapterId),
  );
  if (!best || !isReadySubscription(best)) return null;
  return {
    pick: best,
    note: `; preferiu assinatura (${best.adapterId}) à API key (${chosen.adapterId})`,
  };
}

/** Cobrança efetiva a partir da estratégia de auth do provider. */
export function billingFromAuth(input: {
  authStrategy: string;
  /** Plano de chave com tarifa fixa (ex.: Qwen no Alibaba Token Plan). */
  flatRatePlan?: boolean;
}): RouteBilling | undefined {
  if (input.authStrategy === 'subscription') return 'subscription';
  if (input.authStrategy === 'api-key') return input.flatRatePlan ? 'subscription' : 'api-key';
  return undefined;
}

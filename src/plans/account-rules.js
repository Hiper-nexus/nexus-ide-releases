/** Regras puras da página Minha conta: o que cada botão de cobrança pode fazer
 * com o status público da API e a sessão. A página só aplica o resultado. */

/** `maxAgents` nulo é o contrato do Pro: sem o limite do teste. */
export function agentLimitLabel(maxAgents) {
  if (maxAgents === null) return 'Sem limite do teste';
  return Number.isInteger(maxAgents) ? String(maxAgents) : 'A confirmar';
}

/** Novo checkout exige vendas abertas (`ready`). O portal não: quem já tem
 * assinatura precisa cancelar ou trocar o cartão mesmo com as vendas fechadas. */
export function billingFlags(availability, session, isBusy) {
  const available = availability?.billing?.available === true;
  const selling = available && availability?.ready === true;
  const authenticated = session?.authenticated === true;
  const access = session?.entitlement?.access;
  const portalVisible = authenticated && session.billing?.portal === true;
  const portalHint = portalVisible && available ? ' O portal de cobrança continua disponível.' : '';
  let status;
  if (authenticated && access === 'pro' && available) status = portalVisible ? 'Seu acesso Pro está confirmado. Use o portal para gerenciar a cobrança.' : 'Seu acesso Pro está confirmado.';
  else if (authenticated && access === 'suspended' && available) status = 'Seu acesso está suspenso. Fale com o suporte. O portal de cobrança continua disponível se você tem assinatura.';
  else if (!selling) status = `A contratação está temporariamente indisponível. Nenhuma cobrança será iniciada.${portalHint}`;
  else status = authenticated ? 'Ao continuar, você será levado ao checkout seguro do Stripe.' : 'Entre na sua conta para contratar.';
  return {
    checkoutEnabled: !isBusy && selling && authenticated && !['pro', 'suspended'].includes(access),
    portalVisible,
    portalEnabled: !isBusy && available,
    status,
  };
}

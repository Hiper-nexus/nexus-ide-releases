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
  const portalUsable = portalVisible && available;
  let status;
  if (authenticated && access === 'pro') {
    status = portalUsable ? 'Seu acesso Pro está confirmado. Use o portal para gerenciar a cobrança.'
      : portalVisible ? 'Seu acesso Pro está confirmado. O portal de cobrança está temporariamente indisponível.'
        : 'Seu acesso Pro está confirmado.';
  } else if (authenticated && access === 'suspended') {
    status = portalUsable ? 'Seu acesso está suspenso. Fale com o suporte. O portal de cobrança continua disponível.' : 'Seu acesso está suspenso. Fale com o suporte.';
  } else if (!selling) {
    status = `A contratação está temporariamente indisponível. Nenhuma cobrança será iniciada.${portalUsable ? ' O portal de cobrança continua disponível.' : ''}`;
  } else status = authenticated ? 'Ao continuar, você será levado ao checkout seguro do Stripe.' : 'Entre ou crie sua conta com Google ou GitHub para contratar.';
  const checkoutEnabled = !isBusy && selling && authenticated && !['pro', 'suspended'].includes(access);
  // Sem login o botão não é um beco sem saída: com as vendas abertas ele leva ao cadastro.
  const subscribeAction = checkoutEnabled ? 'checkout' : (!isBusy && selling && !authenticated ? 'login' : 'none');
  return {
    checkoutEnabled,
    subscribeAction,
    subscribeEnabled: subscribeAction !== 'none',
    subscribeLabel: selling && !authenticated ? 'Entrar para assinar' : 'Assinar Nexus Pro ↗',
    portalVisible,
    portalEnabled: !isBusy && portalUsable,
    status,
  };
}

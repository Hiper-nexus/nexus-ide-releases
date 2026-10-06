/** Regras puras da página Minha conta: o que cada botão de cobrança pode fazer
 * com o status público da API e a sessão. A página só aplica o resultado. */

/** `maxAgents` nulo é o contrato do Pro: sem o limite do teste. */
export function agentLimitLabel(maxAgents) {
  if (maxAgents === null) return 'Agentes simultâneos ilimitados';
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

const DAY_MS = 86400000;
const WARNING_DAYS = 3;

/** Dia civil (aaaa-mm-dd) de um instante no fuso pedido, para contar "hoje", "amanhã" e "em N dias" como a pessoa conta. */
function civilDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  return Date.parse(`${parts}T00:00:00Z`);
}

/**
 * Aviso de fim do teste, só para quem está no teste ou acabou de sair dele: nada com mais de 3 dias, nada para Pro ou suspenso.
 * Devolve `{ tone: 'warning' | 'error', daysLeft, text }` ou null. Puro: o relógio e o fuso entram por parâmetro.
 */
export function trialNotice(entitlement, now = Date.now(), { timeZone } = {}) {
  const end = Date.parse(entitlement?.trialEndsAt ?? '');
  if (!Number.isFinite(end) || !['trial', 'inactive', 'expired'].includes(entitlement?.access)) return null;
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(end);
  const left = end - now;
  if (left <= 0) {
    return { tone: 'error', daysLeft: 0, text: `Seu teste terminou em ${date}. Assine o Nexus Pro para continuar usando o NexusIDE.` };
  }
  if (entitlement.access !== 'trial' || left > WARNING_DAYS * DAY_MS) return null;
  const hour = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(end);
  const calendarDays = Math.round((civilDay(end, timeZone) - civilDay(now, timeZone)) / DAY_MS);
  const when = calendarDays <= 0 ? `hoje às ${hour}` : calendarDays === 1 ? `amanhã às ${hour}` : `em ${calendarDays} dias, em ${date}`;
  return { tone: 'warning', daysLeft: Math.ceil(left / DAY_MS), text: `Seu teste termina ${when}. Assine o Nexus Pro para continuar sem interrupção.` };
}

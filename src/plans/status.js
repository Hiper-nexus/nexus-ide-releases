export const PLAN_STATE = { CHECKING: 'consultando', AVAILABLE: 'disponivel', UNAVAILABLE: 'indisponivel', ERROR: 'erro' };

export const STATE_MESSAGES = {
  consultando: 'Consultando as condições de teste e assinatura…',
  disponivel: 'Condições confirmadas pelo servidor. A contratação começa somente quando você escolhe assinar.',
  indisponivel: 'A contratação está indisponível. Nenhuma cobrança será iniciada.',
  erro: 'Não foi possível consultar as condições agora. A contratação está indisponível e nenhuma cobrança será iniciada. Tente novamente mais tarde.',
};

export function validateStatus(data) {
  if (!data || typeof data !== 'object') return null;
  const { ready, auth, billing, trial } = data;
  if (typeof ready !== 'boolean') return null;
  if (!auth || typeof auth.google !== 'boolean' || typeof auth.github !== 'boolean') return null;
  if (!billing || typeof billing.available !== 'boolean') return null;
  if (!trial || !Number.isInteger(trial.days) || trial.days <= 0
    || !Number.isInteger(trial.maxAgents) || trial.maxAgents <= 0
    || typeof trial.cloudSync !== 'boolean') return null;
  // O preço é obrigatório só quando a cobrança está disponível; sem ela o backend pode omitir o valor.
  if (billing.available && (!Number.isInteger(billing.amount) || billing.amount <= 0
    || billing.currency !== 'brl' || billing.interval !== 'month')) return null;
  return {
    ready,
    auth: { google: auth.google, github: auth.github },
    billing: billing.available
      ? { available: true, amount: billing.amount, currency: billing.currency, interval: billing.interval }
      : { available: false },
    trial: { days: trial.days, maxAgents: trial.maxAgents, cloudSync: trial.cloudSync },
  };
}

export function formatPrice(amount) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount / 100);
}

export function describeStatus(data) {
  const status = validateStatus(data);
  if (!status) return { state: PLAN_STATE.UNAVAILABLE, price: null, trial: null };
  const available = status.ready && status.billing.available;
  return {
    state: available ? PLAN_STATE.AVAILABLE : PLAN_STATE.UNAVAILABLE,
    price: available ? `${formatPrice(status.billing.amount)} / mês` : null,
    trial: status.trial,
  };
}

export function planCopy({ state, price = null, trial = null }) {
  return {
    status: STATE_MESSAGES[state] || STATE_MESSAGES.erro,
    price: price || 'Preço indisponível por enquanto.',
    trialDays: trial
      ? `${trial.days} ${trial.days === 1 ? 'dia' : 'dias'} de teste, sem cartão.`
      : 'Dias do teste indisponíveis por enquanto.',
    trialAgents: trial
      ? `Até ${trial.maxAgents} ${trial.maxAgents === 1 ? 'agente simultâneo' : 'agentes simultâneos'}.`
      : 'Limite de agentes indisponível por enquanto.',
    trialSync: trial
      ? (trial.cloudSync ? 'Sincronização em nuvem incluída no teste.' : 'Sem sincronização em nuvem no teste.')
      : 'Sincronização em nuvem a confirmar.',
  };
}

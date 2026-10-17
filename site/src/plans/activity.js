/** Presentation of authenticated account metrics; login dates are never presence. */
const METRICS = [
  ['onlineNow', 'Online agora', 'sinal do app nos últimos 5 min'], ['missionsRunningNow', 'Missões rodando agora', 'app online com missão em curso', true],
  ['missionsTotalCompleted', 'Missões concluídas', 'contadas desde a ativação dos contadores (piso 1 pré-contagem)', true], ['usedToday', 'Usaram hoje', 'agentes ou missões, dia de Brasília'],
  ['used7d', 'Usaram em 7 dias', 'ao menos um dia com uso'], ['startedAgents', 'Abriram agentes', 'já executaram um agente'],
  ['completedMission', 'Fizeram missão', 'já concluíram ao menos uma missão'], ['returned', 'Voltaram em outro dia', 'usaram em dois dias diferentes'],
  ['paidAccounts', 'Pagantes', 'assinatura Stripe ativa'], ['trackedAccounts', 'Contas com medição', 'enviaram ao menos um sinal do app'],
];
// Os dois contadores de missão chegam com a API nova; ausentes, ficam sem valor em vez de virar zero inventado.
const OPTIONAL = new Set(METRICS.filter(row => row[3]).map(row => row[0]));
const FUNNEL = [
  ['totalTrial', 'Em teste ativo'], ['loggedIn', 'Logaram'], ['openedApp', 'Abriram o app'],
  ['usedSystem', 'Usaram o sistema'], ['ranMissions', 'Fizeram missões'], ['active7d', 'Ativos nos últimos 7 dias'],
];
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Funil dos clientes em teste, cada etapa proporcional a totalTrial. Fora do contrato, null: nada é estimado. */
export function funnelView(funnel) {
  if (!funnel || typeof funnel !== 'object' || ![...FUNNEL.map(row => row[0]), 'activeToday', 'onlineNow'].every(key => count(funnel[key]))) return null;
  const total = funnel.totalTrial;
  const steps = FUNNEL.map(([key, label]) => ({ key, label, value: funnel[key], ratio: total === 0 ? 0 : Math.min(1, funnel[key] / total) }));
  return {
    total, steps: steps.map(step => ({ ...step, percent: Math.round(step.ratio * 100) })),
    live: `${funnel.onlineNow} online agora, ${funnel.activeToday} usaram hoje`,
  };
}

export function activityView(data) {
  if (!data || !METRICS.every(([key]) => count(data[key]) || (OPTIONAL.has(key) && data[key] === undefined))) return null;
  if (data.measuringSince !== null && (typeof data.measuringSince !== 'string' || !Number.isFinite(Date.parse(data.measuringSince)))) return null;
  const start = data.measuringSince === null ? 'A medição ainda não recebeu sinais do app atualizado.'
    : `Sinais registrados desde ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.measuringSince))}.`;
  return {
    metrics: METRICS.map(([key, label, hint]) => ({ key, label, hint, value: data[key] ?? null })),
    funnel: funnelView(data.trialFunnel),
    note: `${start} Online significa sinal do app nos últimos 5 minutos, não login. Uso exige execução de agentes ou atividade de missão (iniciada, em curso ou concluída); dias seguem o horário de Brasília. Administradores e cortesias ficam fora destas métricas. Contadores de missões somam eventos desde a ativação da contagem (contas com conclusão anterior partiram de 1/1). Assinantes pagos têm assinatura Stripe ativa; teste e acesso Pro concedido não contam como pagamento.`,
  };
}

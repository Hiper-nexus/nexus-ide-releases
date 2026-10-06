/** Presentation of authenticated account metrics; login dates are never presence. */
const METRICS = [
  ['onlineNow', 'Online agora'], ['usedToday', 'Usaram hoje'], ['used7d', 'Usaram em 7 dias'],
  ['startedAgents', 'Executaram agentes'], ['completedMission', 'Concluíram uma missão'],
  ['returned', 'Voltaram em outro dia'], ['paidAccounts', 'Assinantes pagos'], ['trackedAccounts', 'Contas com medição'],
];
export function activityView(data) {
  if (!data || !METRICS.every(([key]) => Number.isSafeInteger(data[key]) && data[key] >= 0)) return null;
  if (data.measuringSince !== null && (typeof data.measuringSince !== 'string' || !Number.isFinite(Date.parse(data.measuringSince)))) return null;
  const start = data.measuringSince === null ? 'A medição ainda não recebeu sinais do app atualizado.'
    : `Sinais registrados desde ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.measuringSince))}.`;
  return {
    metrics: METRICS.map(([key, label]) => ({ key, label, value: data[key] })),
    note: `${start} Online significa sinal do app nos últimos 5 minutos, não login. Uso exige execução de agentes ou conclusão de missão; dias seguem o horário de Brasília. Administradores e cortesias ficam fora destas métricas. Assinantes pagos têm assinatura Stripe ativa; teste e acesso Pro concedido não contam como pagamento.`,
  };
}

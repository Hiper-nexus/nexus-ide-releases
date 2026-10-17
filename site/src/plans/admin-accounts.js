/**
 * Consulta e leitura da lista de contas do /admin/. Sem DOM e sem rede: o que a tela pede e aceita é decidido
 * aqui e testado. O servidor continua sendo a autoridade (situação, engajamento, parte do e-mail, página de 50).
 * Os campos de uso (app, agentes, missões) são opcionais: uma API antiga continua legível, sem inventar números.
 */

export const ACCOUNT_STATUSES = Object.freeze(['all', 'trial', 'active', 'suspended', 'expired']);
export const ENGAGEMENT_FILTERS = Object.freeze(['all', 'mission_active', 'using_system', 'app_only', 'web_only', 'inactive']);
export const PAGE_LIMIT = 50;
const EMAIL_MAX = 200;
const CURSOR = /^[A-Za-z0-9_-]{1,160}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const STAGES = ['mission_active', 'using_system', 'app_only', 'web_only', 'never_seen'];
const DATE_FIELDS = ['lastAppSeenAt', 'firstAppSeenAt', 'lastActiveAt', 'firstAgentAt', 'firstMissionAt', 'lastMissionAt', 'trialStartedAt', 'trialEndsAt'];
const COUNT_FIELDS = ['missionsStartedCount', 'missionsCompletedCount', 'activeDays7d', 'activeDays30d'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const absent = value => value === undefined || value === null;

/** Query da lista. Valor desconhecido volta para "todas"; e-mail vazio e cursor fora do formato não saem. */
export function accountsQuery({ status, email, cursor, engagement } = {}) {
  const params = new URLSearchParams({ status: ACCOUNT_STATUSES.includes(status) ? status : 'all', limit: String(PAGE_LIMIT) });
  const needle = typeof email === 'string' ? email.trim().slice(0, EMAIL_MAX) : '';
  if (needle !== '') params.set('email', needle);
  if (typeof cursor === 'string' && CURSOR.test(cursor)) params.set('cursor', cursor);
  if (engagement !== 'all' && ENGAGEMENT_FILTERS.includes(engagement)) params.set('engagement', engagement);
  return params.toString();
}

function validAccount(account) {
  if (!isObject(account) || typeof account.id !== 'string' || account.id === '') return false;
  if (typeof account.email !== 'string' || typeof account.role !== 'string' || typeof account.access !== 'string') return false;
  if (!DATE_FIELDS.every(key => absent(account[key]) || isDate(account[key]))) return false;
  if (!COUNT_FIELDS.every(key => absent(account[key]) || (Number.isSafeInteger(account[key]) && account[key] >= 0))) return false;
  if (!absent(account.engagementStage) && !STAGES.includes(account.engagementStage)) return false;
  if (account.lastSeenAt === null) return true;
  return isDate(account.lastSeenAt);
}

/** Página inteira ou null. Um item fora do contrato invalida a página: a lista administrativa não pode omitir gente. */
export function parseAccountsPage(data) {
  if (!isObject(data) || !Array.isArray(data.accounts) || !data.accounts.every(validAccount)) return null;
  const nextCursor = typeof data.nextCursor === 'string' && CURSOR.test(data.nextCursor) ? data.nextCursor : null;
  return { accounts: data.accounts, nextCursor };
}

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** "15/10/2026, 14:32" no horário de Brasília, ou null sem data válida. */
export function formatMoment(value) {
  return isDate(value) ? DATE_TIME.format(new Date(value)) : null;
}

/** "há 12 min", "há 3 dias" e, para datas futuras (fim do teste), "em 4 dias". Menos de 1 min vira "agora". */
export function relativeTime(value, now = Date.now()) {
  if (!isDate(value)) return '';
  const diff = now - Date.parse(value), minutes = Math.floor(Math.abs(diff) / 60_000);
  if (minutes < 1) return 'agora';
  const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const span = minutes < 60 ? `${minutes} min` : hours < 24 ? `${hours} h` : days < 60 ? plural(days, 'dia', 'dias') : plural(Math.floor(days / 30), 'mês', 'meses');
  return diff >= 0 ? `há ${span}` : `em ${span}`;
}

/** Data e tempo relativo juntos; "Sem registro" quando o sinal nunca chegou. */
export function momentText(value, now = Date.now()) {
  const date = formatMoment(value);
  return date === null ? 'Sem registro' : `${date} (${relativeTime(value, now)})`;
}

export const ENGAGEMENT_LABELS = Object.freeze({
  mission_active: 'Fazendo missões', using_system: 'Usando o sistema', app_only: 'Só abriu o app', web_only: 'Só login web', never_seen: 'Sem acesso',
});
/** Estágio do servidor; sem ele (API antiga), deduz só do que a conta já mostra. */
export function stageOf(account) {
  if (STAGES.includes(account.engagementStage)) return account.engagementStage;
  if (isDate(account.lastAppSeenAt)) return 'app_only';
  return isDate(account.lastSeenAt) ? 'web_only' : 'never_seen';
}

export const ACCESS_BADGES = Object.freeze({
  trial: { label: 'Em teste', tone: 'warn' }, pro: { label: 'Pro ativo', tone: 'ok' },
  expired: { label: 'Expirado', tone: 'muted' }, suspended: { label: 'Suspenso', tone: 'bad' },
});
export const accessBadge = access => ACCESS_BADGES[access] ?? { label: 'A confirmar', tone: 'muted' };

/** Presença ao vivo, da mais forte para a mais fraca; null quando a conta não está no app agora. */
export function liveState(account) {
  if (account.missionRunningNow === true) return { label: 'Executando missão', tone: 'ok' };
  if (account.agentWorkingNow === true) return { label: 'Agente trabalhando', tone: 'ok' };
  if (account.onlineNow === true) return { label: 'Online agora', tone: 'info' };
  return null;
}

/** Dias que faltam para o fim do teste. Só conta em teste ou encerrado tem prazo a mostrar. */
export function trialCountdown(account, now = Date.now()) {
  if (!['trial', 'expired'].includes(account.access) || !isDate(account.trialEndsAt)) return '';
  const days = Math.ceil((Date.parse(account.trialEndsAt) - now) / 86_400_000);
  if (account.access === 'expired' || days < 0) return `Encerrado ${relativeTime(account.trialEndsAt, now)}`;
  if (days === 0) return 'Termina hoje';
  return plural(days, 'dia restante', 'dias restantes');
}

/** Leitura em uma frase do que o cliente já fez, para decidir se vale um contato. */
export function diagnose(account) {
  const who = { trial: 'Cliente em teste ativo', pro: 'Assinante', expired: 'Cliente com teste encerrado', suspended: 'Cliente suspenso' }[account.access] ?? 'Cliente';
  if (account.access === 'suspended') return 'Acesso suspenso. Nenhum uso novo é esperado até restaurar.';
  if (account.missionRunningNow === true) return `${who} executando uma missão agora.`;
  const recent = (account.activeDays7d ?? 0) > 0;
  switch (stageOf(account)) {
    case 'mission_active': return recent ? `${who} executando missões.` : `${who} já executou missões, mas não usou o sistema nos últimos 7 dias.`;
    case 'using_system': return `${who} usa agentes, mas ainda não iniciou uma missão.`;
    case 'app_only': return `${who} abriu o app desktop, mas ainda não executou agentes.`;
    case 'web_only': return `${who} logou na web, mas ainda não abriu o app desktop.`;
    default: return `${who} ainda não fez login nem abriu o app.`;
  }
}

export function missionCountsLabel(account) {
  const started = account.missionsStartedCount ?? 0, completed = account.missionsCompletedCount ?? 0;
  return `${started} iniciadas · ${completed} concluídas`;
}

/** Marcos do Raio-X na ordem em que a jornada acontece: [rótulo, texto]. */
export function xrayFacts(account, now = Date.now()) {
  const at = value => momentText(value, now);
  return [
    ['Criado em', at(account.createdAt)], ['Início do trial', at(account.trialStartedAt)], ['Fim do trial', at(account.trialEndsAt)],
    ['Último login OAuth', at(account.lastSeenAt)], ['1º app aberto', at(account.firstAppSeenAt)], ['Último sinal do app', at(account.lastAppSeenAt)],
    ['1º agente', at(account.firstAgentAt)], ['Último uso real', at(account.lastActiveAt)],
    ['1ª missão', at(account.firstMissionAt)], ['Última missão', at(account.lastMissionAt)],
    ['Missões iniciadas / concluídas', `${account.missionsStartedCount ?? 0} / ${account.missionsCompletedCount ?? 0}`],
    ['Dias ativos 7d / 30d', `${account.activeDays7d ?? 0} / ${account.activeDays30d ?? 0}`],
  ];
}

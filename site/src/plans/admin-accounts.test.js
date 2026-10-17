import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_STATUSES, PAGE_LIMIT, accountsQuery, parseAccountsPage } from './admin-accounts.js';

const account = (overrides = {}) => ({
  id: 'acc-1', email: 'ana@example.test', name: 'Ana', role: 'user', access: 'trial',
  trialEndsAt: null, subscriptionStatus: 'none', lastSeenAt: null, ...overrides,
});

test('a consulta combina situação, parte do e-mail e cursor, com teto de 50', () => {
  assert.equal(PAGE_LIMIT, 50);
  assert.deepEqual(ACCOUNT_STATUSES, ['all', 'trial', 'active', 'suspended', 'expired']);
  assert.equal(accountsQuery({}), 'status=all&limit=50');
  assert.equal(accountsQuery({ status: 'trial', email: '  Ana@Example.test  ' }), 'status=trial&limit=50&email=Ana%40Example.test');
  assert.equal(accountsQuery({ status: 'inventada', email: '   ', cursor: '../etc' }), 'status=all&limit=50');
  assert.equal(accountsQuery({ email: 'a'.repeat(250), cursor: 'abc_DEF-123' }), `status=all&limit=50&email=${'a'.repeat(200)}&cursor=abc_DEF-123`);
});

test('a página só vale com lastSeenAt nulo ou data, e um item torto invalida a lista', () => {
  const seen = '2026-10-01T15:04:00.000Z';
  assert.deepEqual(parseAccountsPage({ accounts: [account(), account({ id: 'acc-2', lastSeenAt: seen })], nextCursor: 'abc_DEF-123' }), {
    accounts: [account(), account({ id: 'acc-2', lastSeenAt: seen })], nextCursor: 'abc_DEF-123',
  });
  assert.equal(parseAccountsPage({ accounts: [account()], nextCursor: null }).nextCursor, null);
  assert.equal(parseAccountsPage({ accounts: [account()], nextCursor: 'não' }).nextCursor, null);
  for (const page of [
    null,
    {},
    { accounts: [account({ id: '' })] },
    { accounts: [account({ lastSeenAt: undefined })] },
    { accounts: [account({ lastSeenAt: 'ontem' })] },
    { accounts: [account({ email: 1 })] },
  ]) assert.equal(parseAccountsPage(page), null);
});

import { ENGAGEMENT_FILTERS, accessBadge, diagnose, formatMoment, liveState, momentText, relativeTime, stageOf, trialCountdown, xrayFacts, missionCountsLabel } from './admin-accounts.js';

const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();

test('engagement só sai na consulta quando é um filtro válido e diferente de "all"', () => {
  assert.deepEqual(ENGAGEMENT_FILTERS, ['all', 'mission_active', 'using_system', 'app_only', 'web_only', 'inactive']);
  assert.equal(accountsQuery({ status: 'trial', engagement: 'mission_active' }), 'status=trial&limit=50&engagement=mission_active');
  assert.equal(accountsQuery({ engagement: 'all' }), 'status=all&limit=50');
  assert.equal(accountsQuery({ engagement: 'never_seen' }), 'status=all&limit=50');
  assert.equal(accountsQuery({ engagement: undefined }), 'status=all&limit=50');
});

test('campos novos de uso são opcionais, mas valem o contrato quando chegam', () => {
  const full = account({ firstAppSeenAt: ago(9e8), lastAppSeenAt: ago(6e5), lastActiveAt: ago(3e6), missionsStartedCount: 3, missionsCompletedCount: 2, activeDays7d: 4, activeDays30d: 9, engagementStage: 'mission_active', onlineNow: true });
  assert.equal(parseAccountsPage({ accounts: [full], nextCursor: null }).accounts[0].engagementStage, 'mission_active');
  for (const bad of [{ engagementStage: 'vip' }, { missionsStartedCount: -1 }, { activeDays7d: 1.5 }, { lastActiveAt: 'ontem' }, { lastMissionAt: 7 }]) {
    assert.equal(parseAccountsPage({ accounts: [account(bad)] }), null, JSON.stringify(bad));
  }
});

test('tempo relativo e data seguem o horário de Brasília e nunca inventam', () => {
  assert.equal(relativeTime(ago(30_000), NOW), 'agora');
  assert.equal(relativeTime(new Date(NOW + 9e5).toISOString(), NOW), 'em 15 min');
  assert.equal(relativeTime(new Date(NOW + 4 * 86_400_000).toISOString(), NOW), 'em 4 dias');
  assert.equal(relativeTime(ago(12 * 60_000), NOW), 'há 12 min');
  assert.equal(relativeTime(ago(5 * 3_600_000), NOW), 'há 5 h');
  assert.equal(relativeTime(ago(86_400_000), NOW), 'há 1 dia');
  assert.equal(relativeTime(ago(3 * 86_400_000), NOW), 'há 3 dias');
  assert.equal(relativeTime(ago(95 * 86_400_000), NOW), 'há 3 meses');
  assert.equal(relativeTime(null, NOW), '');
  assert.equal(formatMoment('2026-10-15T15:04:00.000Z'), '15/10/2026, 12:04');
  assert.equal(formatMoment('lixo'), null);
  assert.equal(momentText(undefined, NOW), 'Sem registro');
  assert.equal(momentText(ago(12 * 60_000), NOW), '15/10/2026, 11:48 (há 12 min)');
});

test('estágio, selo de acesso e presença ao vivo têm padrão seguro sem os campos novos', () => {
  assert.equal(stageOf(account()), 'never_seen');
  assert.equal(stageOf(account({ lastSeenAt: ago(1e6) })), 'web_only');
  assert.equal(stageOf(account({ lastSeenAt: ago(1e6), lastAppSeenAt: ago(1e6) })), 'app_only');
  assert.equal(stageOf(account({ engagementStage: 'using_system' })), 'using_system');
  assert.deepEqual(accessBadge('trial'), { label: 'Em teste', tone: 'warn' });
  assert.equal(accessBadge('pro').label, 'Pro ativo');
  assert.equal(accessBadge('estranho').label, 'A confirmar');
  assert.equal(liveState(account()), null);
  assert.equal(liveState(account({ onlineNow: true })).label, 'Online agora');
  assert.equal(liveState(account({ onlineNow: true, agentWorkingNow: true })).label, 'Agente trabalhando');
  assert.equal(liveState(account({ onlineNow: true, agentWorkingNow: true, missionRunningNow: true })).label, 'Executando missão');
});

test('prazo do teste conta dias e só aparece para teste ou teste encerrado', () => {
  const at = days => new Date(NOW + days * 86_400_000 - 1000).toISOString();
  assert.equal(trialCountdown(account({ trialEndsAt: at(5) }), NOW), '5 dias restantes');
  assert.equal(trialCountdown(account({ trialEndsAt: at(1) }), NOW), '1 dia restante');
  assert.equal(trialCountdown(account({ trialEndsAt: at(0) }), NOW), 'Termina hoje');
  assert.equal(trialCountdown(account({ access: 'expired', trialEndsAt: ago(3 * 86_400_000) }), NOW), 'Encerrado há 3 dias');
  assert.equal(trialCountdown(account({ access: 'pro', trialEndsAt: at(5) }), NOW), '');
  assert.equal(trialCountdown(account({ trialEndsAt: null }), NOW), '');
});

test('o diagnóstico separa quem faz missão, quem só testou o app e quem só logou', () => {
  assert.equal(diagnose(account({ engagementStage: 'mission_active', activeDays7d: 2 })), 'Cliente em teste ativo executando missões.');
  assert.match(diagnose(account({ engagementStage: 'mission_active', activeDays7d: 0 })), /não usou o sistema nos últimos 7 dias/);
  assert.match(diagnose(account({ engagementStage: 'mission_active', missionRunningNow: true })), /executando uma missão agora/);
  assert.match(diagnose(account({ engagementStage: 'using_system' })), /ainda não iniciou uma missão/);
  assert.match(diagnose(account({ engagementStage: 'app_only' })), /ainda não executou agentes/);
  assert.equal(diagnose(account({ engagementStage: 'web_only' })), 'Cliente em teste ativo logou na web, mas ainda não abriu o app desktop.');
  assert.match(diagnose(account({ access: 'pro', engagementStage: 'never_seen' })), /^Assinante ainda não fez login/);
  assert.match(diagnose(account({ access: 'suspended', engagementStage: 'mission_active' })), /Acesso suspenso/);
});

test('o Raio-X lista todos os marcos e trata contagens ausentes como zero', () => {
  const facts = new Map(xrayFacts(account({ createdAt: ago(86_400_000), lastSeenAt: ago(12 * 60_000), missionsStartedCount: 3, missionsCompletedCount: 2, activeDays7d: 4, activeDays30d: 9 }), NOW));
  assert.equal(facts.size, 12);
  assert.equal(facts.get('Último login OAuth'), '15/10/2026, 11:48 (há 12 min)');
  assert.equal(facts.get('1º app aberto'), 'Sem registro');
  assert.equal(facts.get('Missões iniciadas / concluídas'), '3 / 2');
  assert.equal(facts.get('Dias ativos 7d / 30d'), '4 / 9');
  assert.equal(new Map(xrayFacts(account(), NOW)).get('Missões iniciadas / concluídas'), '0 / 0');
});

test('1/1 com datas iguais mostra contagem exata, sem falso piso de backfill', () => {
  const day = ago(86_400_000);
  const measured = account({ firstMissionAt: day, lastMissionAt: day, missionsStartedCount: 1, missionsCompletedCount: 1 });
  assert.equal(missionCountsLabel(measured), '1 iniciadas · 1 concluídas');
  assert.equal(new Map(xrayFacts(measured, NOW)).get('Missões iniciadas / concluídas'), '1 / 1');
});

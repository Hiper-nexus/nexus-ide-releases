import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_KINDS, dueNotices, isDeliverableEmail, type NoticeCandidate } from '../src/email/notices.js';

const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000, NOW = 1_790_000_000_000;
const row = (over: Partial<NoticeCandidate> = {}): NoticeCandidate => ({
  id: 'a1', email: 'ana@example.com', name: 'Ana', createdAt: NOW - 5 * DAY, suspendedAt: null, trialExpiresAt: NOW + 10 * DAY,
  noticesOptOut: false, paid: false, isAdmin: false, sentKinds: [], ...over,
});
const kindOf = (candidate: NoticeCandidate, now = NOW) => dueNotices([candidate], now)[0]?.kind ?? null;

test('os quatro tipos de aviso, e só eles', () => {
  assert.deepEqual([...NOTICE_KINDS], ['welcome', 'trial_ending_3d', 'trial_ending_1d', 'trial_ended']);
});

test('faltando mais de 3 dias não há aviso; entre 3 dias (inclusive) e 1 dia (exclusive) é o de 3 dias', () => {
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 3 * DAY + 1 })), null);
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 3 * DAY })), 'trial_ending_3d');
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 2 * DAY })), 'trial_ending_3d');
  assert.equal(kindOf(row({ trialExpiresAt: NOW + DAY + 1 })), 'trial_ending_3d');
});

test('faltando 1 dia ou menos (e ainda sem vencer) é o de 1 dia', () => {
  assert.equal(kindOf(row({ trialExpiresAt: NOW + DAY })), 'trial_ending_1d');
  assert.equal(kindOf(row({ trialExpiresAt: NOW + HOUR })), 'trial_ending_1d');
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 1 })), 'trial_ending_1d');
});

test('no instante exato do fim o teste já acabou, como em accountAccess; vale por 7 dias', () => {
  assert.equal(kindOf(row({ trialExpiresAt: NOW })), 'trial_ended');
  assert.equal(kindOf(row({ trialExpiresAt: NOW - 7 * DAY })), 'trial_ended');
  assert.equal(kindOf(row({ trialExpiresAt: NOW - 7 * DAY - 1 })), null, 'passou a janela: ninguém recebe um "acabou" de semanas atrás');
});

test('boas-vindas só para conta criada nas últimas 24 horas', () => {
  assert.equal(kindOf(row({ createdAt: NOW - HOUR })), 'welcome');
  assert.equal(kindOf(row({ createdAt: NOW - DAY })), 'welcome');
  assert.equal(kindOf(row({ createdAt: NOW - DAY - 1 })), null);
  assert.equal(kindOf(row({ createdAt: NOW + HOUR })), null, 'relógio da conta no futuro não conta como recém-criada');
});

test('janelas que se sobrepõem viram um aviso só por conta, o mais urgente', () => {
  const brandNewShortTrial = row({ createdAt: NOW - HOUR, trialExpiresAt: NOW + 2 * DAY });
  assert.equal(kindOf(brandNewShortTrial), 'trial_ending_3d');
  assert.equal(kindOf(row({ createdAt: NOW - HOUR, trialExpiresAt: NOW + HOUR })), 'trial_ending_1d');
  assert.equal(dueNotices([brandNewShortTrial], NOW).length, 1);
});

test('o tipo mais urgente já enviado não cai para um menos urgente: nada sai', () => {
  const shortTrial = row({ createdAt: NOW - HOUR, trialExpiresAt: NOW + HOUR });
  assert.equal(kindOf({ ...shortTrial, sentKinds: ['trial_ending_1d'] }), null, 'welcome não sai depois do aviso de 1 dia');
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 2 * DAY, sentKinds: ['trial_ending_3d'] })), null);
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 2 * DAY, sentKinds: ['welcome'] })), 'trial_ending_3d', 'outro tipo enviado não bloqueia');
});

test('não recebe aviso: suspensa, Pro ou concessão paga, administradora, quem saiu da lista e sem teto de e-mail válido', () => {
  const due = { trialExpiresAt: NOW + 2 * DAY };
  assert.equal(kindOf(row({ ...due, suspendedAt: NOW - 1 })), null);
  assert.equal(kindOf(row({ ...due, paid: true })), null);
  assert.equal(kindOf(row({ ...due, isAdmin: true })), null);
  assert.equal(kindOf(row({ ...due, noticesOptOut: true })), null);
  assert.equal(kindOf(row({ ...due })), 'trial_ending_3d');
});

test('conta sem teste (trial nulo) só pode receber as boas-vindas', () => {
  assert.equal(kindOf(row({ trialExpiresAt: null })), null);
  assert.equal(kindOf(row({ trialExpiresAt: null, createdAt: NOW - HOUR })), 'welcome');
});

test('e-mail: aceita endereço comum e recusa o que o login grava quando o provedor não dá e-mail verificado', () => {
  for (const good of ['ana@example.com', 'ana.silva+nexus@sub.example.com.br', 'a@b.co']) assert.equal(isDeliverableEmail(good), true, good);
  for (const bad of ['github:12345', 'google:abc', '', 'sem-arroba', 'a@b', '@b.com', 'a@', 'a b@c.com', 'a@b .com', 'a@b.com\r\nBcc: x@y.z', '<a@b.com>', 'a,b@c.com', `${'x'.repeat(250)}@b.com`, null, undefined, 42]) {
    assert.equal(isDeliverableEmail(bad as string), false, String(bad));
  }
  assert.equal(kindOf(row({ trialExpiresAt: NOW + 2 * DAY, email: 'github:123' })), null);
});

test('o resultado leva só o necessário e o fim do teste em ISO', () => {
  const [due] = dueNotices([row({ trialExpiresAt: NOW + 2 * DAY, name: null })], NOW);
  assert.deepEqual(due, { accountId: 'a1', email: 'ana@example.com', name: null, kind: 'trial_ending_3d', trialEndsAt: new Date(NOW + 2 * DAY).toISOString() });
});

test('entrada inválida (tempo NaN) não gera aviso e não lança', () => {
  assert.deepEqual(dueNotices([row()], Number.NaN), []);
  assert.deepEqual(dueNotices([row({ trialExpiresAt: Number.NaN })], NOW), []);
});

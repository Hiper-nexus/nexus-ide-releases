import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLimitLabel, billingFlags } from './account-rules.js';

const open = { ready: true, billing: { available: true } };
const closed = { ready: false, billing: { available: true } };
const customer = { authenticated: true, entitlement: { access: 'pro' }, billing: { portal: true } };
const trial = { authenticated: true, entitlement: { access: 'trial' }, billing: { portal: false } };

test('com as vendas fechadas quem já assina continua gerenciando a cobrança pelo portal', () => {
  const flags = billingFlags(closed, customer, false);
  assert.equal(flags.portalVisible, true);
  assert.equal(flags.portalEnabled, true, 'fechar novas vendas não pode prender o cliente pago');
  assert.equal(flags.checkoutEnabled, false);
  assert.match(flags.status, /portal/i);
});

test('conta suspensa com assinatura também alcança o portal com as vendas fechadas', () => {
  const flags = billingFlags(closed, { ...customer, entitlement: { access: 'suspended' } }, false);
  assert.equal(flags.portalEnabled, true);
  assert.equal(flags.checkoutEnabled, false);
});

test('checkout só abre com vendas abertas, cobrança disponível, sessão e sem Pro', () => {
  assert.equal(billingFlags(open, trial, false).checkoutEnabled, true);
  assert.equal(billingFlags(closed, trial, false).checkoutEnabled, false);
  assert.equal(billingFlags({ ready: true, billing: { available: false } }, trial, false).checkoutEnabled, false);
  assert.equal(billingFlags(open, { authenticated: false }, false).checkoutEnabled, false);
  assert.equal(billingFlags(open, customer, false).checkoutEnabled, false);
  assert.equal(billingFlags(open, trial, true).checkoutEnabled, false, 'ocupado desabilita');
});

test('sem cobrança configurada ou sem status o portal fica desabilitado e nada é prometido', () => {
  assert.equal(billingFlags({ ready: true, billing: { available: false } }, customer, false).portalEnabled, false);
  const unknown = billingFlags(null, customer, false);
  assert.equal(unknown.portalEnabled, false);
  assert.match(unknown.status, /indisponível/);
  assert.equal(billingFlags(open, trial, false).portalVisible, false, 'sem cliente no Stripe não há portal');
});

test('limite de agentes: número, sem limite do teste no Pro e a confirmar quando o contrato vem estranho', () => {
  assert.equal(agentLimitLabel(2), '2');
  assert.equal(agentLimitLabel(null), 'Sem limite do teste');
  assert.equal(agentLimitLabel(undefined), 'A confirmar');
  assert.equal(agentLimitLabel('7'), 'A confirmar');
});

test('com a cobrança fora do ar o texto não promete portal nem fala em contratação para quem já é Pro', () => {
  const down = { ready: true, billing: { available: false } };
  const pro = billingFlags(down, customer, false);
  assert.equal(pro.portalEnabled, false);
  assert.match(pro.status, /Pro está confirmado/);
  assert.doesNotMatch(pro.status, /Use o portal/);
  const suspended = billingFlags(down, { ...customer, entitlement: { access: 'suspended' } }, false);
  assert.match(suspended.status, /suspenso/);
  assert.doesNotMatch(suspended.status, /portal de cobrança continua disponível/);
});

test('suspenso sem cliente no Stripe não ouve que o portal continua disponível, e portal oculto nunca fica habilitado', () => {
  const flags = billingFlags(open, { authenticated: true, entitlement: { access: 'suspended' }, billing: { portal: false } }, false);
  assert.doesNotMatch(flags.status, /portal/);
  assert.equal(flags.portalVisible, false);
  assert.equal(flags.portalEnabled, false);
  assert.equal(billingFlags(open, trial, false).portalEnabled, false);
});

test('sem login e com as vendas abertas o botão não é um beco sem saída: vira "Entrar para assinar"', () => {
  const signedOut = billingFlags(open, { authenticated: false }, false);
  assert.equal(signedOut.subscribeAction, 'login');
  assert.equal(signedOut.subscribeEnabled, true);
  assert.equal(signedOut.subscribeLabel, 'Entrar para assinar');
  assert.equal(signedOut.checkoutEnabled, false, 'ainda não existe checkout sem sessão');
});

test('logado e sem Pro o botão abre o checkout; com Pro, suspenso ou vendas fechadas ele fica desligado', () => {
  const ready = billingFlags(open, trial, false);
  assert.deepEqual([ready.subscribeAction, ready.subscribeEnabled, ready.subscribeLabel], ['checkout', true, 'Assinar Nexus Pro ↗']);
  for (const [availability, session] of [[open, customer], [open, { ...customer, entitlement: { access: 'suspended' } }], [closed, trial], [closed, { authenticated: false }], [{ ready: true, billing: { available: false } }, { authenticated: false }]]) {
    const flags = billingFlags(availability, session, false);
    assert.equal(flags.subscribeAction, 'none');
    assert.equal(flags.subscribeEnabled, false);
  }
});

test('ocupado desliga o botão nos dois modos, para o clique duplo não repetir a ação', () => {
  assert.equal(billingFlags(open, { authenticated: false }, true).subscribeEnabled, false);
  assert.equal(billingFlags(open, trial, true).subscribeEnabled, false);
});

const DAY = 86400000;
const NOW = Date.parse('2026-10-10T15:00:00Z');
const tz = { timeZone: 'America/Sao_Paulo' };
const trialEnding = (ms, access = 'trial') => ({ access, trialEndsAt: new Date(NOW + ms).toISOString() });

test('aviso de fim do teste: com mais de 3 dias, Pro ou suspenso não há aviso', async () => {
  const { trialNotice } = await import('./account-rules.js');
  assert.equal(trialNotice(trialEnding(3 * DAY + 1000), NOW, tz), null);
  assert.equal(trialNotice(trialEnding(10 * DAY), NOW, tz), null);
  assert.equal(trialNotice({ access: 'pro', trialEndsAt: new Date(NOW + DAY).toISOString() }, NOW, tz), null);
  assert.equal(trialNotice({ access: 'suspended', trialEndsAt: new Date(NOW - DAY).toISOString() }, NOW, tz), null);
  assert.equal(trialNotice(null, NOW, tz), null);
  assert.equal(trialNotice({ access: 'trial', trialEndsAt: null }, NOW, tz), null);
  assert.equal(trialNotice({ access: 'trial', trialEndsAt: 'lixo' }, NOW, tz), null);
});

test('aviso de fim do teste: de 3 a 2 dias fala em dias e na data; até 24 h fala em hoje e na hora', async () => {
  const { trialNotice } = await import('./account-rules.js');
  const three = trialNotice(trialEnding(3 * DAY), NOW, tz);
  assert.deepEqual([three.tone, three.daysLeft], ['warning', 3]);
  assert.match(three.text, /termina em 3 dias, em 13\/10\/2026/);
  const two = trialNotice(trialEnding(2 * DAY - 1000), NOW, tz);
  assert.equal(two.daysLeft, 2);
  const today = trialNotice(trialEnding(5 * 3600 * 1000), NOW, tz);
  assert.equal(today.daysLeft, 1);
  assert.match(today.text, /termina hoje às 17:00/);
  const tomorrow = trialNotice(trialEnding(DAY), NOW, tz);
  assert.match(tomorrow.text, /termina hoje às|termina amanhã/);
  for (const notice of [three, two, today]) assert.match(notice.text, /Assine o Nexus Pro/);
});

test('aviso de fim do teste: depois do fim, sem Pro, é erro com a data e o caminho para assinar', async () => {
  const { trialNotice } = await import('./account-rules.js');
  for (const access of ['inactive', 'expired', 'trial']) {
    const ended = trialNotice(trialEnding(-DAY, access), NOW, tz);
    assert.equal(ended.tone, 'error', access);
    assert.match(ended.text, /terminou em 09\/10\/2026/);
    assert.match(ended.text, /Assine o Nexus Pro/);
  }
});

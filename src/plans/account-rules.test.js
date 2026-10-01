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

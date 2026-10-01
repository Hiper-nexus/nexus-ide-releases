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

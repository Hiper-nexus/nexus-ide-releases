import test from 'node:test';
import assert from 'node:assert/strict';
import { provision, keyMode, instructions, main, WEBHOOK_EVENTS, WEBHOOK_URL } from '../scripts/provision-stripe.mjs';

function fakeStripe() {
  let n = 0;
  const id = prefix => `${prefix}_${++n}`;
  const store = { products: [], prices: [], portals: [], hooks: [] };
  const calls = [];
  const resource = (name, list, extra = {}) => ({
    list: async () => ({ data: list(), has_more: false }),
    ...extra,
  });
  const stripe = {
    products: resource('products', () => store.products, {
      create: async params => { calls.push('products.create'); const item = { id: id('prod'), active: true, default_price: null, ...params }; store.products.push(item); return item; },
      update: async (pid, params) => { calls.push('products.update'); Object.assign(store.products.find(p => p.id === pid), params); },
    }),
    prices: { list: async ({ product }) => ({ data: store.prices.filter(p => p.product === product), has_more: false }),
      create: async params => { calls.push('prices.create'); const item = { id: id('price'), active: true, ...params }; store.prices.push(item); return item; } },
    billingPortal: { configurations: resource('portal', () => store.portals, {
      create: async params => { calls.push('portal.create'); const item = { id: id('bpc'), active: true, is_default: false, ...params }; store.portals.push(item); return item; },
      update: async (pid, params) => { calls.push('portal.update'); Object.assign(store.portals.find(p => p.id === pid), params); },
    }) },
    webhookEndpoints: resource('hooks', () => store.hooks, {
      create: async params => { calls.push('webhook.create'); const item = { id: id('we'), status: 'enabled', secret: 'whsec_fixture', ...params }; store.hooks.push(item); return item; },
      update: async (hid, params) => { calls.push('webhook.update'); Object.assign(store.hooks.find(h => h.id === hid), params); },
    }),
  };
  return { stripe, store, calls };
}

test('a primeira execução cria produto, preço, portal e webhook com os seis eventos', async () => {
  const { stripe, store, calls } = fakeStripe();
  const result = await provision(stripe);
  assert.deepEqual(calls, ['products.create', 'prices.create', 'products.update', 'portal.create', 'webhook.create']);
  assert.equal(store.prices[0].unit_amount, 5999);
  assert.equal(store.prices[0].currency, 'brl');
  assert.deepEqual(store.prices[0].recurring, { interval: 'month', interval_count: 1 });
  assert.equal(store.products[0].default_price, result.priceId);
  assert.equal(store.portals[0].features.subscription_cancel.mode, 'at_period_end');
  assert.equal(store.portals[0].features.subscription_update.enabled, false);
  assert.equal(store.hooks[0].url, WEBHOOK_URL);
  assert.deepEqual(store.hooks[0].enabled_events, WEBHOOK_EVENTS);
  assert.equal(result.webhookSecret, 'whsec_fixture');
});

test('rodar de novo não duplica nada e corrige eventos alterados no painel', async () => {
  const fake = fakeStripe();
  await provision(fake.stripe);
  fake.calls.length = 0;
  fake.store.hooks[0].enabled_events = ['invoice.paid'];
  const again = await provision(fake.stripe);
  assert.deepEqual(fake.calls, ['portal.update', 'webhook.update']);
  assert.equal(fake.store.products.length, 1);
  assert.equal(fake.store.prices.length, 1);
  assert.equal(fake.store.hooks.length, 1);
  assert.equal(again.webhookSecret, null, 'o segredo só aparece na criação');
  assert.match(instructions(again, 'test'), /copie o signing secret no painel/);
});

test('simulação lista o que faria sem escrever', async () => {
  const { stripe, calls } = fakeStripe();
  const lines = [];
  await provision(stripe, { dryRun: true, log: line => lines.push(line) });
  assert.deepEqual(calls, []);
  assert.ok(lines.every(line => line.startsWith('[simulação]')) && lines.length >= 4);
});

test('a chave de produção exige --live e a chave nunca aparece na saída', async () => {
  assert.equal(keyMode('sk_live_abc'), 'live');
  assert.equal(keyMode('rk_test_abc'), 'test');
  assert.equal(keyMode(''), 'missing');
  assert.equal(keyMode('pk_test_abc'), 'unknown');
  const errors = [];
  const original = console.error;
  console.error = line => errors.push(String(line));
  try {
    assert.equal(await main([], { STRIPE_SECRET_KEY: 'sk_live_secretvalue' }), 2);
    assert.equal(await main([], {}), 2);
  } finally { console.error = original; }
  assert.ok(errors.some(line => /--live/.test(line)));
  assert.ok(errors.every(line => !line.includes('secretvalue')));
});

test('reaproveita o produto e o preço que já existem na conta de produção (metadata do catálogo antigo)', async () => {
  const fake = fakeStripe();
  fake.store.products.push({ id: 'prod_legado', active: true, name: 'NexusIDE Pro', default_price: 'price_legado', metadata: { nexusProduct: 'nexuside_pro', plan: 'pro' } });
  fake.store.prices.push({ id: 'price_legado', product: 'prod_legado', active: true, currency: 'brl', unit_amount: 5999, recurring: { interval: 'month', interval_count: 1 } });
  const result = await provision(fake.stripe);
  assert.equal(result.productId, 'prod_legado');
  assert.equal(result.priceId, 'price_legado');
  assert.equal(fake.store.products.length, 1, 'não cria um segundo Nexus Pro');
  assert.equal(fake.store.prices.length, 1, 'não cria um segundo preço de R$ 59,99');
  assert.deepEqual(fake.calls, ['portal.create', 'webhook.create']);
});

test('em produção, recusa antes de mexer em qualquer coisa se o Customer Portal padrão é de outro uso da conta', async () => {
  const fake = fakeStripe();
  fake.store.portals.push({ id: 'bpc_outro', active: true, is_default: true, metadata: {}, features: { subscription_cancel: { enabled: false } } });
  await assert.rejects(provision(fake.stripe, { protectForeignPortal: true }), /Customer Portal padrão/);
  assert.deepEqual(fake.calls, [], 'nenhuma escrita antes da recusa: nem produto, nem preço, nem webhook');
  assert.equal(fake.store.portals[0].features.subscription_cancel.enabled, false, 'o portal alheio fica como estava');
});

test('em produção, atualiza o portal que o próprio script criou e cria o do Nexus quando a conta não tem nenhum', async () => {
  const mine = fakeStripe();
  mine.store.portals.push({ id: 'bpc_nexus', active: true, is_default: true, metadata: { nexus_portal: 'pro' } });
  await provision(mine.stripe, { protectForeignPortal: true });
  assert.ok(mine.calls.includes('portal.update'));
  const none = fakeStripe();
  await provision(none.stripe, { protectForeignPortal: true });
  assert.ok(none.calls.includes('portal.create'));
});

test('main só liga a proteção do portal alheio com chave de produção', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../scripts/provision-stripe.mjs', import.meta.url), 'utf8');
  assert.match(source, /protectForeignPortal: mode === 'live'/);
});

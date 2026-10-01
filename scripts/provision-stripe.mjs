#!/usr/bin/env node
/** Provisiona o Stripe do Nexus Pro de forma idempotente: produto, preço mensal
 * em BRL, Customer Portal e o webhook da API. Rodar de novo não duplica nada.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:provision [-- --dry-run] [-- --json]
 *   STRIPE_SECRET_KEY=sk_live_... npm run stripe:provision -- --live
 *
 * A chave vem só do ambiente e nunca é impressa. */
import { pathToFileURL } from 'node:url';

export const PRODUCT = { name: 'Nexus Pro', metadata: { nexus_product: 'pro' } };
export const PRICE = { currency: 'brl', unit_amount: 5999, recurring: { interval: 'month', interval_count: 1 }, metadata: { nexus_price: 'pro-monthly' } };
export const WEBHOOK_URL = 'https://api.nexuside.app/v1/billing/webhook';
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
export const PORTAL = {
  business_profile: { headline: 'Gerencie sua assinatura do Nexus Pro' },
  default_return_url: 'https://nexuside.app/conta/',
  features: {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: false },
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    subscription_update: { enabled: false },
  },
};

async function listAll(resource, params = {}) {
  const items = [];
  let starting_after;
  for (;;) {
    const page = await resource.list({ limit: 100, ...params, ...(starting_after ? { starting_after } : {}) });
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) return items;
    starting_after = page.data[page.data.length - 1].id;
  }
}

const samePrice = price => price.active && price.currency === PRICE.currency && price.unit_amount === PRICE.unit_amount
  && price.recurring?.interval === PRICE.recurring.interval && price.recurring?.interval_count === PRICE.recurring.interval_count;

export function keyMode(key) {
  if (!key) return 'missing';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  return 'unknown';
}

/** Faz o trabalho com um cliente Stripe injetado. Devolve o que foi encontrado ou criado. */
export async function provision(stripe, { dryRun = false, log = () => {} } = {}) {
  const result = { created: [], updated: [], webhookSecret: null };
  const note = (kind, what) => { result[kind].push(what); log(`${dryRun ? '[simulação] ' : ''}${kind === 'created' ? 'criar' : 'atualizar'}: ${what}`); };

  let product = (await listAll(stripe.products, { active: true })).find(item => item.metadata?.nexus_product === PRODUCT.metadata.nexus_product);
  if (!product) {
    note('created', 'produto Nexus Pro');
    product = dryRun ? { id: 'prod_simulado' } : await stripe.products.create({ name: PRODUCT.name, metadata: PRODUCT.metadata });
  }
  result.productId = product.id;

  let price = dryRun && product.id === 'prod_simulado' ? null : (await listAll(stripe.prices, { product: product.id, active: true })).find(samePrice);
  if (!price) {
    note('created', 'preço R$ 59,99 por mês');
    price = dryRun ? { id: 'price_simulado' } : await stripe.prices.create({ product: product.id, ...PRICE });
  }
  result.priceId = price.id;
  if (product.default_price !== price.id) {
    note('updated', 'preço padrão do produto');
    if (!dryRun) await stripe.products.update(product.id, { default_price: price.id });
  }

  const portals = await listAll(stripe.billingPortal.configurations, { active: true });
  const portal = portals.find(item => item.is_default) ?? portals.find(item => item.metadata?.nexus_portal === 'pro');
  if (portal) {
    note('updated', `Customer Portal ${portal.id}`);
    if (!dryRun) await stripe.billingPortal.configurations.update(portal.id, PORTAL);
    result.portalId = portal.id;
    result.portalIsDefault = Boolean(portal.is_default);
  } else {
    note('created', 'Customer Portal');
    const created = dryRun ? { id: 'bpc_simulado', is_default: false } : await stripe.billingPortal.configurations.create({ ...PORTAL, metadata: { nexus_portal: 'pro' } });
    result.portalId = created.id;
    result.portalIsDefault = Boolean(created.is_default);
  }

  const hooks = await listAll(stripe.webhookEndpoints);
  const hook = hooks.find(item => item.url === WEBHOOK_URL);
  if (hook) {
    const events = [...hook.enabled_events].sort().join(',');
    if (events !== [...WEBHOOK_EVENTS].sort().join(',') || hook.status === 'disabled') {
      note('updated', 'eventos do webhook');
      if (!dryRun) await stripe.webhookEndpoints.update(hook.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
    }
    result.webhookId = hook.id;
  } else {
    note('created', `webhook ${WEBHOOK_URL}`);
    const created = dryRun ? { id: 'we_simulado', secret: null } : await stripe.webhookEndpoints.create({ url: WEBHOOK_URL, enabled_events: WEBHOOK_EVENTS, description: 'Nexus Cloud API', metadata: { nexus_webhook: 'billing' } });
    result.webhookId = created.id;
    result.webhookSecret = created.secret ?? null;
  }
  return result;
}

export function instructions(result, mode) {
  const lines = [
    '',
    `Stripe (${mode === 'live' ? 'PRODUÇÃO' : 'teste'}) pronto.`,
    `  produto ${result.productId}`,
    `  preço   ${result.priceId}`,
    `  portal  ${result.portalId}${result.portalIsDefault ? '' : ' (não é o padrão: abra Settings > Billing > Customer portal e salve uma vez)'}`,
    `  webhook ${result.webhookId}`,
    '',
    'Próximos passos, no repositório nexus-cloud-api:',
    `  1. Em wrangler.jsonc, vars: "STRIPE_PRICE_PRO":"${result.priceId}"`,
    '  2. npx wrangler secret put STRIPE_SECRET_KEY        (cole a mesma chave usada aqui)',
    result.webhookSecret
      ? '  3. npx wrangler secret put STRIPE_WEBHOOK_SECRET    (rode com --json para ver o whsec_ desta criação)'
      : '  3. npx wrangler secret put STRIPE_WEBHOOK_SECRET    (o webhook já existia: copie o signing secret no painel do Stripe)',
    '  4. npx wrangler deploy',
  ];
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes('--dry-run');
  const asJson = argv.includes('--json');
  const key = env.STRIPE_SECRET_KEY;
  const mode = keyMode(key);
  if (mode === 'missing') { console.error('Defina STRIPE_SECRET_KEY no ambiente.'); return 2; }
  if (mode === 'unknown') { console.error('STRIPE_SECRET_KEY não parece uma chave do Stripe.'); return 2; }
  if (mode === 'live' && !argv.includes('--live')) { console.error('Chave de produção detectada. Rode de novo com --live se é isso mesmo.'); return 2; }
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(key);
  const result = await provision(stripe, { dryRun, log: line => console.error(line) });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log(instructions(result, mode));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Falhou: ${error.message}`); process.exitCode = 1; });
}

export { main };

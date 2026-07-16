import Stripe from 'stripe';
import { PRO_MONTHLY_PRICE } from '../../shared/pricing';

const PRODUCT_MARKER = 'nexuside_pro';
const PRICE_LOOKUP_KEY = 'nexuside_pro_brl_monthly_5999';
const PAGE_LIMIT = 100;

function isExpectedPrice(price: Stripe.Price): boolean {
  return price.active
    && price.currency === PRO_MONTHLY_PRICE.currency
    && price.unit_amount === PRO_MONTHLY_PRICE.unitAmount
    && price.type === 'recurring'
    && price.recurring?.interval === PRO_MONTHLY_PRICE.interval
    && price.recurring.interval_count === PRO_MONTHLY_PRICE.intervalCount;
}
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

async function provision(): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error('Defina STRIPE_SECRET_KEY no ambiente antes de provisionar.');
  }

  const stripe = new Stripe(secretKey);
  const products = await stripe.products.list({ active: true, limit: PAGE_LIMIT });
  let product = products.data.find(
    (candidate) => candidate.metadata.nexusProduct === PRODUCT_MARKER,
  );

  if (!product) {
    product = await stripe.products.create({
      name: 'NexusIDE Pro',
      description: 'Plano mensal Pro do NexusIDE, cobrado em reais.',
      metadata: {
        nexusProduct: PRODUCT_MARKER,
        plan: 'pro',
      },
    });
  }

  const prices = await stripe.prices.list({
    active: true,
    product: product.id,
    type: 'recurring',
    limit: PAGE_LIMIT,
  });
  let price = prices.data.find(isExpectedPrice);

  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      currency: PRO_MONTHLY_PRICE.currency,
      unit_amount: PRO_MONTHLY_PRICE.unitAmount,
      recurring: {
        interval: PRO_MONTHLY_PRICE.interval,
        interval_count: PRO_MONTHLY_PRICE.intervalCount,
      },
      lookup_key: PRICE_LOOKUP_KEY,
      nickname: 'Pro promocional, R$ 59,99/mês',
      metadata: {
        plan: 'pro',
        offer: 'promotional',
      },
    });
  }

  if (idOf(product.default_price) !== price.id) {
    product = await stripe.products.update(product.id, { default_price: price.id });
  }

  const legacyPrices = prices.data.filter(
    (candidate) => candidate.active && candidate.id !== price.id,
  );
  const mode = secretKey.startsWith('sk_live_') ? 'live' : 'test';

  console.log(`Stripe mode: ${mode}`);
  console.log(`Product: ${product.id}`);
  console.log(`STRIPE_PRICE_PRO=${price.id}`);
  if (legacyPrices.length > 0) {
    console.log(
      `Aviso: ${legacyPrices.length} Price(s) antigo(s) continuam ativos; `
      + 'arquive-os no Dashboard somente após revisar assinaturas existentes.',
    );
  }
}

try {
  await provision();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

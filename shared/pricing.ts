/** Contrato comercial público. Valores monetários ficam sempre em centavos. */
export const PRO_MONTHLY_PRICE = Object.freeze({
  currency: 'brl' as const,
  unitAmount: 5_999,
  interval: 'month' as const,
  intervalCount: 1,
});

/** Mesmo valor mensal vezes os meses. Nenhum período embute desconto. */
export const PRO_INTERVAL_PRICES = Object.freeze([
  Object.freeze({ id: 'month' as const, months: 1, unitAmount: PRO_MONTHLY_PRICE.unitAmount, label: 'Mensal', cadence: 'por mês' }),
  Object.freeze({ id: 'quarter' as const, months: 3, unitAmount: PRO_MONTHLY_PRICE.unitAmount * 3, label: 'Trimestral', cadence: 'a cada 3 meses' }),
  Object.freeze({ id: 'semiannual' as const, months: 6, unitAmount: PRO_MONTHLY_PRICE.unitAmount * 6, label: 'Semestral', cadence: 'a cada 6 meses' }),
  Object.freeze({ id: 'year' as const, months: 12, unitAmount: PRO_MONTHLY_PRICE.unitAmount * 12, label: 'Anual', cadence: 'por ano' }),
]);

export type PublicPlanId = 'free' | 'pro';

/** Contrato comercial público. Valores monetários ficam sempre em centavos. */
export const PRO_MONTHLY_PRICE = Object.freeze({
  currency: 'brl' as const,
  unitAmount: 5_999,
  interval: 'month' as const,
  intervalCount: 1,
});

export type PublicPlanId = 'free' | 'pro';

import type { CheckoutInterval, CheckoutRequest } from '../../../shared/billing-types';
import { PRO_INTERVAL_PRICES } from '../../../shared/billing-types';

export interface CheckoutChoice {
  interval: CheckoutInterval;
  coupon: string;
}

export const DEFAULT_CHECKOUT_CHOICE: CheckoutChoice = { interval: 'month', coupon: '' };

/** Mensal sem cupom continua o contrato antigo `{ plan: 'pro' }` / a string `'pro'`. */
export function checkoutRequestFrom(choice: CheckoutChoice): 'pro' | CheckoutRequest {
  const coupon = choice.coupon.trim();
  if (choice.interval === 'month' && coupon === '') return 'pro';
  const body: CheckoutRequest = { plan: 'pro' };
  if (choice.interval !== 'month') body.interval = choice.interval;
  if (coupon !== '') body.coupon = coupon;
  return body;
}

export function CheckoutChoices({
  group,
  value,
  onChange,
  disabled = false,
}: {
  group: string;
  value: CheckoutChoice;
  onChange: (next: CheckoutChoice) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="checkout-choices" disabled={disabled}>
      <legend>Período</legend>
      <div className="checkout-choices__intervals" role="radiogroup" aria-label="Período da assinatura">
        {PRO_INTERVAL_PRICES.map((spec) => (
          <label key={spec.id}>
            <input
              type="radio"
              name={group}
              value={spec.id}
              checked={value.interval === spec.id}
              onChange={() => onChange({ ...value, interval: spec.id })}
            />
            <span>{spec.label}</span>
          </label>
        ))}
      </div>
      <label className="checkout-choices__coupon" htmlFor={`${group}-coupon`}>
        Cupom
        <input
          id={`${group}-coupon`}
          type="text"
          value={value.coupon}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
          placeholder="Opcional"
          onChange={(event) => onChange({ ...value, coupon: event.target.value })}
        />
      </label>
    </fieldset>
  );
}

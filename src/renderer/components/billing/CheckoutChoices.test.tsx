/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutChoices, checkoutRequestFrom, DEFAULT_CHECKOUT_CHOICE } from './CheckoutChoices';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('checkoutRequestFrom', () => {
  it('mantém o atalho mensal sem cupom e inclui período ou código quando existem', () => {
    expect(checkoutRequestFrom(DEFAULT_CHECKOUT_CHOICE)).toBe('pro');
    expect(checkoutRequestFrom({ interval: 'quarter', coupon: '' })).toEqual({ plan: 'pro', interval: 'quarter' });
    expect(checkoutRequestFrom({ interval: 'semiannual', coupon: '  ' })).toEqual({ plan: 'pro', interval: 'semiannual' });
    expect(checkoutRequestFrom({ interval: 'year', coupon: 'NEXUS10' })).toEqual({ plan: 'pro', interval: 'year', coupon: 'NEXUS10' });
    expect(checkoutRequestFrom({ interval: 'month', coupon: 'VERAO' })).toEqual({ plan: 'pro', coupon: 'VERAO' });
  });
});

describe('CheckoutChoices', () => {
  it('mostra os quatro períodos e devolve a escolha sem roubar o foco do botão de assinar', async () => {
    const onChange = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <>
          <CheckoutChoices group="account-interval" value={DEFAULT_CHECKOUT_CHOICE} onChange={onChange} />
          <button type="button" data-access-initial-focus="">Assinar Pro</button>
        </>,
      );
    });
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.value)).toEqual(['month', 'quarter', 'semiannual', 'year']);
    expect(radios.find((radio) => radio.checked)?.value).toBe('month');
    expect(host.querySelector('[data-access-initial-focus]')?.textContent).toBe('Assinar Pro');
    const quarter = radios.find((radio) => radio.value === 'quarter')!;
    await act(async () => quarter.click());
    expect(onChange).toHaveBeenCalledWith({ interval: 'quarter', coupon: '' });
    const coupon = host.querySelector<HTMLInputElement>('#account-interval-coupon')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(coupon, 'nexus10');
      coupon.dispatchEvent(new Event('input', { bubbles: true }));
      coupon.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ interval: 'month', coupon: 'nexus10' });
  });
});

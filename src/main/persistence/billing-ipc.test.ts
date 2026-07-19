import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CHANNELS } from '../../shared/billing-types';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    openExternal: vi.fn(),
  };
});

const billingDeps = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  startCheckoutPolling: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  shell: { openExternal: electronMock.openExternal },
}));

describe('registerBillingIpc', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    electronMock.handlers.clear();
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { url: 'https://checkout.stripe.com/session' } },
    });
    const mod = await import('./billing-ipc');
    mod.registerBillingIpc({
      apiFetch: billingDeps.apiFetch,
      openExternal: electronMock.openExternal,
      startCheckoutPolling: billingDeps.startCheckoutPolling,
    });
  });

  it('repassa o checkout Pro como único plano pago', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);
    expect(handler).toBeDefined();

    const result = await handler?.(null, { plan: 'pro' });

    expect(result).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenCalledWith('/v1/billing/checkout', {
      method: 'POST',
      body: { plan: 'pro' },
    });
    expect(electronMock.openExternal).toHaveBeenCalledWith(
      'https://checkout.stripe.com/session',
    );
    expect(billingDeps.startCheckoutPolling).toHaveBeenCalledTimes(1);
  });

  it('recusa plano inválido sem mapear para Pro', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);

    const result = await handler?.(null, 'free');

    expect(result).toEqual({ ok: false, error: 'plano inválido' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });

  it('recusa o plano Team legado no checkout', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);

    const result = await handler?.(null, { plan: 'team', seats: 3 });

    expect(result).toEqual({ ok: false, error: 'plano inválido' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://insecure.example/checkout',
    'https://evil.example/checkout',
  ])('recusa URL de checkout sem https: %s', async (url) => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { url } },
    });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);

    const result = await handler?.(null, { plan: 'pro' });

    expect(result).toEqual({ ok: false, error: 'URL de checkout inválida' });
    expect(electronMock.openExternal).not.toHaveBeenCalled();
    expect(billingDeps.startCheckoutPolling).not.toHaveBeenCalled();
  });

  it('recusa URL de portal sem https:', async () => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { url: 'javascript:alert(1)' } },
    });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.portal);

    const result = await handler?.(null);

    expect(result).toEqual({ ok: false, error: 'URL do portal inválida' });
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });
});

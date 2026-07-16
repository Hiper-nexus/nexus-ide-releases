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
      json: { ok: true, data: { url: 'https://checkout.example/session' } },
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
      'https://checkout.example/session',
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
});

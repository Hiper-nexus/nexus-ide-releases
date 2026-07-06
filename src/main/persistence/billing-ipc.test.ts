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

  it('repassa nome e assentos no checkout Team', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);
    expect(handler).toBeDefined();

    const result = await handler?.(null, {
      plan: 'team',
      teamName: 'Core Ops',
      seats: 7,
    });

    expect(result).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenCalledWith('/v1/billing/checkout', {
      method: 'POST',
      body: { plan: 'team', teamName: 'Core Ops', seats: 7 },
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
});

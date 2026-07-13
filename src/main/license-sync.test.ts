import { describe, expect, it, vi } from 'vitest';
import {
  startCheckoutPolling,
  syncLicenseOnBoot,
  syncLicenseOnce,
} from './license-sync';

function deps(over: Record<string, unknown> = {}) {
  return {
    api: vi.fn().mockResolvedValue({ status: 200, json: { ok: true, data: { licenca: 'jwt-1' } } }),
    applyLicense: vi.fn().mockReturnValue({ ok: true }),
    readPlan: vi.fn().mockReturnValue('free'),
    notify: vi.fn(),
    setIntervalFn: vi.fn(),
    clearIntervalFn: vi.fn(),
    ...over,
  };
}

describe('syncLicenseOnce', () => {
  it('200 aplica a licença e notifica o renderer', async () => {
    const d = deps();

    expect(await syncLicenseOnce(d as never)).toBe(true);

    expect(d.applyLicense).toHaveBeenCalledWith('jwt-1');
    expect(d.notify).toHaveBeenCalled();
  });

  it('401/offline retorna false sem aplicar nada', async () => {
    const d = deps({ api: vi.fn().mockResolvedValue({ status: 401, json: null }) });

    expect(await syncLicenseOnce(d as never)).toBe(false);

    expect(d.applyLicense).not.toHaveBeenCalled();
  });
});

describe('startCheckoutPolling', () => {
  it('agenda o intervalo e para quando o plano deixa de ser free', async () => {
    let tick: () => Promise<void> = async () => {};
    const d = deps({
      setIntervalFn: vi.fn((fn: () => Promise<void>) => {
        tick = fn;
        return 7;
      }),
      api: vi.fn()
        .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: 'free-jwt' } } })
        .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: 'pro-jwt' } } }),
      readPlan: vi.fn().mockReturnValueOnce('free').mockReturnValueOnce('pro'),
    });

    startCheckoutPolling(d as never);
    expect(d.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5_000);
    await tick();
    expect(d.clearIntervalFn).not.toHaveBeenCalled();
    await tick();
    expect(d.clearIntervalFn).toHaveBeenCalledWith(7);
  });
});

describe('syncLicenseOnBoot', () => {
  it('não consulta licença em cold boot sem sessão já desbloqueada', () => {
    const sync = vi.fn().mockResolvedValue(true);

    syncLicenseOnBoot({ hasCachedAuthSession: () => false, sync });

    expect(sync).not.toHaveBeenCalled();
  });

  it('sincroniza quando a sessão já está em memória', () => {
    const sync = vi.fn().mockResolvedValue(true);

    syncLicenseOnBoot({ hasCachedAuthSession: () => true, sync });

    expect(sync).toHaveBeenCalledOnce();
  });
});

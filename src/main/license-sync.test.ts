import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startCheckoutPolling,
  startPeriodicLicenseSync,
  syncLicenseOnBoot,
  syncLicenseOnce,
} from './license-sync';

function deps(over: Record<string, unknown> = {}) {
  return {
    api: vi.fn().mockResolvedValue({ status: 200, json: { ok: true, data: { licenca: 'jwt-1' } } }),
    applyLicense: vi.fn().mockReturnValue({ ok: true }),
    readAccess: vi.fn().mockReturnValue('trial'),
    notify: vi.fn(),
    sessionKey: () => 'account-a:1',
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
  it('agenda o intervalo e para quando o access passa de trial para pro', async () => {
    let tick: () => Promise<void> = async () => {};
    const d = deps({
      setIntervalFn: vi.fn((fn: () => Promise<void>) => {
        tick = fn;
        return 7;
      }),
      api: vi.fn()
        .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: 'free-jwt' } } })
        .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { licenca: 'pro-jwt' } } }),
      readAccess: vi.fn().mockReturnValueOnce('trial').mockReturnValueOnce('pro'),
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

    syncLicenseOnBoot({ hasCachedAuthSession: () => false, sync, afterFirstPaint: () => {}, startPeriodic: () => {} });

    expect(sync).not.toHaveBeenCalled();
  });

  it('sincroniza quando a sessão já está em memória', () => {
    const sync = vi.fn().mockResolvedValue(true);

    syncLicenseOnBoot({ hasCachedAuthSession: () => true, sync, afterFirstPaint: () => {}, startPeriodic: () => {} });

    expect(sync).toHaveBeenCalledOnce();
  });
});


it('starts cold boot renewal only after first paint and starts the periodic scheduler', async () => {
  let painted!: () => void;
  const sync = vi.fn().mockResolvedValue(true), startPeriodic = vi.fn();
  syncLicenseOnBoot({ hasCachedAuthSession: () => false, sync, afterFirstPaint: cb => { painted = cb; }, startPeriodic });
  expect(sync).not.toHaveBeenCalled();
  painted();
  await Promise.resolve();
  expect(sync).toHaveBeenCalledOnce();
  expect(startPeriodic).toHaveBeenCalledOnce();
});
it('shares an in-flight renewal and discards its result after account switch', async () => {
  let finish!: (value: unknown) => void;
  let account = 'account-a';
  const d = deps({ sessionKey: () => account, api: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
  const a = syncLicenseOnce(d as never), b = syncLicenseOnce(d as never);
  account = 'account-b';
  finish({ status: 200, json: { ok: true, data: { licenca: 'old-jwt' } } });
  expect(await a).toBe(false);
  expect(await b).toBe(false);
  expect(d.api).toHaveBeenCalledOnce();
  expect(d.applyLicense).not.toHaveBeenCalled();
});


describe('periodic renewal', () => {
  afterEach(() => vi.useRealTimers());
  it('renews before expiry, keeps only one call in flight, and retries offline without spinning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    let finish!: (ok: boolean) => void;
    const sync = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const stop = startPeriodicLicenseSync({ sync, expiresAt: () => '2026-09-30T12:02:00Z', onChanged: () => () => {}, now: Date.now });
    await vi.advanceTimersByTimeAsync(59999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600000);
    expect(sync).toHaveBeenCalledOnce();
    finish(false);
    await vi.advanceTimersByTimeAsync(29999);
    expect(sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    stop();
    finish(false);
  });
});

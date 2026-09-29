import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { AccountInfo } from '../../shared/account-types';
import type { QuotaWindow, QuotaFleetSnapshot } from '../../shared/quota-types';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), send: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{
  isDestroyed: () => false, webContents: { isCrashed: () => false, send: mocks.send },
}] }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('./provider-live-usage', () => ({ fetchLiveProviderWindows: mocks.probe }));
import { QUOTA_PROBE_CONCURRENCY, QuotaService } from './quota-service';

const window = (ratio: number): QuotaWindow[] => [{
  kind: 'hours', label: '5 Horas', usedRatio: ratio, source: 'provider-api', confidence: 'high',
}];
const providers = (upstream: string): ProviderSettingsInfo[] => [
  { adapterId: 'claude', label: 'Claude', installed: true, enabled: true, routable: true, authStrategy: 'api-key', upstream },
  { adapterId: 'grok', label: 'Grok', installed: true, enabled: true, routable: false, authStrategy: 'subscription' },
] as ProviderSettingsInfo[];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('frota de muitas contas (F-676)', () => {
  const fleet = (n: number): AccountInfo[] => Array.from({ length: n }, (_, i) => ({
    id: `grok-${i}`, adapterId: 'grok', label: `Conta ${i}`, mode: 'subscription' as const, upstream: 'xai', createdAt: i,
    active: i === 0, hasCredential: true, onCooldown: false, needsRelogin: false,
  }));

  it('sonda no máximo QUOTA_PROBE_CONCURRENCY contas ao mesmo tempo', async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.probe.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { windows: window(0.3) };
    });
    const svc = new QuotaService({ listProviders: () => providers('glm').slice(1), listAccounts: () => fleet(30) });
    await svc.snapshot(1_000, { forceApi: true });
    expect(mocks.probe.mock.calls.length).toBeGreaterThanOrEqual(30);
    expect(peak).toBeLessThanOrEqual(QUOTA_PROBE_CONCURRENCY);
    svc.stop();
  });

  it('rajada de limites divide a sondagem que saiu depois do hit, nunca a de antes', async () => {
    let release: (() => void) | undefined;
    mocks.probe.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ windows: window(0.3) });
    }));
    const svc = new QuotaService({ listProviders: () => providers('glm').slice(1), listAccounts: () => fleet(1) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const before = svc.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // Hit em 2_000: a leitura em voo saiu em 1_000 — não pode refutar o limite.
    clock.mockReturnValue(2_000);
    release = undefined;
    const firstHit = svc.refreshForLimitHit(2_000);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const callsAfterFirstHit = mocks.probe.mock.calls.length;
    // Segundo pane da mesma rajada: divide a sondagem pós-hit.
    const secondHit = svc.refreshForLimitHit(2_000);
    expect(mocks.probe.mock.calls.length).toBe(callsAfterFirstHit);
    release!();
    await Promise.all([firstHit, secondHit]);
    expect(await secondHit).toBe(await firstHit);
    void before;
    svc.stop();
  });
});

describe('quota refresh identity and publication', () => {
  it('never mixes a newer upstream cache into an older snapshot or republishes the old snapshot', async () => {
    let upstream = 'glm';
    let releaseOldGrok: ((probe: { windows: QuotaWindow[] }) => void) | undefined;
    let grokCalls = 0;
    mocks.probe.mockImplementation(async (adapterId, _account, _deps, _now, route) => {
      if (adapterId === 'claude') return { windows: window(route === 'glm' ? 0.2 : 0.8) };
      if (++grokCalls === 1) return new Promise<{ windows: QuotaWindow[] }>((resolve) => { releaseOldGrok = resolve; });
      return { windows: window(0.1) };
    });
    const svc = new QuotaService({ listProviders: () => providers(upstream), listAccounts: () => [] });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const old = svc.refresh();
    await vi.waitFor(() => expect(releaseOldGrok).toBeTypeOf('function'));
    const coalesced = svc.snapshot(1_000);
    upstream = 'longcat'; now.mockReturnValue(1_100);
    const latest = await svc.refresh();
    releaseOldGrok!({ windows: window(0.1) });
    const completedOld = await old;
    expect(completedOld).toEqual(latest);
    expect(await coalesced).toEqual(latest);
    expect(svc.lastSnapshot()).toEqual(latest);
    const publications = mocks.send.mock.calls.map((call) => call[1] as QuotaFleetSnapshot);
    expect(publications.length).toBeGreaterThan(0);
    expect(publications.every((snap) => snap.entries.find((entry) => entry.adapterId === 'claude')?.usageProviderId === 'longcat')).toBe(true);
    expect(latest.entries[0].windows[0].usedRatio).toBe(0.8);
    svc.stop();
  });

  it('does not let a late same-identity response overwrite the newer cache', async () => {
    let releaseOld: ((probe: { windows: QuotaWindow[] }) => void) | undefined;
    mocks.probe.mockImplementation(async (_adapter, _account, _deps, now) => {
      if (now === 1_000) return new Promise<{ windows: QuotaWindow[] }>((resolve) => { releaseOld = resolve; });
      return { windows: window(0.8) };
    });
    const svc = new QuotaService({ listProviders: () => providers('glm').slice(0, 1), listAccounts: () => [] });
    const old = svc.snapshot(1_000);
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    const latest = await svc.snapshot(1_100, { forceApi: true });
    releaseOld!({ windows: window(0.2) });
    await old;
    const cached = await svc.snapshot(1_200);
    expect(cached.entries[0].windows[0].usedRatio).toBe(0.8);
    expect(cached.entries[0].updatedAt).toBe(latest.entries[0].updatedAt);
    svc.stop();
  });
});

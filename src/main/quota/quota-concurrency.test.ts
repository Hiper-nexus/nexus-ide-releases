import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { QuotaWindow, QuotaFleetSnapshot } from '../../shared/quota-types';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), send: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{
  isDestroyed: () => false, webContents: { isCrashed: () => false, send: mocks.send },
}] }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('./provider-live-usage', () => ({ fetchLiveProviderWindows: mocks.probe }));
import { QuotaService } from './quota-service';

const window = (ratio: number): QuotaWindow[] => [{
  kind: 'hours', label: '5 Horas', usedRatio: ratio, source: 'provider-api', confidence: 'high',
}];
const providers = (upstream: string): ProviderSettingsInfo[] => [
  { adapterId: 'claude', label: 'Claude', installed: true, enabled: true, routable: true, authStrategy: 'api-key', upstream },
  { adapterId: 'grok', label: 'Grok', installed: true, enabled: true, routable: false, authStrategy: 'subscription' },
] as ProviderSettingsInfo[];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('quota refresh identity and publication', () => {
  it('never mixes a newer upstream cache into an older snapshot or republishes the old snapshot', async () => {
    let upstream = 'glm';
    let releaseOldGrok: ((windows: QuotaWindow[]) => void) | undefined;
    let grokCalls = 0;
    mocks.probe.mockImplementation(async (adapterId, _account, _deps, _now, route) => {
      if (adapterId === 'claude') return window(route === 'glm' ? 0.2 : 0.8);
      if (++grokCalls === 1) return new Promise<QuotaWindow[]>((resolve) => { releaseOldGrok = resolve; });
      return window(0.1);
    });
    const svc = new QuotaService({ listProviders: () => providers(upstream), listAccounts: () => [] });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const old = svc.refresh();
    await vi.waitFor(() => expect(releaseOldGrok).toBeTypeOf('function'));
    const coalesced = svc.snapshot(1_000);
    upstream = 'longcat'; now.mockReturnValue(1_100);
    const latest = await svc.refresh();
    releaseOldGrok!(window(0.1));
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
    let releaseOld: ((windows: QuotaWindow[]) => void) | undefined;
    mocks.probe.mockImplementation(async (_adapter, _account, _deps, now) => {
      if (now === 1_000) return new Promise<QuotaWindow[]>((resolve) => { releaseOld = resolve; });
      return window(0.8);
    });
    const svc = new QuotaService({ listProviders: () => providers('glm').slice(0, 1), listAccounts: () => [] });
    const old = svc.snapshot(1_000);
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    const latest = await svc.snapshot(1_100, { forceApi: true });
    releaseOld!(window(0.2));
    await old;
    const cached = await svc.snapshot(1_200);
    expect(cached.entries[0].windows[0].usedRatio).toBe(0.8);
    expect(cached.entries[0].updatedAt).toBe(latest.entries[0].updatedAt);
    svc.stop();
  });
});

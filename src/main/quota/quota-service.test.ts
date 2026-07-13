import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

import { QuotaService } from './quota-service';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';

const HIT_AT = 1_000_000;
const COOLDOWN_MS = 60_000;

function provider(adapterId: string, label = adapterId): ProviderSettingsInfo {
  return {
    adapterId,
    label,
    installed: true,
    enabled: true,
  } as ProviderSettingsInfo;
}

describe('QuotaService limit-hit expiry', () => {
  it('applies noted hit while cooldown active, then recovers to unknown after expiry', async () => {
    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
    });

    svc.noteLimitHit(
      'claude',
      {
        kind: 'rate-limit',
        reason: 'usage limit',
        cooldownMs: COOLDOWN_MS,
      },
      undefined,
      HIT_AT,
    );

    const during = await svc.snapshot(HIT_AT + 1_000);
    const duringEntry = during.entries.find((e) => e.adapterId === 'claude');
    expect(duringEntry).toBeDefined();
    const sessionDuring = duringEntry!.windows.find((w) => w.kind === 'session');
    expect(sessionDuring?.usedRatio).toBe(1);
    expect(sessionDuring?.source).toBe('limit-hit');
    // resetsAt fixed at hitAt+cooldown — not now+cooldown (perpetual full bar)
    expect(sessionDuring?.resetsAt).toBe(HIT_AT + COOLDOWN_MS);

    const after = await svc.snapshot(HIT_AT + COOLDOWN_MS + 1);
    const afterEntry = after.entries.find((e) => e.adapterId === 'claude');
    expect(afterEntry).toBeDefined();
    // Exhausted limit-hit windows must not stick past cooldown
    const exhausted = afterEntry!.windows.filter(
      (w) => w.source === 'limit-hit' && w.usedRatio === 1,
    );
    expect(exhausted).toHaveLength(0);
    // Honest unknown again (not invented 0%)
    expect(afterEntry!.windows.every((w) => w.usedRatio === null)).toBe(true);

    svc.stop();
  });

  it('keys multi-account hits and expires only the hit that aged out', async () => {
    const accounts: AccountInfo[] = [
      {
        id: 'acc-a',
        adapterId: 'codex',
        label: 'A',
        mode: 'subscription',
        active: true,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'codex',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
    ];

    const svc = new QuotaService({
      listProviders: () => [provider('codex', 'Codex')],
      listAccounts: () => accounts,
    });

    svc.noteLimitHit(
      'codex',
      { kind: 'rate-limit', reason: '5h', cooldownMs: COOLDOWN_MS },
      'acc-a',
      HIT_AT,
    );

    const mid = await svc.snapshot(HIT_AT + 5_000);
    const a = mid.entries.find((e) => e.accountId === 'acc-a');
    const b = mid.entries.find((e) => e.accountId === 'acc-b');
    expect(a?.windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(1);
    // B never hit — stays unknown
    expect(b?.windows.every((w) => w.usedRatio === null)).toBe(true);

    const done = await svc.snapshot(HIT_AT + COOLDOWN_MS + 50);
    const aDone = done.entries.find((e) => e.accountId === 'acc-a');
    expect(
      aDone?.windows.filter((w) => w.source === 'limit-hit' && w.usedRatio === 1),
    ).toHaveLength(0);

    svc.stop();
  });
});

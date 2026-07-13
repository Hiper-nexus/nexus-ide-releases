/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_QUOTA_SNAPSHOT, useQuotaStore } from './quota-store';

describe('useQuotaStore', () => {
  beforeEach(() => {
    useQuotaStore.getState().reset();
    // @ts-expect-error test stub
    window.nexus = undefined;
  });

  it('sets error when quota API is missing', async () => {
    await useQuotaStore.getState().hydrate();
    const s = useQuotaStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/indisponível|reinicia/i);
    expect(s.snapshot).toEqual(EMPTY_QUOTA_SNAPSHOT);
  });

  it('loads snapshot on hydrate when API works', async () => {
    const snap = {
      updatedAt: 1_700_000_000_000,
      entries: [
        {
          id: 'claude',
          adapterId: 'claude',
          label: 'Claude',
          installed: true,
          onCooldown: false,
          windows: [],
          updatedAt: 1_700_000_000_000,
        },
      ],
      worstUsedRatio: null,
      highUsageCount: 0,
      unknownCount: 1,
    };
    // @ts-expect-error test stub
    window.nexus = {
      quota: {
        snapshot: vi.fn(async () => snap),
        refresh: vi.fn(async () => snap),
        onChanged: () => () => {},
      },
    };
    await useQuotaStore.getState().hydrate();
    const s = useQuotaStore.getState();
    expect(s.status).toBe('ready');
    expect(s.snapshot.entries).toHaveLength(1);
    expect(s.snapshot.updatedAt).toBe(snap.updatedAt);
  });
});

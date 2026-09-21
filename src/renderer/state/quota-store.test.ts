/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_QUOTA_SNAPSHOT,
  entryForAccount,
  useQuotaStore,
} from './quota-store';

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
        connectMimo: vi.fn(async () => ({ ok: false, message: 'Unavailable' })),
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

  it('silent refresh failure keeps the current snapshot without flashing error', async () => {
    const snap = {
      updatedAt: 1,
      entries: [],
      worstUsedRatio: null,
      highUsageCount: 0,
      unknownCount: 0,
    };
    // @ts-expect-error test stub
    window.nexus = {
      quota: {
        connectMimo: vi.fn(async () => ({ ok: false, message: 'Unavailable' })),
        snapshot: vi.fn(async () => snap),
        refresh: vi.fn(async () => {
          throw new Error('network down');
        }),
        onChanged: () => () => {},
      },
    };
    useQuotaStore.getState().receive(snap);
    await useQuotaStore.getState().refresh({ silent: true });
    const s = useQuotaStore.getState();
    expect(s.status).toBe('ready');
    expect(s.error).toBeNull();
    expect(s.snapshot.updatedAt).toBe(1);
  });
});

describe('entryForAccount', () => {
  const base = {
    adapterId: 'codex',
    installed: true,
    onCooldown: false,
    windows: [],
    updatedAt: 1,
  };
  const snapshot = {
    updatedAt: 1,
    entries: [
      { ...base, id: 'codex', accountId: undefined, label: 'Codex · CLI nativo' },
      { ...base, id: 'codex:a', accountId: 'a', label: 'Codex · conta A' },
      { ...base, id: 'codex:b', accountId: 'b', label: 'Codex · conta B' },
    ],
    worstUsedRatio: null,
    highUsageCount: 0,
    unknownCount: 0,
  } as const;

  it('matches the exact pinned account', () => {
    expect(entryForAccount(snapshot as never, 'codex', 'b')?.id).toBe('codex:b');
  });

  it('unpinned lookup falls back to the native CLI row of the same adapter', () => {
    expect(entryForAccount(snapshot as never, 'codex')?.id).toBe('codex');
  });

  it('NEVER falls through to another account when the pinned one is missing', () => {
    // Pane pinada na conta "c" (sem entry ainda): mostrar a cota da conta A
    // aqui seria mentir sobre a conta errada.
    expect(entryForAccount(snapshot as never, 'codex', 'c')).toBeUndefined();
  });
});

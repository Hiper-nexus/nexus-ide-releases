/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '../../shared/usage-types';
import { setActiveWorkspacePath } from './active-workspace';
import { EMPTY_USAGE_SNAPSHOT, useUsageStore } from './usage-store';

const WORKSPACE = '/test/workspace';

describe('useUsageStore', () => {
  beforeEach(() => {
    useUsageStore.getState().reset();
    setActiveWorkspacePath(WORKSPACE);
    // @ts-expect-error test stub
    window.nexus = undefined;
  });

  it('mantém EMPTY_USAGE_SNAPSHOT quando snapshot() retorna null (scope identity absorvido)', async () => {
    // @ts-expect-error test stub
    window.nexus = {
      usage: {
        snapshot: vi.fn(async (): Promise<null> => null),
        lifetime: vi.fn(async () => {
          throw new Error('not used in this test');
        }),
        onChanged: () => () => {},
      },
    };
    await useUsageStore.getState().hydrate(WORKSPACE);
    expect(useUsageStore.getState().snapshot).toEqual(EMPTY_USAGE_SNAPSHOT);
  });

  it('não modifica o store quando a API de usage está ausente', async () => {
    // @ts-expect-error test stub
    window.nexus = {};
    await useUsageStore.getState().hydrate(WORKSPACE);
    expect(useUsageStore.getState().snapshot).toEqual(EMPTY_USAGE_SNAPSHOT);
  });

  it('atualiza o snapshot quando a API retorna dados válidos', async () => {
    const snap: UsageSnapshot = {
      byPane: {
        p1: {
          paneId: 'p1',
          costUsd: 1.5,
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 0,
          turns: 3,
          source: 'real',
        },
      },
      byAccount: {},
      global: { costUsd: 1.5, inputTokens: 100, outputTokens: 200, turns: 3 },
      media: { generations: 0, costUsd: 0 },
    };
    // @ts-expect-error test stub
    window.nexus = {
      usage: {
        snapshot: vi.fn(async () => snap),
        lifetime: vi.fn(async () => {
          throw new Error('not used in this test');
        }),
        onChanged: () => () => {},
      },
    };
    await useUsageStore.getState().hydrate(WORKSPACE);
    expect(useUsageStore.getState().snapshot).toEqual(snap);
  });
});

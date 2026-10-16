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

  it('status acompanha a leitura: lendo, pronto, e erro sem apagar o que já estava na tela', async () => {
    expect(useUsageStore.getState().status).toBe('idle');
    const withAnalytics: UsageSnapshot = {
      ...EMPTY_USAGE_SNAPSHOT,
      analytics: { today: '2026-10-15', rows: [], sessions: [] },
    };
    let release!: (value: UsageSnapshot | null) => void;
    const first = vi.fn(
      () =>
        new Promise<UsageSnapshot | null>((resolve) => {
          release = resolve;
        }),
    );
    // @ts-expect-error test stub
    window.nexus = { usage: { snapshot: first, onChanged: () => () => {} } };
    const reading = useUsageStore.getState().hydrate(WORKSPACE);
    expect(useUsageStore.getState().status).toBe('loading');
    release(withAnalytics);
    await reading;
    expect(useUsageStore.getState().status).toBe('ready');
    expect(useUsageStore.getState().snapshot).toEqual(withAnalytics);

    // Falha depois de já ter dados: o status vira erro, o snapshot fica.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error test stub
    window.nexus = { usage: { snapshot: vi.fn(async () => { throw new Error('sqlite'); }), onChanged: () => () => {} } };
    await useUsageStore.getState().hydrate(WORKSPACE);
    expect(useUsageStore.getState().status).toBe('error');
    expect(useUsageStore.getState().snapshot).toEqual(withAnalytics);
    warn.mockRestore();

    // O main absorveu a identidade (null): nada a mostrar, mas também nenhum erro.
    // @ts-expect-error test stub
    window.nexus = { usage: { snapshot: vi.fn(async (): Promise<null> => null), onChanged: () => () => {} } };
    await useUsageStore.getState().hydrate(WORKSPACE);
    expect(useUsageStore.getState().status).toBe('ready');

    // Troca de workspace: volta ao zero.
    useUsageStore.getState().reset();
    expect(useUsageStore.getState().status).toBe('idle');
    expect(useUsageStore.getState().snapshot).toEqual(EMPTY_USAGE_SNAPSHOT);
  });

  it('ignora a resposta de um workspace que já não é o ativo', async () => {
    let release!: (value: UsageSnapshot | null) => void;
    // @ts-expect-error test stub
    window.nexus = {
      usage: {
        snapshot: vi.fn(() => new Promise<UsageSnapshot | null>((resolve) => { release = resolve; })),
        onChanged: () => () => {},
      },
    };
    const reading = useUsageStore.getState().hydrate(WORKSPACE);
    setActiveWorkspacePath('/outro/projeto');
    release({ ...EMPTY_USAGE_SNAPSHOT, analytics: { today: '2026-10-15', rows: [], sessions: [] } });
    await reading;
    expect(useUsageStore.getState().snapshot).toEqual(EMPTY_USAGE_SNAPSHOT);
  });
});

/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo } from '../../shared/adapter-types';
import { useAdapterStore } from './adapter-store';

const CLAUDE: AdapterInfo = {
  id: 'claude',
  kind: 'cli-pty',
  label: 'Claude',
  icon: '◆',
  models: { list: ['sonnet'], default: 'sonnet' },
  installed: true,
  installCommand: 'npm i -g claude',
  idleTimeoutMs: 800,
  orchestratorCapable: true,
};

describe('useAdapterStore', () => {
  beforeEach(() => {
    useAdapterStore.setState({ adapters: [] });
    delete (window as unknown as { nexus?: unknown }).nexus;
  });

  it('fica vazio quando a bridge não existe (main ainda subindo)', async () => {
    await useAdapterStore.getState().hydrate();
    expect(useAdapterStore.getState().adapters).toEqual([]);
  });

  it('hidrata a lista de adapters e projeta receive', async () => {
    window.nexus = {
      adapters: {
        list: vi.fn(async () => [CLAUDE]),
        rescan: vi.fn(async () => [CLAUDE]),
        onChanged: () => () => {},
      },
    } as unknown as Window['nexus'];
    await useAdapterStore.getState().hydrate();
    expect(useAdapterStore.getState().adapters).toHaveLength(1);
    useAdapterStore.getState().receive([]);
    expect(useAdapterStore.getState().adapters).toEqual([]);
  });
});

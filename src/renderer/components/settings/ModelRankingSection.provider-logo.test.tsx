/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicModelRankingSnapshot } from '../../../shared/eval-ranking-types';
import { useProviderStore } from '../../state/provider-store';
import { useQuotaStore } from '../../state/quota-store';
import { ModelRankingSection } from './ModelRankingSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: PublicModelRankingSnapshot = {
  schemaVersion: 1,
  generatedAt: '2026-07-11T21:00:00.000Z',
  suiteId: 'v1',
  suiteRevision: 'test',
  description: 'test',
  entries: [
    {
      id: 'codex/gpt-test',
      adapterId: 'codex',
      modelId: 'gpt-test',
      overall: 80,
      coding: 82,
      reasoning: 79,
      frontend: 77,
      security: 81,
      evaluatedAt: '2026-07-11T21:00:00.000Z',
      source: 'nexus-eval/test',
      rank: 1,
    },
    {
      id: 'claude/opus-test',
      adapterId: 'claude',
      modelId: 'opus-test',
      overall: 75,
      coding: 78,
      reasoning: 83,
      frontend: 72,
      security: 79,
      evaluatedAt: '2026-07-11T21:00:00.000Z',
      source: 'nexus-eval/test',
      rank: 2,
    },
  ],
};

describe('ModelRankingSection provider identity', () => {
  afterEach(() => {
    useProviderStore.setState({ providers: [] });
    useQuotaStore.getState().reset();
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows provider logos in picks, race, radar and selected detail', async () => {
    useProviderStore.setState({ providers: [] });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { ranking: { public: vi.fn(async () => snapshot) } },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<ModelRankingSection />);
    });

    expect(host.querySelectorAll('.rank-missions__card .provider-logo').length).toBe(5);
    expect(host.querySelectorAll('.rank-race__row .provider-logo').length).toBe(2);
    expect(host.querySelector('.rank-radar__identity .provider-logo')).not.toBeNull();
    expect(host.querySelector('.rank-ops__detail-head .provider-logo')).not.toBeNull();

    act(() => root.unmount());
  });
});

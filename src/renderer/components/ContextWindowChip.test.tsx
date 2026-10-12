/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ContextWindowChip } from './ContextWindowChip';
import { useUsageStore, EMPTY_USAGE_SNAPSHOT } from '../state/usage-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(props: {
  paneId: string;
  adapterId?: string | null;
  modelId?: string | null;
}): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ContextWindowChip {...props} />);
  });
  return { host, root };
}

describe('ContextWindowChip', () => {
  beforeEach(() => {
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
    (window as unknown as { nexus?: unknown }).nexus = {
      model: {
        richMetadata: vi.fn(async () => ({ contextWindow: 200_000 })),
      },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sem leitura e sem modelo some (não inventa 0)', () => {
    const { host } = mount({ paneId: 'p1' });
    expect(host.textContent).toBe('');
  });

  it('mostra used/max quando a última rodada e o modelo existem', async () => {
    useUsageStore.setState({
      snapshot: {
        ...EMPTY_USAGE_SNAPSHOT,
        byPane: {
          p1: {
            paneId: 'p1',
            costUsd: 0,
            inputTokens: 50_000,
            outputTokens: 100,
            cacheReadTokens: 0,
            turns: 1,
            lastContextTokens: 50_000,
            source: 'real',
          },
        },
      },
    });
    const { host } = mount({
      paneId: 'p1',
      adapterId: 'claude',
      modelId: 'sonnet-5',
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toContain('50k/200k');
    expect(host.querySelector('.ctx-chip--none, .ctx-chip')).toBeTruthy();
  });

  it('urgência warn aos 85%', async () => {
    useUsageStore.setState({
      snapshot: {
        ...EMPTY_USAGE_SNAPSHOT,
        byPane: {
          p1: {
            paneId: 'p1',
            costUsd: 0,
            inputTokens: 180_000,
            outputTokens: 1,
            cacheReadTokens: 0,
            turns: 3,
            lastContextTokens: 180_000,
            source: 'real',
          },
        },
      },
    });
    const { host } = mount({
      paneId: 'p1',
      adapterId: 'claude',
      modelId: 'sonnet-5',
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('.ctx-chip--warn')).toBeTruthy();
    expect(host.textContent).toContain('180k/200k');
  });
});

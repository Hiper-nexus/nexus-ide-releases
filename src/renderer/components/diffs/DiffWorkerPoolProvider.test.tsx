/** @vitest-environment jsdom */
// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: the worker lifecycle cases of
// apps/web/src/components/diffs/StyledDiffCodeView.test.tsx against a fake pool manager, plus
// the nexus-light theme sync.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWorkerPool } from '@pierre/diffs/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIFF_WORKER_IDLE_TTL_MS,
  DiffWorkerError,
  DiffWorkerPoolProvider,
} from './DiffWorkerPoolProvider';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pools = vi.hoisted(() => ({
  created: [] as Array<{
    options: { workerFactory: () => unknown };
    render: { theme: string; preferredHighlighter: string };
    terminated: number;
    setRenderOptions: (options: { theme: string }) => Promise<void>;
  }>,
}));

vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({
  default: class {
    constructor() {
      throw new Error('worker blocked');
    }
  },
}));

vi.mock('@pierre/diffs/worker', async () => {
  const { vi: hoistedVi } = await import('vitest');
  return {
    WorkerPoolManager: class {
      terminated = 0;
      options: { workerFactory: () => unknown };
      render: { theme: string; preferredHighlighter: string };
      setRenderOptions = hoistedVi.fn(async (options: { theme: string }) => {
        this.render = { ...this.render, ...options };
      });
      constructor(
        options: { workerFactory: () => unknown },
        render: { theme: string; preferredHighlighter: string },
      ) {
        this.options = options;
        this.render = render;
        pools.created.push(this);
      }
      isInitialized() {
        return true;
      }
      isWorkingPool() {
        return true;
      }
      initialize() {
        return Promise.resolve();
      }
      getDiffRenderOptions() {
        return { theme: this.render.theme };
      }
      terminate() {
        this.terminated += 1;
      }
    },
  };
});

function Probe() {
  return <span data-testid="probe">{useWorkerPool() ? 'pool' : 'none'}</span>;
}

let root: Root | null = null;

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <DiffWorkerPoolProvider>
        <Probe />
      </DiffWorkerPoolProvider>,
    ),
  );
  return host;
}

function unmount() {
  act(() => root?.unmount());
  root = null;
}

afterEach(() => {
  unmount();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  vi.useRealTimers();
});

describe('DiffWorkerPoolProvider', () => {
  it('starts on demand, keeps quick reopens warm and expires the last closed pool', () => {
    vi.useFakeTimers();
    const host = mount();
    expect(pools.created).toHaveLength(1);
    expect(pools.created[0]!.render).toMatchObject({
      theme: 'pierre-dark',
      preferredHighlighter: 'shiki-js',
    });
    expect(host.textContent).toBe('pool');

    unmount();
    act(() => vi.advanceTimersByTime(DIFF_WORKER_IDLE_TTL_MS - 1));
    expect(pools.created[0]!.terminated).toBe(0);
    mount();
    expect(pools.created).toHaveLength(1);

    unmount();
    act(() => vi.advanceTimersByTime(DIFF_WORKER_IDLE_TTL_MS));
    expect(pools.created[0]!.terminated).toBe(1);
    mount();
    expect(pools.created).toHaveLength(2);
  });

  it('reports a worker that cannot start as a DiffWorkerError', () => {
    mount();
    const pool = pools.created.at(-1)!;
    let error: unknown;
    try {
      pool.options.workerFactory();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DiffWorkerError);
    expect(error).toMatchObject({ operation: 'create-worker', themeName: 'pierre-dark' });
    expect((error as Error).cause).toEqual(new Error('worker blocked'));
  });

  it('switches the highlight theme when the app goes to nexus-light', async () => {
    mount();
    const pool = pools.created.at(-1)!;
    await act(async () => {
      document.documentElement.dataset.theme = 'nexus-light';
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pool.setRenderOptions).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'pierre-light' }),
    );
  });
});

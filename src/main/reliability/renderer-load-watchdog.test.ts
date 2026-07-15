import { describe, expect, it } from 'vitest';
import {
  RENDERER_LOAD_STALL_MS,
  decideRendererLoadWatchdog,
} from './renderer-load-watchdog';

describe('decideRendererLoadWatchdog', () => {
  it('waits while the initial renderer navigation is still making progress', () => {
    expect(
      decideRendererLoadWatchdog({
        isFinished: false,
        isLoading: true,
        loadAgeMs: RENDERER_LOAD_STALL_MS - 1,
      }),
    ).toBe('wait');
  });

  it('restarts an active renderer navigation only after it is stale', () => {
    expect(
      decideRendererLoadWatchdog({
        isFinished: false,
        isLoading: true,
        loadAgeMs: RENDERER_LOAD_STALL_MS,
      }),
    ).toBe('restart-stalled-load');
  });

  it('retries when no renderer navigation is active', () => {
    expect(
      decideRendererLoadWatchdog({
        isFinished: false,
        isLoading: false,
        loadAgeMs: 0,
      }),
    ).toBe('retry');
  });

  it('does nothing after the renderer finished loading', () => {
    expect(
      decideRendererLoadWatchdog({
        isFinished: true,
        isLoading: false,
        loadAgeMs: RENDERER_LOAD_STALL_MS,
      }),
    ).toBe('wait');
  });
});

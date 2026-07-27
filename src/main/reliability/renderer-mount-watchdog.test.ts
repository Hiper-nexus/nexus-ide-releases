import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RENDERER_MOUNT_DEADLINE_MS,
  RendererMountWatchdog,
} from './renderer-mount-watchdog';

describe('RendererMountWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires on Main wall-clock time without any renderer response', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const watchdog = new RendererMountWatchdog(onDeadline);

    watchdog.arm();
    vi.advanceTimersByTime(RENDERER_MOUNT_DEADLINE_MS - 1);
    expect(onDeadline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it('re-arming for a new navigation invalidates the previous deadline', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const watchdog = new RendererMountWatchdog(onDeadline, 100);

    watchdog.arm();
    vi.advanceTimersByTime(90);
    watchdog.arm();
    vi.advanceTimersByTime(10);
    expect(onDeadline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(90);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it.each(['renderer mounted', 'navigation started', 'window destroyed'])(
    'cancels cleanly when %s',
    () => {
      vi.useFakeTimers();
      const onDeadline = vi.fn();
      const watchdog = new RendererMountWatchdog(onDeadline, 100);

      watchdog.arm();
      vi.advanceTimersByTime(90);
      watchdog.cancel();
      vi.advanceTimersByTime(100);

      expect(onDeadline).not.toHaveBeenCalled();
    },
  );
});

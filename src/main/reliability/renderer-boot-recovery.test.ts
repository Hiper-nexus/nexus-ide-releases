import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererBootRecovery } from "./renderer-boot-recovery";

describe("RendererBootRecovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates a delayed retry when a newer navigation starts", () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const watchdog = new RendererBootRecovery({
      maxRecoveries: 3,
      onExhausted: vi.fn(),
    });

    watchdog.beginNavigation();
    expect(watchdog.schedule(100, recover)).toBe(true);
    watchdog.beginNavigation();
    vi.advanceTimersByTime(100);

    expect(recover).not.toHaveBeenCalled();
  });

  it("serializes concurrent recovery requests", () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const watchdog = new RendererBootRecovery({
      maxRecoveries: 3,
      onExhausted: vi.fn(),
    });

    expect(watchdog.schedule(100, recover)).toBe(true);
    expect(watchdog.schedule(0, recover)).toBe(false);
    vi.advanceTimersByTime(100);

    expect(recover).toHaveBeenCalledOnce();
    expect(watchdog.attempts).toBe(1);
  });

  it("stops permanently at the budget until a real commit or manual retry", () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const exhausted = vi.fn();
    const watchdog = new RendererBootRecovery({
      maxRecoveries: 2,
      onExhausted: exhausted,
    });

    expect(watchdog.schedule(0, recover)).toBe(true);
    vi.runOnlyPendingTimers();
    expect(watchdog.schedule(0, recover)).toBe(true);
    vi.runOnlyPendingTimers();
    expect(watchdog.schedule(0, recover)).toBe(false);
    expect(exhausted).toHaveBeenCalledOnce();
    expect(watchdog.isStopped).toBe(true);

    vi.advanceTimersByTime(300_000);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(exhausted).toHaveBeenCalledOnce();

    watchdog.beginNavigation({ manualRetry: true });
    expect(watchdog.schedule(0, recover)).toBe(true);
    vi.runOnlyPendingTimers();
    expect(recover).toHaveBeenCalledTimes(3);

    watchdog.rendererCommitted();
    expect(watchdog.attempts).toBe(0);
    expect(watchdog.isStopped).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORCHESTRATION_START_INITIAL_RETRY_MS,
  ORCHESTRATION_START_MAX_RETRY_MS,
  OrchestrationStartSupervisor,
} from './orchestration-start-supervisor';

afterEach(() => {
  vi.useRealTimers();
});

describe('OrchestrationStartSupervisor', () => {
  it('retries a transient MCP start failure and starts the coordinator exactly once', async () => {
    vi.useFakeTimers();
    const startMcpServer = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary localhost bind failure'))
      .mockResolvedValueOnce();
    const startCoordinator = vi.fn();
    const supervisor = new OrchestrationStartSupervisor({
      startMcpServer,
      startCoordinator,
    });

    const ready = supervisor.start();
    expect(supervisor.start()).toBe(ready);
    await vi.advanceTimersByTimeAsync(0);

    expect(startMcpServer).toHaveBeenCalledTimes(1);
    expect(startCoordinator).not.toHaveBeenCalled();
    expect(supervisor.health).toMatchObject({
      status: 'retry-wait',
      attempts: 1,
      retryScheduled: true,
      lastError: 'temporary localhost bind failure',
    });

    await vi.advanceTimersByTimeAsync(ORCHESTRATION_START_INITIAL_RETRY_MS);
    await ready;

    expect(startMcpServer).toHaveBeenCalledTimes(2);
    expect(startCoordinator).toHaveBeenCalledTimes(1);
    expect(supervisor.health).toMatchObject({
      status: 'ready',
      attempts: 2,
      retryScheduled: false,
      lastError: null,
    });

    await expect(supervisor.start()).resolves.toBeUndefined();
    expect(startMcpServer).toHaveBeenCalledTimes(2);
    expect(startCoordinator).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled retry during shutdown', async () => {
    vi.useFakeTimers();
    const startMcpServer = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('localhost unavailable'));
    const startCoordinator = vi.fn();
    const supervisor = new OrchestrationStartSupervisor({
      startMcpServer,
      startCoordinator,
    });

    const ready = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.health.retryScheduled).toBe(true);

    supervisor.stop();
    await expect(ready).rejects.toThrow(/stopped before becoming ready/i);
    await vi.runAllTimersAsync();

    expect(startMcpServer).toHaveBeenCalledTimes(1);
    expect(startCoordinator).not.toHaveBeenCalled();
    expect(supervisor.health).toMatchObject({
      status: 'stopped',
      retryScheduled: false,
    });
  });

  it('caps exponential backoff while retaining the live retry owner', async () => {
    vi.useFakeTimers();
    const supervisor = new OrchestrationStartSupervisor({
      startMcpServer: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('still unavailable')),
      startCoordinator: vi.fn(),
    });

    const ready = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const delayMs of [250, 500, 1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    expect(supervisor.health).toMatchObject({
      status: 'retry-wait',
      attempts: 6,
      retryScheduled: true,
    });
    expect(
      (supervisor.health.nextRetryAt ?? 0) - Date.now(),
    ).toBe(ORCHESTRATION_START_MAX_RETRY_MS);

    await supervisor.stop();
    await expect(ready).rejects.toThrow(/stopped before becoming ready/i);
  });
});

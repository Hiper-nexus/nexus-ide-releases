import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admitAgentSpawnSync,
  registerAgentMemoryCensus,
  resetPaneSpawnActivityForTest,
} from '../orch/pane-admission';
import { trace } from './main-trace';
import {
  enqueuePostBootIdleTask,
  getPostBootIdleQueueStatus,
  POST_BOOT_IDLE_QUIET_MS,
  POST_BOOT_INTER_TASK_YIELD_MS,
  POST_BOOT_SPAWN_SETTLE_MS,
  PostBootIdleQueue,
  resetPostBootIdleQueueForTest,
  stopPostBootIdleQueue,
} from './post-boot-idle-queue';

describe('PostBootIdleQueue (Item 9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    resetPaneSpawnActivityForTest();
    resetPostBootIdleQueueForTest();
  });

  afterEach(async () => {
    await stopPostBootIdleQueue();
    resetPostBootIdleQueueForTest();
    resetPaneSpawnActivityForTest();
    vi.useRealTimers();
  });

  it('does not run queued tasks before boot-complete + quiet window', async () => {
    const order: string[] = [];
    const queue = new PostBootIdleQueue({
      hasPendingSpawns: () => false,
      getLastSpawnAt: () => 0,
      hasCpuHeadroom: () => true,
    });

    queue.enqueue('task-a', () => {
      order.push('task-a');
    });
    queue.enqueue('task-b', () => {
      order.push('task-b');
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(order).toEqual([]);

    queue.notifyBootComplete(Date.now());
    await vi.advanceTimersByTimeAsync(POST_BOOT_IDLE_QUIET_MS - 1);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['task-a']);

    await vi.advanceTimersByTimeAsync(POST_BOOT_INTER_TASK_YIELD_MS);
    expect(order).toEqual(['task-a', 'task-b']);
  });

  it('waits while a pane spawn is in flight and settles after spawn finishes', async () => {
    let pendingSpawns = 0;
    const order: string[] = [];
    const queue = new PostBootIdleQueue({
      hasPendingSpawns: () => pendingSpawns > 0,
      getLastSpawnAt: () => 0,
      hasCpuHeadroom: () => true,
    });

    queue.enqueue('adapter-model-refresh', () => {
      order.push('adapter-model-refresh');
    });
    queue.enqueue('sync-redline', () => {
      order.push('sync-redline');
    });

    queue.notifyBootComplete(Date.now());
    // Operator opens a pane at +4s after boot-complete.
    await vi.advanceTimersByTimeAsync(4_000);
    pendingSpawns = 1;
    queue.notifyPaneSpawnActivity(Date.now());

    // Even past the 6s post-boot window, the task must not run while pendingSpawns > 0.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual([]);

    // Spawn finishes; queue polls within 500ms and then waits POST_BOOT_SPAWN_SETTLE_MS.
    pendingSpawns = 0;
    await vi.advanceTimersByTimeAsync(POST_BOOT_SPAWN_SETTLE_MS);
    expect(order).toEqual(['adapter-model-refresh']);

    // Another pane spawn starts in the inter-task yield window before task 2 runs -> task 2 pauses.
    pendingSpawns = 1;
    queue.notifyPaneSpawnActivity(Date.now());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(order).toEqual(['adapter-model-refresh']);

    pendingSpawns = 0;
    await vi.advanceTimersByTimeAsync(POST_BOOT_SPAWN_SETTLE_MS + 600);
    expect(order).toEqual(['adapter-model-refresh', 'sync-redline']);
  });

  it('defers when CPU headroom is low up to the bounded ceiling, then drains', async () => {
    let cpuChecks = 0;
    const ran: string[] = [];
    const queue = new PostBootIdleQueue({
      hasPendingSpawns: () => false,
      getLastSpawnAt: () => 0,
      hasCpuHeadroom: () => {
        cpuChecks += 1;
        return false;
      },
      maxCpuDeferrals: 2,
      busyPollMs: 500,
    });

    queue.enqueue('heavy-task', () => {
      ran.push('heavy-task');
    });
    queue.notifyBootComplete(Date.now());

    await vi.advanceTimersByTimeAsync(POST_BOOT_IDLE_QUIET_MS);
    expect(ran).toEqual([]);
    expect(cpuChecks).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(ran).toEqual([]);
    expect(cpuChecks).toBe(2);

    // 3rd attempt hits maxCpuDeferrals=2 and runs so tasks never starve forever.
    await vi.advanceTimersByTimeAsync(500);
    expect(ran).toEqual(['heavy-task']);
  });

  it('connects to trace(boot-complete) and pane-admission signals on the default singleton', async () => {
    let pending = 1;
    const unregisterCensus = registerAgentMemoryCensus(
      () => ({ live: 1, pending }),
      'test-post-boot',
    );
    try {
      const ran: string[] = [];
      enqueuePostBootIdleTask('singleton-task', () => {
        ran.push('singleton-task');
      });

      // Emit boot-complete trace just like window.ts does on first mount.
      trace({ kind: 'boot-complete', bootMs: 1200 });
      expect(getPostBootIdleQueueStatus().bootCompleted).toBe(true);

      // Advance past quiet window while pending=1 -> still blocked by pane spawn.
      await vi.advanceTimersByTimeAsync(POST_BOOT_IDLE_QUIET_MS + 1_000);
      expect(ran).toEqual([]);

      // Pane finishes spawning, then another pane is admitted via admitAgentSpawnSync.
      pending = 0;
      admitAgentSpawnSync(1, Date.now(), { NEXUS_PANE_GUARD: 'off' });
      await vi.advanceTimersByTimeAsync(POST_BOOT_SPAWN_SETTLE_MS - 200);
      expect(ran).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(ran).toEqual(['singleton-task']);
    } finally {
      unregisterCensus();
    }
  });
});

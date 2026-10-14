import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warmPool } from '../pty/warm-pool';
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
  startPostBootIdleQueue,
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

  describe('ceilings (C1/C2)', () => {
    const DEADLINE_AFTER_MOUNT_MS = 45_000;
    const DEADLINE_WITHOUT_MOUNT_MS = 90_000;
    const TASK_TIMEOUT_MS = 30_000;
    const STOP_TIMEOUT_MS = 1_500;
    const ceilings = {
      deadlineAfterMountMs: DEADLINE_AFTER_MOUNT_MS,
      deadlineWithoutMountMs: DEADLINE_WITHOUT_MOUNT_MS,
      taskTimeoutMs: TASK_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
    };

    it('drains at boot-complete + deadline while spawns never stop and CPU stays busy', async () => {
      const ran: string[] = [];
      let lastSpawnAt = 0;
      const queue = new PostBootIdleQueue({
        ...ceilings,
        // A mission loop admits a pane every 1.5 s (< settle) and one pane is
        // stuck in "spawning": without a ceiling the queue would never drain.
        hasPendingSpawns: () => true,
        getLastSpawnAt: () => lastSpawnAt,
        hasCpuHeadroom: () => false,
      });
      const spawnLoop = setInterval(() => {
        lastSpawnAt = Date.now();
        queue.notifyPaneSpawnActivity(lastSpawnAt);
      }, 1_500);
      try {
        queue.enqueue('hooks-consent', () => {
          ran.push('hooks-consent');
        });
        queue.notifyBootComplete(Date.now());

        await vi.advanceTimersByTimeAsync(DEADLINE_AFTER_MOUNT_MS - 1);
        expect(ran).toEqual([]);

        // +1 ms: a spawn tick landing on the deadline re-arms a 0 ms timer,
        // which Node clamps to 1 ms.
        await vi.advanceTimersByTimeAsync(2);
        expect(ran).toEqual(['hooks-consent']);
        expect(queue.status().deadlineReached).toBe(true);
      } finally {
        clearInterval(spawnLoop);
      }
    });

    it('drains at process start + deadline when the renderer never mounts', async () => {
      const ran: string[] = [];
      const processStartAt = Date.now() - 10_000;
      const queue = new PostBootIdleQueue({
        ...ceilings,
        hasPendingSpawns: () => false,
        getLastSpawnAt: () => 0,
        hasCpuHeadroom: () => true,
      });
      queue.enqueue('db-prune', () => {
        ran.push('db-prune');
      });
      queue.start(processStartAt);

      await vi.advanceTimersByTimeAsync(DEADLINE_WITHOUT_MOUNT_MS - 10_000 - 1);
      expect(ran).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(ran).toEqual(['db-prune']);

      // A late mount cannot move the latched deadline back into gated mode.
      queue.notifyBootComplete(Date.now());
      queue.enqueue('late-task', () => {
        ran.push('late-task');
      });
      await vi.advanceTimersByTimeAsync(POST_BOOT_INTER_TASK_YIELD_MS);
      expect(ran).toEqual(['db-prune', 'late-task']);
    });

    it('aborts a stuck task at its timeout and still runs the tasks behind it', async () => {
      const ran: string[] = [];
      let stuckSignal: AbortSignal | undefined;
      const errors: string[] = [];
      const queue = new PostBootIdleQueue({
        ...ceilings,
        hasPendingSpawns: () => false,
        getLastSpawnAt: () => 0,
        hasCpuHeadroom: () => true,
        onTaskError: (name) => errors.push(name),
      });
      queue.enqueue('never-settles', (signal) => {
        stuckSignal = signal;
        return new Promise<void>(() => undefined);
      });
      queue.enqueue('initQuotaService', () => {
        ran.push('initQuotaService');
      });
      queue.notifyBootComplete(Date.now());

      await vi.advanceTimersByTimeAsync(POST_BOOT_IDLE_QUIET_MS);
      expect(queue.status().runningTask).toBe('never-settles');
      expect(stuckSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_MS + POST_BOOT_INTER_TASK_YIELD_MS);
      expect(stuckSignal?.aborted).toBe(true);
      expect(errors).toEqual(['never-settles']);
      expect(ran).toEqual(['initQuotaService']);
    });

    it('stop() aborts the running task and resolves within the stop ceiling', async () => {
      let runningSignal: AbortSignal | undefined;
      const queue = new PostBootIdleQueue({
        ...ceilings,
        hasPendingSpawns: () => false,
        getLastSpawnAt: () => 0,
        hasCpuHeadroom: () => true,
      });
      queue.enqueue('slow-network', (signal) => {
        runningSignal = signal;
        return new Promise<void>(() => undefined);
      });
      queue.notifyBootComplete(Date.now());
      await vi.advanceTimersByTimeAsync(POST_BOOT_IDLE_QUIET_MS);
      expect(queue.status().runningTask).toBe('slow-network');

      let stopped = false;
      void queue.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runningSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
      expect(stopped).toBe(true);
    });
  });

  it('reads CPU headroom without side effects on the warm pool (C6)', async () => {
    const loadavg = vi.spyOn(os, 'loadavg').mockReturnValue([1_000, 1_000, 1_000]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const skippedBefore = warmPool.getMetrics().skippedByCpu;
      const ran: string[] = [];
      const queue = new PostBootIdleQueue({
        hasPendingSpawns: () => false,
        getLastSpawnAt: () => 0,
        maxCpuDeferrals: 1,
      });
      queue.enqueue('cpu-bound', () => {
        ran.push('cpu-bound');
      });
      queue.notifyBootComplete(Date.now());
      await vi.advanceTimersByTimeAsync(POST_BOOT_IDLE_QUIET_MS);
      expect(ran).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ran).toEqual(['cpu-bound']);
      expect(warmPool.getMetrics().skippedByCpu).toBe(skippedBefore);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      loadavg.mockRestore();
    }
  });

  it('connects to trace(boot-complete) and pane-admission signals on the default singleton', async () => {
    startPostBootIdleQueue();
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

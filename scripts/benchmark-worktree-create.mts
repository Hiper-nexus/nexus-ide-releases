/**
 * F-764: real Git + WorktreeManager, in a disposable repository.
 * Run: node --import tsx scripts/benchmark-worktree-create.mts
 * Measures creation only; fixture setup/cleanup are outside the histogram.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { AsyncProcessGitRunner } from '../src/main/runtime/git-command.ts';
import { WorktreeManager } from '../src/main/runtime/worktree-manager.ts';
import type { WorktreeRecord, WorktreeStateSnapshot } from '../src/main/runtime/worktree-contract.ts';
import { removeTree } from '../src/main/util/remove-tree.ts';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-f764-create-'));
const root = await fs.realpath(directory);
const git = new AsyncProcessGitRunner();
const fileCount = 2_048;
try {
  const repository = path.join(root, 'repo');
  await fs.mkdir(repository);
  await git.run(repository, ['init', '-b', 'main']);
  await fs.mkdir(path.join(repository, 'src'));
  for (let index = 0; index < fileCount; index++) {
    await fs.writeFile(path.join(repository, 'src', `${index}.txt`), 'fixture\n');
  }
  await git.run(repository, ['add', 'src']);
  await git.run(repository, ['commit', '-m', 'fixture'], {
    env: {
      GIT_AUTHOR_NAME: 'Nexus Test', GIT_AUTHOR_EMAIL: 'nexus@example.test',
      GIT_COMMITTER_NAME: 'Nexus Test', GIT_COMMITTER_EMAIL: 'nexus@example.test',
    },
  });
  let state: WorktreeStateSnapshot = { revision: 0, records: [] };
  const manager = new WorktreeManager({
    runtimeRoot: path.join(root, 'runtime'),
    stateStore: {
      read: () => state,
      compareAndSwap: (_scope, revision, records: readonly WorktreeRecord[]) => {
        if (revision !== state.revision) return false;
        state = { revision: revision + 1, records: structuredClone(records) };
        return true;
      },
    },
  });
  const scope = {
    version: 1 as const, installationId: 'f764-test',
    projectId: '11111111-1111-4111-8111-111111111111', checkoutId: 'benchmark',
    rootRealPath: repository, identitySource: 'manifest' as const,
  };
  const measurements = [];
  for (let worker = 0; worker < 3; worker++) {
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 25));
    histogram.reset();
    let lastTick = performance.now();
    let maxHeartbeatGapMs = 0;
    let heartbeatCount = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastTick);
      lastTick = now;
      heartbeatCount++;
    }, 5);
    const started = performance.now();
    try {
      const record = await manager.create({
        scope, missionId: 'f764', taskId: `task-${worker}`, workerId: `worker-${worker}`,
        ownerKind: 'pane', ownership: { files: [], symbols: [], domains: [`task-${worker}`] },
      });
      assert.equal(record.status, 'ready');
      const wallMs = performance.now() - started;
      // Account for the last slice even if create resolves before the next timer.
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, performance.now() - lastTick);
      measurements.push({ worker, wallMs, heartbeatCount, maxHeartbeatGapMs,
        sampleCount: histogram.count,
        p99LagMs: histogram.count ? Math.max(0, histogram.percentile(99) / 1e6 - 1) : null,
        maxLagMs: histogram.count ? Math.max(0, histogram.max / 1e6 - 1) : null });
    } finally {
      clearInterval(timer);
      histogram.disable();
    }
  }
  console.log(JSON.stringify({ schema: 'nexus.worktree-create-benchmark/v1', fileCount, measurements }, null, 2));
  for (const measurement of measurements) {
    assert.ok(measurement.heartbeatCount > 0, 'creation must yield to the event loop');
    assert.ok(measurement.maxHeartbeatGapMs < 100, 'heartbeat gap during creation must stay below 100 ms');
    assert.ok(measurement.maxLagMs !== null && measurement.maxLagMs < 100,
      'maximum event-loop lag during creation must stay below 100 ms');
  }
} finally {
  await removeTree(root, { recursive: true, force: true });
}

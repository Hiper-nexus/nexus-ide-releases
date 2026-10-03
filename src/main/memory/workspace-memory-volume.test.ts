import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { runPeriodicTask, periodicTaskSnapshot } from '../observability/periodic-task';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';

let root: string;
afterEach(() => { disposeWorkspaceMemoryStores(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('2000 retained notes keep the event loop advancing and opt-in export remains asynchronous', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-volume-'));
  const scope = testProjectScope({ rootRealPath: fs.realpathSync(root) });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank'), coordinationScopeFor: () => scope, vaultExportEnabled: () => true });
  const store = getWorkspaceMemoryStore(scope);
  let beats = 0;
  const probe = setInterval(() => beats++, 1);
  try {
    await runPeriodicTask('memory-maintenance:volume-test', async (ctx) => {
      for (let i = 0; i < 2_000; i++) {
        store.retain({ content: `# Volume note ${i}\n\nBounded knowledge ${i}.`, source: 'operator:note' });
        await ctx.checkpoint();
      }
    }, { sliceMs: 5, timeoutMs: 15_000 });
    const beatsBeforeExport = beats;
    expect(beatsBeforeExport).toBeGreaterThan(0);
    await store.flushProjections();
    expect(beats).toBeGreaterThan(beatsBeforeExport);
    expect(store.stats().workspace.active).toBe(2_000);
    expect(fs.readdirSync(path.join(scope.rootRealPath, '.nexus-memory')).filter((name) => name.endsWith('.md'))).toHaveLength(2_001);
    const task = periodicTaskSnapshot().tasks.find((entry) => entry.name === 'memory-maintenance');
    expect(task?.lastYieldAt).not.toBeNull();
  } finally { clearInterval(probe); }
}, 60_000);

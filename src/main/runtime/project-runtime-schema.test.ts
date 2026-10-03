import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProjectRuntimeManager } from './project-runtime-manager';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

it('historical accepted-handoff lookup uses an index instead of a dispatch table scan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-dispatch-index-'));
  const manager = new ProjectRuntimeManager({ baseDir: root, appVersion: 'test' });
  try {
    const runtime = manager.open(testProjectScope());
    const rows = runtime.db.prepare(`EXPLAIN QUERY PLAN SELECT id, mission_id, task_id, handoff_accepted_at
      FROM task_dispatch_queue WHERE handoff_id = ? AND handoff_accepted_at IS NOT NULL LIMIT 1`)
      .all('historical-handoff') as Array<{ detail: string }>;
    expect(rows.some((row) => row.detail.includes('SEARCH task_dispatch_queue USING INDEX idx_task_dispatch_queue_handoff_memory'))).toBe(true);
    expect(rows.some((row) => row.detail.includes('SCAN task_dispatch_queue'))).toBe(false);
  } finally { manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

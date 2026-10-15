import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProjectRuntimeManager } from './project-runtime-manager';
import { INITIAL_PROJECT_MIGRATIONS } from './project-runtime-schema';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

it('upgrades an existing populated database with idempotent hot-path indexes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hot-indexes-'));
  const scope = testProjectScope();
  const original = new ProjectRuntimeManager({ baseDir: root, appVersion: 'test',
    migrations: INITIAL_PROJECT_MIGRATIONS.filter((migration) => migration.schemaVersion <= 55) });
  const upgraded = new ProjectRuntimeManager({ baseDir: root, appVersion: 'test' });
  try {
    const db = original.open(scope).db;
    db.prepare(`INSERT INTO missions(id,title,status,created_at,updated_at)
      VALUES('mission-old','Existing mission','running',1,1)`).run();
    db.prepare(`INSERT INTO mission_panes(id,mission_id,adapter_id,title,pane_id,created_at)
      VALUES('spec-old','mission-old','codex','Existing pane','pane-old',1)`).run();
    db.prepare(`INSERT INTO audit_events(id,mission_id,actor,action,outcome,occurred_at)
      VALUES('audit-old','mission-old','session-old','nexus_handoff_submit','intent',1)`).run();
    db.prepare(`INSERT INTO usage_events(id,mission_id,pane_id,provider,event_type,metadata_json,occurred_at)
      VALUES('usage-old','mission-old','spec-old','codex','tokens',?,1)`)
      .run(JSON.stringify({ sessionId: 'session-old', accountId: 'account-old',
        cacheReadTokens: 10, cacheWrite5mTokens: 5, cacheWrite1hTokens: 1 }));
    db.prepare(`INSERT INTO route_decisions(mission_id,task_preview,tier,adapter_id,reason,created_at)
      VALUES('mission-old','Existing route','routine','codex','Existing decision',1)`).run();
    original.closeAll();

    const runtime = upgraded.open(scope);
    expect(runtime.health.status).toBe('healthy');
    const migration = INITIAL_PROJECT_MIGRATIONS.find((item) => item.id === '056-hot-path-query-indexes');
    expect(migration).toBeDefined();
    // Replay the SQL itself too: recovery/install does not require a pristine database.
    runtime.db.exec(migration!.sql);
    runtime.db.exec(migration!.sql);
    const cases = [
      ['SELECT id FROM mission_panes WHERE pane_id = ?', ['pane-old'], 'idx_mission_panes_pane'],
      [`SELECT payload_json FROM audit_events WHERE mission_id = ? AND actor = ?
        AND action = ? AND outcome = 'intent'`, ['mission-old', 'session-old', 'nexus_handoff_submit'], 'idx_audit_authority'],
      ['SELECT id FROM usage_events WHERE mission_id = ?', ['mission-old'], 'idx_usage_mission'],
      ['SELECT id FROM usage_events WHERE pane_id = ?', ['spec-old'], 'idx_usage_pane'],
      [`SELECT id FROM usage_events WHERE event_type = ? AND provider = ?
        AND json_extract(metadata_json, '$.sessionId') = ?`, ['tokens', 'codex', 'session-old'], 'idx_usage_provider_session'],
      ['SELECT seq FROM route_decisions WHERE mission_id = ?', ['mission-old'], 'idx_route_decisions_mission'],
    ] as const;
    for (const [sql, params, index] of cases) {
      const rows = runtime.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
      expect(rows.some((row) => row.detail.includes(index)), sql).toBe(true);
      expect(runtime.db.prepare(sql).all(...params), sql).toHaveLength(1);
    }
    const indexes = runtime.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>;
    expect(indexes.some((item) => item.name === 'usage_events_token_snapshot_idx')).toBe(true);
    expect(runtime.db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    original.closeAll(); upgraded.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

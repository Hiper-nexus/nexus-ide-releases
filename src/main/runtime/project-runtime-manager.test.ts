import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ProjectRuntimeCapacityError,
  ProjectRuntimeInUseError,
  ProjectRuntimeManager,
  ProjectRuntimeUnavailableError,
} from './project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from './project-runtime-schema';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

function scope(
  projectId: string,
  checkoutId: string,
): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-test',
    projectId,
    checkoutId,
    rootRealPath: '/workspace',
    identitySource: 'manifest',
  };
}

function missionTitle(runtime: ReturnType<ProjectRuntimeManager['open']>): string {
  return (
    runtime.db
      .prepare('SELECT title FROM missions WHERE id = ?')
      .get('shared-id') as { title: string }
  ).title;
}

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(
  options: Partial<ConstructorParameters<typeof ProjectRuntimeManager>[0]> = {},
): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '9.4.1-test',
    ...options,
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-project-runtime-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('ProjectRuntimeManager physical isolation', () => {
  it('keeps different projects in physically separate databases', () => {
    const runtimeManager = manager();
    const runtimeA = runtimeManager.open(scope(PROJECT_A, 'checkout-a'));
    const runtimeB = runtimeManager.open(scope(PROJECT_B, 'checkout-b'));

    runtimeA.db
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, created_at, updated_at)
         VALUES (?, ?, '', 'active', ?, ?)`,
      )
      .run('shared-id', 'Project A', 1, 1);
    runtimeB.db
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, created_at, updated_at)
         VALUES (?, ?, '', 'active', ?, ?)`,
      )
      .run('shared-id', 'Project B', 2, 2);

    expect(missionTitle(runtimeA)).toBe('Project A');
    expect(missionTitle(runtimeB)).toBe('Project B');
    expect(runtimeA.databasePath).not.toBe(runtimeB.databasePath);
    expect(runtimeA.databasePath).toContain(`${path.sep}projects${path.sep}`);
    expect(runtimeA.databasePath).not.toContain(PROJECT_A);
    expect(runtimeB.databasePath).not.toContain(PROJECT_B);
  });

  it('separates checkouts belonging to the same project', () => {
    const runtimeManager = manager();
    const first = runtimeManager.open(scope(PROJECT_A, 'checkout-one'));
    const second = runtimeManager.open(scope(PROJECT_A, 'checkout-two'));

    first.db
      .prepare(
        `INSERT INTO notes (id, title, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('note-1', 'First checkout', 'one', 1, 1);

    expect(first.databasePath).not.toBe(second.databasePath);
    expect(
      second.db.prepare('SELECT COUNT(*) AS count FROM notes').get(),
    ).toEqual({ count: 0 });
  });

  it('refuses a database copied into a different checkout directory', () => {
    const runtimeManager = manager();
    const sourceScope = scope(PROJECT_A, 'checkout-copy-source');
    const targetScope = scope(PROJECT_A, 'checkout-copy-target');
    const source = runtimeManager.open(sourceScope);
    runtimeManager.close(sourceScope);
    const targetLocation = runtimeManager.locationFor(targetScope);
    fs.copyFileSync(source.databasePath, targetLocation.databasePath);

    const target = runtimeManager.open(targetScope);

    expect(target.mode).toBe('safe-read-only');
    expect(target.health.failureCode).toBe('runtime_scope_mismatch');
    expect(target.db.readonly).toBe(true);
  });

  it('never embeds untrusted scope IDs directly in filesystem paths', () => {
    const runtimeManager = manager();
    const hostile = scope('../../outside/project', '../checkout\\escape');
    const location = runtimeManager.locationFor(hostile);

    expect(location.databasePath.startsWith(fs.realpathSync(baseDir))).toBe(true);
    expect(location.databasePath).not.toContain('outside');
    expect(location.databasePath).not.toContain('escape');
    expect(
      path.relative(fs.realpathSync(baseDir), location.databasePath),
    ).not.toMatch(/^\.\./);
  });

  it('installs the complete scoped schema and auditable migration metadata', () => {
    const runtime = manager().open(scope(PROJECT_A, 'checkout-schema'));
    const tables = new Set(
      (
        runtime.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    for (const expected of [
      '__nexus_runtime_scope',
      '__nexus_schema_migrations',
      'missions',
      'mission_panes',
      'handoffs',
      'tasks',
      'todo_lists',
      'todos',
      'notes',
      'sticky_notes',
      'workspace_layout',
      'usage_events',
      'media_artifacts',
      'gamification_events',
      'xp_events',
      'gamification_meta',
      'voice_transcript_entries',
      'audit_events',
      'memory_entries',
      'browser_artifacts',
      'context_drafts',
    ]) {
      expect(tables).toContain(expected);
    }
    expect(tables).not.toContain('panes');

    const xpEventColumns = new Set(
      (
        runtime.db.prepare('PRAGMA table_info(xp_events)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const expected of [
      'entity_key',
      'kind',
      'mission_id',
      'agent_category',
      'effort',
      'cost_usd',
      'evidence',
      'retro',
      'points',
      'rule_version',
      'created_at',
    ]) {
      expect(xpEventColumns).toContain(expected);
    }

    const transcriptColumns = new Set(
      (
        runtime.db
          .prepare('PRAGMA table_info(voice_transcript_entries)')
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    expect(transcriptColumns).toEqual(
      new Set([
        'id',
        'session_id',
        'sequence',
        'role',
        'text',
        'audio_url',
        'created_at',
      ]),
    );

    const missionPaneColumns = new Set(
      (
        runtime.db.prepare('PRAGMA table_info(mission_panes)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const expected of [
      'id',
      'mission_id',
      'adapter_id',
      'model',
      'account_id',
      'effort',
      'cwd',
      'title',
      'agent_name',
      'role',
      'pane_id',
      'scope_json',
      'allowed_tools_json',
      'allowed_skills_json',
      'created_at',
    ]) {
      expect(missionPaneColumns).toContain(expected);
    }
    const todoColumns = new Set(
      (
        runtime.db.prepare('PRAGMA table_info(todos)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const expected of [
      'id',
      'list_id',
      'mission_id',
      'task_id',
      'name',
      'status',
      'position',
      'created_at',
      'updated_at',
    ]) {
      expect(todoColumns).toContain(expected);
    }
    const missionColumns = new Set(
      (
        runtime.db.prepare('PRAGMA table_info(missions)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    expect(missionColumns).toContain('orch_session_id');
    expect(missionColumns).toContain('learnings');
    expect(missionColumns).not.toContain('orchestrator_run_id');
    const handoffColumns = new Set(
      (
        runtime.db.prepare('PRAGMA table_info(handoffs)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    expect(handoffColumns).toContain('delivered');
    expect(handoffColumns).toContain('delivery_state');
    expect(handoffColumns).toContain('submitted_at');
    expect(handoffColumns).toContain('acknowledged_at');
    expect(handoffColumns).toContain('consumed_at');
    expect(handoffColumns).not.toContain('delivered_at');
    runtime.db
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, created_at, updated_at)
         VALUES (?, ?, '', 'active', ?, ?)`,
      )
      .run('mission-schema', 'Schema mission', 1, 1);
    runtime.db
      .prepare(
        `INSERT INTO mission_panes
           (id, mission_id, adapter_id, title, role, pane_id, scope_json,
            allowed_tools_json, allowed_skills_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'mission-pane-1',
        'mission-schema',
        'codex',
        'Reviewer',
        'worker',
        'pane-layout-1',
        JSON.stringify(scope(PROJECT_A, 'checkout-schema')),
        JSON.stringify(['nexus_file_read']),
        JSON.stringify(['review']),
        1,
      );
    expect(
      runtime.db
        .prepare(
          `SELECT pane_id, scope_json, allowed_tools_json, allowed_skills_json
           FROM mission_panes WHERE id = ?`,
        )
        .get('mission-pane-1'),
    ).toEqual({
      pane_id: 'pane-layout-1',
      scope_json: JSON.stringify(scope(PROJECT_A, 'checkout-schema')),
      allowed_tools_json: JSON.stringify(['nexus_file_read']),
      allowed_skills_json: JSON.stringify(['review']),
    });
    expect(runtime.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(runtime.db.pragma('quick_check', { simple: true })).toBe('ok');

    const rows = runtime.db
      .prepare(
        `SELECT migration_id, checksum, schema_version, app_version,
                applied_by_app_version
         FROM __nexus_schema_migrations ORDER BY schema_version`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual(
      INITIAL_PROJECT_MIGRATIONS.map((migration) => ({
        migration_id: migration.id,
        checksum: migration.checksum,
        schema_version: migration.schemaVersion,
        app_version: migration.appVersion,
        applied_by_app_version: '9.4.1-test',
      })),
    );
  });
});

describe('ProjectRuntimeManager migrations and health', () => {
  it('backs up the database before applying each pending migration batch', () => {
    const firstMigration = createProjectMigration({
      id: 'test-001-sample',
      schemaVersion: 1,
      appVersion: '1.0.0',
      sql: 'CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
    });
    const secondMigration = createProjectMigration({
      id: 'test-002-extra',
      schemaVersion: 2,
      appVersion: '1.1.0',
      sql: 'CREATE TABLE extra (id TEXT PRIMARY KEY);',
    });
    const targetScope = scope(PROJECT_A, 'checkout-backup');

    const firstManager = manager({ migrations: [firstMigration] });
    const firstRuntime = firstManager.open(targetScope);
    firstRuntime.db
      .prepare('INSERT INTO sample (id, value) VALUES (?, ?)')
      .run('preserved', 'before migration');
    firstManager.close(targetScope);

    const secondManager = manager({
      migrations: [firstMigration, secondMigration],
    });
    const migrated = secondManager.open(targetScope);
    const backupPath = migrated.health.lastBackupPath;

    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(backupPath as string)).toBe(true);
    const backup = new Database(backupPath as string, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        backup.prepare('SELECT value FROM sample WHERE id = ?').get('preserved'),
      ).toEqual({ value: 'before migration' });
      expect(
        backup
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name = 'extra'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      backup.close();
    }
  });

  it('enters engine-enforced safe read-only mode on migration checksum mismatch', () => {
    const original = createProjectMigration({
      id: 'test-001-checksum',
      schemaVersion: 1,
      appVersion: '1.0.0',
      sql: 'CREATE TABLE sample (id TEXT PRIMARY KEY);',
    });
    const changed = createProjectMigration({
      id: 'test-001-checksum',
      schemaVersion: 1,
      appVersion: '1.0.0',
      sql: 'CREATE TABLE sample (id TEXT PRIMARY KEY, changed TEXT);',
    });
    const targetScope = scope(PROJECT_A, 'checkout-checksum');

    const firstManager = manager({ migrations: [original] });
    firstManager.open(targetScope);
    firstManager.close(targetScope);

    const secondManager = manager({ migrations: [changed] });
    const runtime = secondManager.open(targetScope);

    expect(runtime.mode).toBe('safe-read-only');
    expect(runtime.health.status).toBe('safe-read-only');
    expect(runtime.health.failureCode).toBe('migration_checksum_mismatch');
    expect(runtime.db.readonly).toBe(true);
    expect(() => runtime.db.exec("INSERT INTO sample (id) VALUES ('blocked')")).toThrow(
      /readonly/i,
    );
  });

  it('rolls back a failed migration and exposes its pre-migration backup', () => {
    const firstMigration = createProjectMigration({
      id: 'test-001-before-failure',
      schemaVersion: 1,
      appVersion: '1.0.0',
      sql: 'CREATE TABLE stable (id TEXT PRIMARY KEY);',
    });
    const brokenMigration = createProjectMigration({
      id: 'test-002-broken',
      schemaVersion: 2,
      appVersion: '1.1.0',
      sql: `
        CREATE TABLE must_rollback (id TEXT PRIMARY KEY);
        THIS IS NOT VALID SQL;
      `,
    });
    const targetScope = scope(PROJECT_A, 'checkout-rollback');
    const firstManager = manager({ migrations: [firstMigration] });
    firstManager.open(targetScope);
    firstManager.close(targetScope);

    const secondManager = manager({
      migrations: [firstMigration, brokenMigration],
    });
    const runtime = secondManager.open(targetScope);

    expect(runtime.mode).toBe('safe-read-only');
    expect(runtime.health.failureCode).toBe('migration_failed');
    expect(runtime.health.lastBackupPath).toBeTruthy();
    expect(fs.existsSync(runtime.health.lastBackupPath as string)).toBe(true);
    expect(
      runtime.db
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'must_rollback'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      runtime.db
        .prepare('SELECT COUNT(*) AS count FROM __nexus_schema_migrations')
        .get(),
    ).toEqual({ count: 1 });
  });

  it('reports corruption without creating a writable or in-memory fallback', () => {
    const runtimeManager = manager();
    const targetScope = scope(PROJECT_A, 'checkout-corrupt');
    const location = runtimeManager.locationFor(targetScope);
    fs.mkdirSync(location.directory, { recursive: true });
    fs.writeFileSync(location.databasePath, Buffer.from('not-a-sqlite-database'));

    const runtime = runtimeManager.open(targetScope);

    expect(runtime.mode).toBe('safe-read-only');
    expect(runtime.health.failureCode).toBe('integrity_check_failed');
    expect(runtime.databasePath).toBe(location.databasePath);
    expect(runtime.db.memory).toBe(false);
    expect(runtime.db.readonly).toBe(true);
    expect(() => runtime.db.exec('CREATE TABLE forbidden (id TEXT)')).toThrow(
      /readonly|database disk image|not a database/i,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a broken database symlink before SQLite can create its target',
    () => {
      const runtimeManager = manager();
      const targetScope = scope(PROJECT_A, 'checkout-broken-link');
      const location = runtimeManager.locationFor(targetScope);
      const outsideTarget = path.join(baseDir, 'outside-created.sqlite3');
      fs.symlinkSync(outsideTarget, location.databasePath, 'file');

      expect(() => runtimeManager.open(targetScope)).toThrow(
        ProjectRuntimeUnavailableError,
      );
      expect(fs.existsSync(outsideTarget)).toBe(false);
      expect(runtimeManager.getHealth(targetScope)?.failureCode).toBe(
        'unsafe_storage',
      );
    },
  );

  it('fails closed when SQLite cannot open and never attempts :memory:', () => {
    const attempts: string[] = [];
    const runtimeManager = manager({
      databaseFactory(filename) {
        attempts.push(filename);
        throw new Error('native sqlite unavailable');
      },
    });
    const targetScope = scope(PROJECT_A, 'checkout-no-sqlite');

    expect(() => runtimeManager.open(targetScope)).toThrow(
      ProjectRuntimeUnavailableError,
    );
    const health = runtimeManager.getHealth(targetScope);
    expect(health?.status).toBe('unavailable');
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((filename) => filename !== ':memory:')).toBe(true);
    expect(new Set(attempts).size).toBe(1);
  });

  it('loads the native SQLite constructor only when the first database opens', () => {
    let loads = 0;
    const runtimeManager = manager({
      databaseModuleLoader() {
        loads += 1;
        return Database;
      },
    });

    expect(loads).toBe(0);
    runtimeManager.open(scope(PROJECT_A, 'checkout-lazy-native-a'));
    expect(loads).toBe(1);
    runtimeManager.open(scope(PROJECT_B, 'checkout-lazy-native-b'));
    expect(loads).toBe(1);
  });

  it('contains a lazy native-module load failure at the database boundary', () => {
    let loads = 0;
    const runtimeManager = manager({
      databaseModuleLoader() {
        loads += 1;
        throw new Error('native ABI mismatch');
      },
    });
    const targetScope = scope(PROJECT_A, 'checkout-native-failure');

    expect(loads).toBe(0);
    expect(() => runtimeManager.open(targetScope)).toThrow(
      ProjectRuntimeUnavailableError,
    );
    expect(loads).toBe(1);
    expect(() => runtimeManager.open(targetScope)).toThrow(
      ProjectRuntimeUnavailableError,
    );
    expect(loads).toBe(1);
    expect(runtimeManager.getHealth(targetScope)?.failureCode).toBe(
      'database_open_failed',
    );
  });
});

describe('ProjectRuntimeManager lifecycle', () => {
  it('closes least-recently-used runtimes and supports explicit close', () => {
    const runtimeManager = manager({ maxOpen: 1 });
    const scopeA = scope(PROJECT_A, 'checkout-lru-a');
    const scopeB = scope(PROJECT_B, 'checkout-lru-b');
    const runtimeA = runtimeManager.open(scopeA);

    const runtimeB = runtimeManager.open(scopeB);

    expect(runtimeA.closed).toBe(true);
    expect(runtimeB.closed).toBe(false);
    expect(runtimeManager.close(scopeB)).toBe(true);
    expect(runtimeB.closed).toBe(true);
    expect(runtimeManager.close(scopeB)).toBe(false);
  });

  it('keeps a leased runtime pinned and fails closed when all capacity is pinned', () => {
    const runtimeManager = manager({ maxOpen: 1 });
    const scopeA = scope(PROJECT_A, 'checkout-lease-a');
    const scopeB = scope(PROJECT_B, 'checkout-lease-b');
    const lease = runtimeManager.acquire(scopeA);

    try {
      expect(lease.runtime.closed).toBe(false);
      expect(() => runtimeManager.open(scopeB)).toThrow(
        ProjectRuntimeCapacityError,
      );
      expect(lease.runtime.closed).toBe(false);
      expect(runtimeManager.getHealth(scopeB)).toBeNull();

      lease.release();
      expect(lease.released).toBe(true);
      lease.release();
      const runtimeB = runtimeManager.open(scopeB);
      expect(lease.runtime.closed).toBe(true);
      expect(runtimeB.closed).toBe(false);
    } finally {
      lease.release();
    }
  });

  it('counts independent pins and refuses explicit close until every lease releases', () => {
    const runtimeManager = manager({ maxOpen: 1 });
    const targetScope = scope(PROJECT_A, 'checkout-multi-lease');
    const first = runtimeManager.acquire(targetScope);
    const second = runtimeManager.pin(targetScope);

    expect(first.runtime).toBe(second.runtime);
    expect(() => runtimeManager.close(targetScope)).toThrow(
      ProjectRuntimeInUseError,
    );
    first.release();
    expect(() => runtimeManager.close(targetScope)).toThrow(
      ProjectRuntimeInUseError,
    );
    second.release();
    expect(runtimeManager.close(targetScope)).toBe(true);
    expect(first.runtime.closed).toBe(true);
  });

  it('evicts an unpinned LRU entry while preserving an older pinned runtime', () => {
    const runtimeManager = manager({ maxOpen: 2 });
    const pinned = runtimeManager.acquire(
      scope(PROJECT_A, 'checkout-pinned-oldest'),
    );
    const evictable = runtimeManager.open(
      scope(PROJECT_B, 'checkout-unpinned-newer'),
    );

    try {
      const newest = runtimeManager.open(
        scope(PROJECT_A, 'checkout-new-runtime'),
      );

      expect(pinned.runtime.closed).toBe(false);
      expect(evictable.closed).toBe(true);
      expect(newest.closed).toBe(false);
    } finally {
      pinned.release();
    }
  });
});

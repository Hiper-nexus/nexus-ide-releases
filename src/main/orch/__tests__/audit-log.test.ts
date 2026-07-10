import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLogCorruptionError,
  auditDenied,
  auditError,
  auditIntent,
  auditSuccess,
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  ensureAuditLogWritable,
  getAuditStoragePath,
  readAuditLog,
  writeAuditEntry,
} from '../../jarvis/audit-log';
import { ProjectRuntimeManager } from '../../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../../runtime/project-runtime-schema';
import { testProjectScope } from './scope-fixture';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(
  options: Partial<ConstructorParameters<typeof ProjectRuntimeManager>[0]> = {},
): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: 'audit-test',
    ...options,
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-audit-sqlite-'));
  configureAuditLogRuntime(manager());
});

afterEach(() => {
  disposeAuditLogRuntime();
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('project-scoped audit log', () => {
  it('physically isolates projects and checkouts while preserving redaction', () => {
    const projectA = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
    const checkoutB = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-b' });
    const projectB = testProjectScope({ projectId: 'project-b', checkoutId: 'checkout-a' });

    auditSuccess(
      { scope: projectA },
      'session-a',
      'nexus_file_write',
      { path: 'a.ts', content: 'source secret', token: 'raw-token' },
      12,
      true,
    );
    auditDenied(
      { scope: checkoutB },
      'session-b',
      'nexus_terminal_run',
      { command: 'TOKEN=secret npm test' },
      4,
      'Bearer should-not-leak',
    );
    auditError(
      { scope: projectB },
      'session-c',
      'nexus_pane_read',
      {},
      2,
      'failure',
      false,
    );

    expect(readAuditLog({ scope: projectA })).toEqual([
      expect.objectContaining({
        project_id: 'project-a',
        checkout_id: 'checkout-a',
        session: 'session-a',
        args: {
          path: 'a.ts',
          content: '[REDACTED_TEXT]',
          token: '[REDACTED]',
        },
      }),
    ]);
    expect(readAuditLog({ scope: checkoutB })).toEqual([
      expect.objectContaining({
        project_id: 'project-a',
        checkout_id: 'checkout-b',
        args: { command: '[REDACTED]' },
        error: 'Bearer [REDACTED]',
      }),
    ]);
    expect(readAuditLog({ scope: projectB })[0]).toMatchObject({
      project_id: 'project-b',
      checkout_id: 'checkout-a',
      result: 'error',
    });
    expect(new Set([
      getAuditStoragePath({ scope: projectA }),
      getAuditStoragePath({ scope: checkoutB }),
      getAuditStoragePath({ scope: projectB }),
    ]).size).toBe(3);
  });

  it('persists correlated intent and outcome across a manager restart', () => {
    const scope = testProjectScope({ checkoutId: 'restart' });
    auditIntent(
      { scope },
      'session-restart',
      'nexus_file_write',
      { path: 'restart.ts', content: 'hidden' },
      1,
      true,
      'http-mcp',
      'invocation-restart',
    );
    auditSuccess(
      { scope },
      'session-restart',
      'nexus_file_write',
      { path: 'restart.ts', content: 'hidden' },
      3,
      true,
      'http-mcp',
      'invocation-restart',
    );
    managers[0]?.closeAll();
    disposeAuditLogRuntime();
    configureAuditLogRuntime(manager());

    const entries = readAuditLog({ scope });
    expect(entries.map((entry) => entry.result)).toEqual(['intent', 'ok']);
    expect(entries.every(
      (entry) => entry.invocation_id === 'invocation-restart',
    )).toBe(true);
  });

  it('allows scoped inspection but rejects writes in safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only-audit' });
    auditSuccess({ scope }, 'session', 'nexus_pane_read', {}, 1, false);
    managers[0]?.closeAll();
    disposeAuditLogRuntime();

    const original = INITIAL_PROJECT_MIGRATIONS[0];
    const changed = createProjectMigration({
      id: original.id,
      schemaVersion: original.schemaVersion,
      appVersion: original.appVersion,
      sql: `${original.sql}\n-- immutable checksum changed for audit test`,
    });
    const readOnly = manager({
      migrations: [changed, ...INITIAL_PROJECT_MIGRATIONS.slice(1)],
    });
    configureAuditLogRuntime(readOnly);

    expect(readOnly.open(scope).mode).toBe('safe-read-only');
    expect(readAuditLog({ scope })).toHaveLength(1);
    expect(() => ensureAuditLogWritable({ scope })).toThrow(/read-only/i);
    expect(() =>
      auditSuccess({ scope }, 'session', 'nexus_pane_read', {}, 1, false),
    ).toThrow(/read-only/i);
    expect(readAuditLog({ scope })).toHaveLength(1);
  });

  it('fails reads and writes closed when project persistence is unavailable', () => {
    disposeAuditLogRuntime();
    const unavailable = manager({
      databaseFactory: (() => {
        throw new Error('SQLite unavailable');
      }) as never,
    });
    configureAuditLogRuntime(unavailable);
    const scope = testProjectScope({ checkoutId: 'unavailable-audit' });

    expect(() => readAuditLog({ scope })).toThrow(/no persistence fallback/i);
    expect(() => ensureAuditLogWritable({ scope })).toThrow(
      /no persistence fallback/i,
    );
    expect(() =>
      auditSuccess({ scope }, 'session', 'nexus_pane_read', {}, 1, false),
    ).toThrow(/no persistence fallback/i);
  });

  it('serializes concurrent callers without losing or crossing events', async () => {
    const scope = testProjectScope({ checkoutId: 'concurrent-audit' });
    await Promise.all(
      Array.from({ length: 75 }, async (_, index) => {
        auditSuccess(
          { scope },
          `session-${index}`,
          'nexus_pane_read',
          { index },
          index,
          false,
        );
      }),
    );

    const entries = readAuditLog({ scope }, 100);
    expect(entries).toHaveLength(75);
    expect(new Set(entries.map((entry) => entry.session)).size).toBe(75);
    expect(readAuditLog({ scope }, 5).map((entry) => entry.session)).toEqual([
      'session-70',
      'session-71',
      'session-72',
      'session-73',
      'session-74',
    ]);
  });

  it('redacts secrets on the lowest-level scoped write boundary', () => {
    const scope = testProjectScope({ checkoutId: 'direct-entry' });
    writeAuditEntry(
      { scope },
      {
        timestamp: new Date().toISOString(),
        session: 'direct',
        source: 'ipc-renderer',
        tool: 'nexus_terminal_run',
        args: { token: 'raw', command: 'echo safe' },
        result: 'denied',
        duration_ms: 1,
        user_authorized: false,
        error: 'Bearer abc.def --api-key super-secret TOKEN=also-secret',
      },
    );

    const [entry] = readAuditLog({ scope });
    expect(entry.args).toEqual({ token: '[REDACTED]', command: 'echo safe' });
    expect(entry.error).not.toContain('abc.def');
    expect(entry.error).not.toContain('super-secret');
    expect(entry.error).not.toContain('also-secret');
    clearAuditLogForTests({ scope });
    expect(readAuditLog({ scope })).toEqual([]);
  });

  it('redacts high-risk headers, env content, commands, and editor text', () => {
    const scope = testProjectScope({ checkoutId: 'redaction-matrix' });
    auditSuccess(
      { scope },
      'session-redaction',
      'nexus_terminal_run',
      {
        authorization: 'Bearer abc',
        cookie: 'sid=secret',
        'set-cookie': 'sid=secret',
        'x-api-key': 'secret',
        credential: 'secret',
        bearer: 'secret',
        command: 'TOKEN=abc npm test',
        text: 'inserted secret text',
        nested: { envFile: 'API_KEY=abc\nSAFE=1' },
      },
      10,
      true,
      'http-mcp',
    );

    expect(readAuditLog({ scope })[0]?.args).toMatchObject({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      'x-api-key': '[REDACTED]',
      credential: '[REDACTED]',
      bearer: '[REDACTED]',
      command: '[REDACTED]',
      text: '[REDACTED_TEXT]',
      nested: { envFile: '[REDACTED]' },
    });
  });

  it('rejects a row whose payload claims a different physical scope', () => {
    const scope = testProjectScope({ checkoutId: 'tampered-audit' });
    const timestamp = new Date().toISOString();
    const runtimeManager = managers[0];
    if (!runtimeManager) throw new Error('audit manager missing');
    runtimeManager.open(scope).db.prepare(
      `INSERT INTO audit_events
         (id, mission_id, actor, action, outcome, payload_json, occurred_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      'audit-tampered',
      'attacker',
      'nexus_pane_read',
      'ok',
      JSON.stringify({
        schema: 'nexus.mcp-audit/v1',
        timestamp,
        project_id: 'another-project',
        checkout_id: scope.checkoutId,
        source: 'ipc-renderer',
        args: {},
        duration_ms: 1,
        user_authorized: false,
      }),
      Date.parse(timestamp),
    );

    expect(() => readAuditLog({ scope })).toThrow(AuditLogCorruptionError);
  });

  it('requires an initialized runtime and never creates an implicit fallback', () => {
    const scope = testProjectScope({ checkoutId: 'not-configured' });
    disposeAuditLogRuntime();

    expect(() => ensureAuditLogWritable({ scope })).toThrow(/not initialized/i);
    expect(() => readAuditLog({ scope })).toThrow(/not initialized/i);
  });
});

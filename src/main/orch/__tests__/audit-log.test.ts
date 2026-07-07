import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditSuccess,
  auditError,
  auditDenied,
  readAuditLog,
  clearAuditLog,
  getAuditLogPath,
  closeAuditLog,
  setAuditLogPathForTests,
} from '../../jarvis/audit-log';

describe('audit-log', () => {
  const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-audit-log');
  const testAuditLog = path.join(testDir, 'jarvis-actions.log');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    setAuditLogPathForTests(testAuditLog);
    clearAuditLog();
  });

  afterEach(() => {
    closeAuditLog();
    setAuditLogPathForTests(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('writes and reads audit entries (JSONL)', () => {
    auditSuccess('sess1', 'nexus_file_read', { path: 'test.ts' }, 42, false);
    auditError('sess1', 'nexus_file_write', { path: 'test.ts', content: 'x' }, 100, 'disk full', true);
    auditDenied('sess1', 'nexus_terminal_run', { command: 'rm -rf /' }, 5, 'destructive');

    const entries = readAuditLog();
    expect(entries.length).toBe(3);

    expect(entries[0].session).toBe('sess1');
    expect(entries[0].source).toBe('ipc-renderer');
    expect(entries[0].tool).toBe('nexus_file_read');
    expect(entries[0].result).toBe('ok');
    expect(entries[0].duration_ms).toBe(42);
    expect(entries[0].user_authorized).toBe(false);

    expect(entries[1].result).toBe('error');
    expect(entries[1].error).toBe('disk full');
    expect(entries[1].user_authorized).toBe(true);

    expect(entries[2].result).toBe('denied');
    expect(entries[2].error).toBe('destructive');
  });

  it('each entry has required fields', () => {
    auditSuccess('sess1', 'nexus_file_read', { path: 'test.ts' }, 10, false);
    const entries = readAuditLog();
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry.timestamp).toBeTruthy();
    expect(entry.session).toBe('sess1');
    expect(entry.tool).toBe('nexus_file_read');
    expect(entry.args).toBeTruthy();
    expect(entry.result).toBe('ok');
    expect(typeof entry.duration_ms).toBe('number');
    expect(typeof entry.user_authorized).toBe('boolean');
  });

  it('clears log file', () => {
    auditSuccess('sess1', 'nexus_file_read', { path: 'test.ts' }, 10, false);
    expect(readAuditLog().length).toBe(1);
    clearAuditLog();
    expect(readAuditLog().length).toBe(0);
  });

  it('limits read entries', () => {
    for (let i = 0; i < 10; i++) {
      auditSuccess('sess1', 'nexus_file_read', { path: `test${i}.ts` }, 1, false);
    }
    const entries = readAuditLog(5);
    expect(entries.length).toBe(5);
  });

  it('readAuditLog returns empty array for missing file', () => {
    clearAuditLog();
    const entries = readAuditLog();
    expect(entries).toEqual([]);
  });

  it('getAuditLogPath returns the correct path', () => {
    expect(getAuditLogPath()).toBe(testAuditLog);
  });

  it('handles concurrent writes without errors', () => {
    for (let i = 0; i < 50; i++) {
      auditSuccess('sess1', 'nexus_file_read', { path: `test${i}.ts` }, 1, false);
    }
    const entries = readAuditLog();
    expect(entries.length).toBe(50);
  });

  it('args are serialized as JSON string', () => {
    const args = { path: 'test.ts', nested: { key: 'value' } };
    auditSuccess('sess1', 'nexus_file_read', args, 10, false);
    const entries = readAuditLog();
    expect(entries[0].args).toEqual(args);
  });

  it('redacts sensitive args before persisting', () => {
    auditSuccess(
      'sess1',
      'nexus_file_write',
      { path: 'test.ts', content: 'secret source', token: 'abc' },
      10,
      true,
    );
    const entries = readAuditLog();
    expect(entries[0].args).toMatchObject({
      path: 'test.ts',
      content: '[REDACTED_TEXT]',
      token: '[REDACTED]',
    });
  });

  it('redacts high-risk headers, env-shaped content, and editor text', () => {
    auditSuccess(
      'sess1',
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

    const [entry] = readAuditLog();
    expect(entry.source).toBe('http-mcp');
    expect(entry.args).toMatchObject({
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
});

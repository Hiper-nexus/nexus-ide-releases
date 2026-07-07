import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  writeAuditEntry,
  auditSuccess,
  auditError,
  auditDenied,
  readAuditLog,
  clearAuditLog,
  getAuditLogPath,
  closeAuditLog,
} from '../../jarvis/audit-log';

describe('audit-log', () => {
  beforeEach(() => {
    clearAuditLog();
  });

  afterEach(() => {
    closeAuditLog();
  });

  it('writes and reads audit entries (JSONL)', () => {
    auditSuccess('sess1', 'nexus_file_read', { path: 'test.ts' }, 42, false);
    auditError('sess1', 'nexus_file_write', { path: 'test.ts', content: 'x' }, 100, 'disk full', true);
    auditDenied('sess1', 'nexus_terminal_run', { command: 'rm -rf /' }, 5, 'destructive');

    const entries = readAuditLog();
    expect(entries.length).toBe(3);

    expect(entries[0].session).toBe('sess1');
    expect(entries[0].tool).toBe('nexus_file_read');
    expect(entries[0].result).toBe('ok');
    expect(entries[0].durationMs).toBe(42);
    expect(entries[0].userConfirmed).toBe(false);

    expect(entries[1].result).toBe('error');
    expect(entries[1].error).toBe('disk full');
    expect(entries[1].userConfirmed).toBe(true);

    expect(entries[2].result).toBe('denied');
    expect(entries[2].error).toBe('destructive');
  });

  it('each entry has required fields', () => {
    auditSuccess('sess1', 'nexus_file_read', { path: 'test.ts' }, 10, false);
    const entries = readAuditLog();
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry.ts).toBeTruthy();
    expect(entry.session).toBe('sess1');
    expect(entry.tool).toBe('nexus_file_read');
    expect(entry.args).toBeTruthy();
    expect(entry.result).toBe('ok');
    expect(typeof entry.durationMs).toBe('number');
    expect(typeof entry.userConfirmed).toBe('boolean');
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
    const path = getAuditLogPath();
    expect(path).toContain('jarvis-actions.log');
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
    const parsed = JSON.parse(entries[0].args);
    expect(parsed).toEqual(args);
  });
});
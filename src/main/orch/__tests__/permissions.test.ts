import { describe, expect, it, beforeEach } from 'vitest';
import {
  hasPermission,
  grantPermission,
  revokePermission,
  clearSession,
  clearAll,
  sessionPermissionCount,
  listSessionPermissions,
} from '../../jarvis/permissions';

describe('permissions', () => {
  beforeEach(() => {
    clearAll();
  });

  it('starts with no permissions', () => {
    expect(hasPermission('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' })).toBe(false);
  });

  it('grants and checks permission', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission('sess1', 'nexus_file_write', args);
    expect(hasPermission('sess1', 'nexus_file_write', args)).toBe(true);
  });

  it('different args are not cached', () => {
    grantPermission('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' });
    expect(hasPermission('sess1', 'nexus_file_write', { path: 'b.ts', content: 'y' })).toBe(false);
  });

  it('different sessions are isolated', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission('sess1', 'nexus_file_write', args);
    expect(hasPermission('sess2', 'nexus_file_write', args)).toBe(false);
  });

  it('different tools are isolated', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission('sess1', 'nexus_file_write', args);
    expect(hasPermission('sess1', 'nexus_terminal_run', { command: 'echo hi' })).toBe(false);
  });

  it('revokes specific permission', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission('sess1', 'nexus_file_write', args);
    revokePermission('sess1', 'nexus_file_write', args);
    expect(hasPermission('sess1', 'nexus_file_write', args)).toBe(false);
  });

  it('clears all permissions for a session', () => {
    grantPermission('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' });
    grantPermission('sess1', 'nexus_terminal_run', { command: 'npm test' });
    grantPermission('sess2', 'nexus_file_write', { path: 'a.ts', content: 'x' });
    clearSession('sess1');
    expect(sessionPermissionCount('sess1')).toBe(0);
    expect(sessionPermissionCount('sess2')).toBe(1);
  });

  it('counts session permissions', () => {
    expect(sessionPermissionCount('sess1')).toBe(0);
    grantPermission('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' });
    expect(sessionPermissionCount('sess1')).toBe(1);
    grantPermission('sess1', 'nexus_terminal_run', { command: 'npm test' });
    expect(sessionPermissionCount('sess1')).toBe(2);
  });

  it('lists session permissions', () => {
    grantPermission('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' });
    const list = listSessionPermissions('sess1');
    expect(list.length).toBe(1);
    expect(list[0].toolName).toBe('nexus_file_write');
    expect(list[0].grantedAt).toBeGreaterThan(0);
  });

  it('clearAll removes everything', () => {
    grantPermission('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' });
    grantPermission('sess2', 'nexus_terminal_run', { command: 'npm test' });
    clearAll();
    expect(sessionPermissionCount('sess1')).toBe(0);
    expect(sessionPermissionCount('sess2')).toBe(0);
  });

  it('args hash is deterministic for same args', () => {
    const args1 = { path: 'a.ts', content: 'x' };
    const args2 = { path: 'a.ts', content: 'x' };
    grantPermission('sess1', 'nexus_file_write', args1);
    expect(hasPermission('sess1', 'nexus_file_write', args2)).toBe(true);
  });
});
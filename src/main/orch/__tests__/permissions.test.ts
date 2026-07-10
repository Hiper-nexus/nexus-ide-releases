import { describe, expect, it, beforeEach } from 'vitest';
import {
  hasPermission,
  consumePermission,
  grantPermission,
  revokePermission,
  clearSession,
  clearAll,
  sessionPermissionCount,
  listSessionPermissions,
} from '../../jarvis/permissions';

const workspaceA = '/tmp/nexus-workspace-a';
const workspaceB = '/tmp/nexus-workspace-b';

function scope(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceId = workspaceA,
) {
  return { sessionId, workspaceId, toolName, args };
}

describe('permissions', () => {
  beforeEach(() => {
    clearAll();
  });

  it('starts with no permissions', () => {
    expect(hasPermission(scope('sess1', 'nexus_file_write', {
      path: 'a.ts',
      content: 'x',
    }))).toBe(false);
  });

  it('grants and checks permission', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission(scope('sess1', 'nexus_file_write', args));
    expect(hasPermission(scope('sess1', 'nexus_file_write', args))).toBe(true);
  });

  it('consumes an exact permission once', () => {
    const exact = scope('sess1', 'nexus_file_write', {
      path: 'a.ts',
      content: 'x',
    });
    grantPermission(exact);

    expect(consumePermission(exact)).toBe(true);
    expect(consumePermission(exact)).toBe(false);
    expect(hasPermission(exact)).toBe(false);
  });

  it('different args are not cached', () => {
    grantPermission(scope('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' }));
    expect(hasPermission(scope('sess1', 'nexus_file_write', {
      path: 'b.ts',
      content: 'y',
    }))).toBe(false);
  });

  it('different sessions are isolated', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission(scope('sess1', 'nexus_file_write', args));
    expect(hasPermission(scope('sess2', 'nexus_file_write', args))).toBe(false);
  });

  it('different tools are isolated', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission(scope('sess1', 'nexus_file_write', args));
    expect(hasPermission(scope('sess1', 'nexus_terminal_run', {
      command: 'echo hi',
    }))).toBe(false);
  });

  it('different workspaces are isolated', () => {
    const args = { path: 'package.json', content: 'x' };
    grantPermission(scope('sess1', 'nexus_file_write', args, workspaceA));
    expect(hasPermission(scope('sess1', 'nexus_file_write', args, workspaceB))).toBe(false);
  });

  it('revokes specific permission', () => {
    const args = { path: 'a.ts', content: 'x' };
    grantPermission(scope('sess1', 'nexus_file_write', args));
    revokePermission(scope('sess1', 'nexus_file_write', args));
    expect(hasPermission(scope('sess1', 'nexus_file_write', args))).toBe(false);
  });

  it('clears all permissions for a session', () => {
    grantPermission(scope('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' }));
    grantPermission(scope('sess1', 'nexus_terminal_run', { command: 'npm test' }));
    grantPermission(scope('sess2', 'nexus_file_write', { path: 'a.ts', content: 'x' }));
    clearSession('sess1');
    expect(sessionPermissionCount('sess1')).toBe(0);
    expect(sessionPermissionCount('sess2')).toBe(1);
  });

  it('counts session permissions', () => {
    expect(sessionPermissionCount('sess1')).toBe(0);
    grantPermission(scope('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' }));
    expect(sessionPermissionCount('sess1')).toBe(1);
    grantPermission(scope('sess1', 'nexus_terminal_run', { command: 'npm test' }));
    expect(sessionPermissionCount('sess1')).toBe(2);
  });

  it('lists session permissions', () => {
    grantPermission(scope('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' }));
    const list = listSessionPermissions('sess1');
    expect(list.length).toBe(1);
    expect(list[0].toolName).toBe('nexus_file_write');
    expect(list[0].workspaceId).toBe(workspaceA);
    expect(list[0].grantedAt).toBeGreaterThan(0);
  });

  it('clearAll removes everything', () => {
    grantPermission(scope('sess1', 'nexus_file_write', { path: 'a.ts', content: 'x' }));
    grantPermission(scope('sess2', 'nexus_terminal_run', { command: 'npm test' }));
    clearAll();
    expect(sessionPermissionCount('sess1')).toBe(0);
    expect(sessionPermissionCount('sess2')).toBe(0);
  });

  it('args hash is deterministic for same args', () => {
    const args1 = { path: 'a.ts', content: 'x' };
    const args2 = { path: 'a.ts', content: 'x' };
    grantPermission(scope('sess1', 'nexus_file_write', args1));
    expect(hasPermission(scope('sess1', 'nexus_file_write', args2))).toBe(true);
  });

  it('does not authorize different nested args', () => {
    grantPermission(scope('sess1', 'nexus_terminal_run', {
      command: 'echo hi',
      env: { SAFE: '1' },
    }));
    expect(hasPermission(scope('sess1', 'nexus_terminal_run', {
      command: 'echo hi',
      env: { SAFE: '2' },
    }))).toBe(false);
  });

  it('matches nested args regardless of key order', () => {
    grantPermission(scope('sess1', 'nexus_terminal_run', {
      command: 'echo hi',
      env: { B: '2', A: '1' },
    }));
    expect(hasPermission(scope('sess1', 'nexus_terminal_run', {
      env: { A: '1', B: '2' },
      command: 'echo hi',
    }))).toBe(true);
  });
});

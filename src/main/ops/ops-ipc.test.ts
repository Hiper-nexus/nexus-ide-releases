import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditSuccess,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from '../jarvis/audit-log';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { buildAuditLogSnapshot } from './ops-ipc';

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => 'test'),
    getAppPath: vi.fn(() => '/missing'),
    getPath: vi.fn(() => '/missing'),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
}));

let baseDir = '';
let manager: ProjectRuntimeManager;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ops-audit-'));
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'ops-test' });
  configureAuditLogRuntime(manager);
});

afterEach(() => {
  disposeAuditLogRuntime();
  manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('operational audit export', () => {
  it('exports only the explicitly authorized project checkout', () => {
    const scopeA = testProjectScope({ checkoutId: 'ops-a' });
    const scopeB = testProjectScope({ checkoutId: 'ops-b' });
    auditSuccess({ scope: scopeA }, 'a', 'nexus_pane_read', {}, 1, false);
    auditSuccess({ scope: scopeB }, 'b', 'nexus_pane_read', {}, 1, false);

    const snapshotA = buildAuditLogSnapshot(scopeA, 80);
    const snapshotB = buildAuditLogSnapshot(scopeB, 80);

    expect(snapshotA.entries.map((entry) => entry.session)).toEqual(['a']);
    expect(snapshotB.entries.map((entry) => entry.session)).toEqual(['b']);
    expect(snapshotA.path).not.toBe(snapshotB.path);
    expect(snapshotA.path.endsWith('runtime.sqlite3')).toBe(true);
  });
});

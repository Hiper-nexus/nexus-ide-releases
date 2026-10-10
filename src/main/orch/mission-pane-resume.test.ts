import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ScopedMissionPaneStore } from './mission-pane-store';
const binding = vi.hoisted(() => ({ store: null as ScopedMissionPaneStore | null,
  manager: null as import('../runtime/project-runtime-manager').ProjectRuntimeManager | null,
  nativeDb: null as import('better-sqlite3').Database | null }));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ missionPanes: binding.store, taskDispatches: { list: () => [] } }),
  requireProjectDomainStoreRegistry: () => ({ runtimeManager: () => binding.manager }),
}));
vi.mock('../persistence/db', () => ({ getDb: () => binding.nativeDb }));
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionPaneStore } from './mission-pane-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { captureMissionPaneResume } from './mission-pane-resume';
import { saveProviderPaneSession, getProviderPaneSession, copyProviderPaneSession } from '../persistence/provider-session-store';

function nativeStore(db: import('better-sqlite3').Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_pane_sessions (installation_id TEXT NOT NULL, project_id TEXT NOT NULL, checkout_id TEXT NOT NULL,
    pane_id TEXT NOT NULL, adapter_id TEXT NOT NULL, session_key TEXT NOT NULL, session_id TEXT NOT NULL, transcript_path TEXT, updated_at INTEGER NOT NULL,
    account_id TEXT, PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id))`);
  binding.nativeDb = db;
}

it('fences a real persisted mission runtime when its account changes during resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-resume-'));
  const manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: 'test' });
  binding.manager = manager;
  const scope = testProjectScope();
  try {
    const db = manager.open(scope).db;
    nativeStore(db);
    db.prepare("INSERT INTO missions (id, title, status, created_at, updated_at) VALUES ('m', 'M', 'running', 1, 1)").run();
    binding.store = createScopedMissionPaneStore(manager, scope);
    const stored = binding.store.record({ missionId: 'm', adapterId: 'muse', paneId: 'pane-original', model: 'recorded-model', accountId: 'account-a' });
    saveProviderPaneSession(scope, 'pane-original', 'muse', { key: 'session_id', id: 'native-conversation' }, 'account-a');
    const resume = captureMissionPaneResume(scope, 'm', 'pane-original', {});
    expect(resume.spec).toMatchObject({ adapterId: 'muse', accountId: 'account-a', model: 'recorded-model' });
    await Promise.resolve();
    db.prepare('UPDATE mission_panes SET account_id = ? WHERE id = ?').run('account-b', stored.id);
    expect(() => resume.assertCurrent()).toThrow('resume_authority_changed');
  } finally { binding.store = null; binding.nativeDb = null; manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});
it('F-1111: normal persisted resume copies the exact native record to a new pane without borrowing another account or checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-native-resume-'));
  const manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: 'test' }), scope = testProjectScope();
  binding.manager = manager;
  try {
    const db = manager.open(scope).db; nativeStore(db);
    db.prepare("INSERT INTO missions (id, title, status, created_at, updated_at) VALUES ('m', 'M', 'running', 1, 1)").run();
    binding.store = createScopedMissionPaneStore(manager, scope);
    binding.store.record({ missionId: 'm', adapterId: 'claude', paneId: 'pane-original', model: 'recorded-model', accountId: 'account-a',
      effort: 'high', cwd: scope.rootRealPath, executionScope: scope, visualTask: { id: 'assignment-native', since: 1 } });
    expect(saveProviderPaneSession(scope, 'pane-original', 'claude', { key: 'session_id', id: 'native-conversation' }, 'account-a')).toBe(true);
    const resume = captureMissionPaneResume(scope, 'm', 'pane-original', {});
    expect(resume.spec).toMatchObject({ accountId: 'account-a', model: 'recorded-model', effort: 'high', visualTask: { id: 'assignment-native', since: 1 } });
    expect(copyProviderPaneSession(scope, 'pane-original', 'pane-returned-new', 'claude', 'account-a')).toBe(true);
    expect(getProviderPaneSession(scope, 'pane-returned-new', 'claude', 'account-a')).toEqual({ key: 'session_id', id: 'native-conversation' });
    expect(copyProviderPaneSession(scope, 'pane-original', 'pane-foreign-account', 'claude', 'account-b')).toBe(false);
    expect(copyProviderPaneSession({ ...scope, checkoutId: 'foreign' }, 'pane-original', 'pane-foreign-checkout', 'claude', 'account-a')).toBe(false);
    expect(() => captureMissionPaneResume(scope, 'foreign-mission', 'pane-original', {})).toThrow('resume_unavailable');
    resume.assertCurrent();
    saveProviderPaneSession(scope, 'pane-original', 'claude', { key: 'session_id', id: 'substituted-native-conversation' }, 'account-a');
    expect(() => resume.assertCurrent()).toThrow('resume_authority_changed');
  } finally { binding.store = null; binding.nativeDb = null; manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

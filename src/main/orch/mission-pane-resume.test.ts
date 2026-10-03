import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ScopedMissionPaneStore } from './mission-pane-store';
const binding = vi.hoisted(() => ({ store: null as ScopedMissionPaneStore | null }));
vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: () => ({ missionPanes: binding.store }) }));
vi.mock('../persistence/provider-session-store', () => ({ getProviderPaneSession: () => ({ key: 'session_id', id: 'native-conversation' }) }));
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionPaneStore } from './mission-pane-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { captureMissionPaneResume } from './mission-pane-resume';

it('fences a real persisted mission runtime when its account changes during resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-resume-'));
  const manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: 'test' });
  const scope = testProjectScope();
  try {
    const db = manager.open(scope).db;
    db.prepare("INSERT INTO missions (id, title, status, created_at, updated_at) VALUES ('m', 'M', 'running', 1, 1)").run();
    binding.store = createScopedMissionPaneStore(manager, scope);
    const stored = binding.store.record({ missionId: 'm', adapterId: 'muse', paneId: 'pane-original', model: 'recorded-model', accountId: 'account-a' });
    const resume = captureMissionPaneResume(scope, 'm', 'pane-original', {});
    expect(resume.spec).toMatchObject({ adapterId: 'muse', accountId: 'account-a', model: 'recorded-model' });
    await Promise.resolve();
    db.prepare('UPDATE mission_panes SET account_id = ? WHERE id = ?').run('account-b', stored.id);
    expect(() => resume.assertCurrent()).toThrow('resume_authority_changed');
  } finally { binding.store = null; manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

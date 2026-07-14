import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionPaneStore } from './mission-pane-store';
import { createScopedMissionStore } from './mission-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.12.0-test' });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pane-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped mission pane store', () => {
  it('persists exact capability snapshots and restores immutable scope', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-a',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope, {
      idFactory: () => 'mpane-a',
      now: () => 80,
    });
    missions.create({ title: 'Mission A' });

    const recorded = panes.record({
      missionId: 'mission-a',
      adapterId: 'codex',
      paneId: 'pane-a',
      role: 'worker',
      agentName: 'QA',
      allowedTools: ['nexus_file_read'],
      allowedSkills: ['review'],
    });
    recorded.allowedTools?.push('mutated-outside');

    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope);
    expect(reopened.findByPaneId('pane-a')).toMatchObject({
      missionId: 'mission-a',
      paneId: 'pane-a',
      role: 'worker',
      agentName: 'QA',
      scope,
      allowedTools: ['nexus_file_read'],
      allowedSkills: ['review'],
    });
  });

  it('keeps explicit unrestricted null distinct from an absent snapshot', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const missionA = missions.create({ title: 'A' });
    const missionB = missions.create({ title: 'B' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);

    panes.record({
      missionId: missionA.id,
      adapterId: 'codex',
      allowedTools: null,
      allowedSkills: null,
    });
    panes.record({ missionId: missionB.id, adapterId: 'claude' });

    expect(panes.list(missionA.id)[0]).toMatchObject({
      allowedTools: null,
      allowedSkills: null,
    });
    expect(panes.list(missionB.id)[0].allowedTools).toBeUndefined();
    expect(panes.list(missionB.id)[0].allowedSkills).toBeUndefined();
  });

  it('deduplicates one composition member and only fills missing authority fields', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'A' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);

    const first = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Reviewer',
      role: 'worker',
    });
    const second = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Reviewer',
      role: 'worker',
      paneId: 'pane-a',
      allowedTools: ['nexus_file_read'],
    });
    panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Reviewer',
      role: 'worker',
      paneId: 'pane-b',
      allowedTools: ['nexus_terminal_run'],
    });

    expect(second.id).toBe(first.id);
    expect(panes.list(mission.id)).toHaveLength(1);
    expect(panes.list(mission.id)[0]).toMatchObject({
      paneId: 'pane-a',
      allowedTools: ['nexus_file_read'],
    });
  });

  it('rejects assigning a pane id already owned by another mission', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const missionA = missions.create({ title: 'A' });
    const missionB = missions.create({ title: 'B' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({ missionId: missionA.id, adapterId: 'codex', paneId: 'shared' });

    expect(() =>
      panes.record({
        missionId: missionB.id,
        adapterId: 'claude',
        paneId: 'shared',
      }),
    ).toThrow(/already belongs/i);
  });

  it('fails closed when corrupted persisted rows reuse a pane id', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const missionA = missions.create({ title: 'A' });
    const missionB = missions.create({ title: 'B' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({ missionId: missionA.id, adapterId: 'codex', paneId: 'shared' });
    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO mission_panes
           (id, mission_id, adapter_id, title, role, pane_id, scope_json,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'corrupt-duplicate',
        missionB.id,
        'claude',
        'Claude',
        'worker',
        'shared',
        JSON.stringify(scope),
        Date.now(),
      );

    expect(panes.findByPaneId('shared')).toBeNull();
  });

  it('does not expose panes from another checkout', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const missionA = createScopedMissionStore(runtimeManager, scopeA).create({ title: 'A' });
    const paneA = createScopedMissionPaneStore(runtimeManager, scopeA);
    const paneB = createScopedMissionPaneStore(runtimeManager, scopeB);
    paneA.record({ missionId: missionA.id, adapterId: 'codex', paneId: 'pane-a' });

    expect(paneA.findByPaneId('pane-a')).not.toBeNull();
    expect(paneB.findByPaneId('pane-a')).toBeNull();
  });

  it('removes a partially materialized pane by its scoped id', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'A' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const pane = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      paneId: 'pane-partial',
    });

    expect(panes.remove(pane.id)).toBe(true);
    expect(panes.findByPaneId('pane-partial')).toBeNull();
    expect(panes.remove(pane.id)).toBe(false);
  });

  it('rejects a row whose persisted authority claims another checkout', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'A',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const pane = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      paneId: 'pane-a',
    });
    runtimeManager
      .open(scope)
      .db.prepare('UPDATE mission_panes SET scope_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...scope, checkoutId: 'checkout-attacker' }),
        pane.id,
      );

    expect(() => panes.findByPaneId('pane-a')).toThrow(/invalid mission pane scope/i);
  });
});

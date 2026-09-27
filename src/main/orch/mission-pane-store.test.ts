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
      workerIncarnationId: 'worker-incarnation-a',
      allowedTools: ['nexus_file_read'],
      allowedSkills: ['review'],
      readOnly: true,
    });
    recorded.allowedTools?.push('mutated-outside');

    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope);
    expect(reopened.findByPaneId('pane-a')).toMatchObject({
      missionId: 'mission-a',
      paneId: 'pane-a',
      role: 'worker',
      agentName: 'QA',
      workerIncarnationId: 'worker-incarnation-a',
      scope,
      allowedTools: ['nexus_file_read'],
      allowedSkills: ['review'],
      readOnly: true,
    });
  });

  it('keeps worker pane incarnations distinct and durable', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Incarnation fence',
    });
    let id = 0;
    const panes = createScopedMissionPaneStore(runtimeManager, scope, {
      idFactory: () => `mpane-${++id}`,
    });

    const first = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Worker',
      role: 'worker',
      paneId: 'pane-first',
      workerIncarnationId: 'worker-incarnation-first',
    });
    const second = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Worker',
      role: 'worker',
      paneId: 'pane-second',
      workerIncarnationId: 'worker-incarnation-second',
    });

    expect(second.id).not.toBe(first.id);
    runtimeManager.close(scope);
    expect(createScopedMissionPaneStore(runtimeManager, scope).list(mission.id))
      .toMatchObject([
        { paneId: 'pane-first', workerIncarnationId: 'worker-incarnation-first' },
        { paneId: 'pane-second', workerIncarnationId: 'worker-incarnation-second' },
      ]);
  });

  it('garbage-collects legacy PREVC reviewer rows before restart listing', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Crash-safe review composition',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const orchestrator = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Maestro',
      role: 'orchestrator',
      paneId: 'pane-orchestrator',
    });
    const reviewerSuffix = 'a1b2c3d4e5f6';
    const reviewer = panes.record({
      missionId: mission.id,
      adapterId: 'claude',
      title: `review-${mission.id}-1-${reviewerSuffix}`,
      agentName: `reviewer-claude-1-${reviewerSuffix}`,
      role: 'worker',
      paneId: 'pane-prevc-reviewer',
      readOnly: true,
      executionScope: {
        ...scope,
        rootRealPath: '/tmp/nexus-prevc-review-crashed/checkout',
      },
      allowedTools: [
        'nexus_git_diff',
        'nexus_merge_review_submit',
      ],
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope);

    expect(reopened.list(mission.id).map((pane) => pane.id)).toEqual([
      orchestrator.id,
    ]);
    expect(reopened.findByPaneId(reviewer.paneId!)).toBeNull();
    const rows = runtimeManager
      .open(scope)
      .db.prepare(
        'SELECT id FROM mission_panes WHERE mission_id = ? ORDER BY id',
      )
      .all(mission.id) as Array<{ id: string }>;
    expect(rows).toEqual([{ id: orchestrator.id }]);
  });

  it('does not garbage-collect a normal read-only mission reviewer', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Durable QA',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const qa = panes.record({
      missionId: mission.id,
      adapterId: 'claude',
      title: 'QA sênior',
      agentName: 'reviewer-senior',
      role: 'worker',
      paneId: 'pane-durable-qa',
      workerIncarnationId: 'worker-incarnation-qa',
      readOnly: true,
      allowedTools: [
        'nexus_git_diff',
        'nexus_merge_review_submit',
      ],
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope);

    expect(reopened.list(mission.id).map((pane) => pane.id)).toEqual([qa.id]);
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

  it('promotes one mission pane to orchestrator and demotes the previous leader', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Promote leader',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Old leader',
      role: 'orchestrator',
      paneId: 'pane-old',
      allowedTools: null,
    });
    panes.record({
      missionId: mission.id,
      adapterId: 'opencode',
      title: 'New leader',
      role: 'worker',
      paneId: 'pane-new',
      workerIncarnationId: 'worker-incarnation-new',
      allowedTools: ['nexus_handoff_submit'],
    });

    const promoted = panes.promotePaneToOrchestrator(mission.id, 'pane-new');

    expect(promoted).toMatchObject({
      missionId: mission.id,
      paneId: 'pane-new',
      role: 'orchestrator',
      workerIncarnationId: undefined,
    });
    expect(panes.list(mission.id)).toMatchObject([
      { paneId: 'pane-new', role: 'orchestrator' },
      { paneId: 'pane-old', role: 'worker' },
    ]);
  });

  it('fails promotion when the pane is dead or belongs to another mission', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const missionA = missions.create({ title: 'A' });
    const missionB = missions.create({ title: 'B' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({
      missionId: missionB.id,
      adapterId: 'codex',
      role: 'worker',
      paneId: 'pane-b',
    });

    expect(panes.promotePaneToOrchestrator(missionA.id, 'pane-missing')).toBeNull();
    expect(panes.promotePaneToOrchestrator(missionA.id, 'pane-b')).toBeNull();
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

  it('persists one immutable mission revision seal and upgrades an unsealed row once', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Sealed',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const authoritySeal = {
      intentVersion: 3,
      intentContractHash: '1'.repeat(64),
      contextRevision: '2'.repeat(64),
      contractHash: '3'.repeat(64),
      squadRevisionHash: '4'.repeat(64),
    };
    panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Worker',
      paneId: 'pane-sealed',
    });
    panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Worker',
      paneId: 'pane-sealed',
      authoritySeal,
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope);
    expect(reopened.findByPaneId('pane-sealed')?.authoritySeal).toEqual(
      authoritySeal,
    );
    expect(() =>
      reopened.record({
        missionId: mission.id,
        adapterId: 'codex',
        title: 'Worker',
        paneId: 'pane-sealed',
        authoritySeal: {
          ...authoritySeal,
          intentVersion: 4,
        },
      }),
    ).toThrow(/authority revision is immutable/i);
  });

  it('reseals only the exact orchestrator across a workflow revision', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Workflow rotation',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const fallbackSeal = {
      intentVersion: 3,
      intentContractHash: '1'.repeat(64),
      contextRevision: '1'.repeat(64),
      contractHash: '1'.repeat(64),
      squadRevisionHash: '4'.repeat(64),
    };
    const frozenSeal = {
      ...fallbackSeal,
      contextRevision: '2'.repeat(64),
      contractHash: '3'.repeat(64),
    };
    panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Orchestrator',
      paneId: 'pane-orchestrator',
      role: 'orchestrator',
      authoritySeal: fallbackSeal,
    });
    panes.record({
      missionId: mission.id,
      adapterId: 'claude',
      title: 'Worker',
      paneId: 'pane-worker',
      role: 'worker',
      authoritySeal: fallbackSeal,
    });
    panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      title: 'Legacy orchestrator',
      paneId: 'pane-legacy',
      role: 'orchestrator',
    });

    expect(
      panes.rebindOrchestratorAuthority({
        missionId: mission.id,
        paneId: 'pane-orchestrator',
        expectedAuthoritySeal: fallbackSeal,
        authoritySeal: frozenSeal,
      }).authoritySeal,
    ).toEqual(frozenSeal);
    expect(panes.findByPaneId('pane-worker')?.authoritySeal).toEqual(
      fallbackSeal,
    );
    expect(() =>
      panes.rebindOrchestratorAuthority({
        missionId: mission.id,
        paneId: 'pane-worker',
        expectedAuthoritySeal: fallbackSeal,
        authoritySeal: frozenSeal,
      }),
    ).toThrow(/only the exact mission orchestrator/i);
    expect(() =>
      panes.rebindOrchestratorAuthority({
        missionId: mission.id,
        paneId: 'pane-legacy',
        expectedAuthoritySeal: fallbackSeal,
        authoritySeal: frozenSeal,
      }),
    ).toThrow(/authority changed before reseal/i);
    expect(() =>
      panes.rebindOrchestratorAuthority({
        missionId: mission.id,
        paneId: 'pane-orchestrator',
        expectedAuthoritySeal: frozenSeal,
        authoritySeal: {
          ...frozenSeal,
          intentVersion: 4,
        },
      }),
    ).toThrow(/approval changed/i);
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

  it('libera o pane de uma missão encerrada para a próxima missão (done/failed)', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const failed = missions.create({ title: 'A' });
    panes.record({ missionId: failed.id, adapterId: 'claude', role: 'orchestrator', paneId: 'op' });
    missions.update(failed.id, { status: 'failed' });
    const next = missions.create({ title: 'B' });
    expect(panes.record({ missionId: next.id, adapterId: 'claude', role: 'orchestrator', paneId: 'op' }).paneId).toBe('op');
    expect(panes.findByPaneId('op')?.missionId).toBe(next.id);
    expect(panes.list(failed.id)).toHaveLength(1);
    expect(panes.list(failed.id)[0].paneId).toBeUndefined();
    // Missão viva continua dona do pane.
    const third = missions.create({ title: 'C' });
    expect(() =>
      panes.record({ missionId: third.id, adapterId: 'claude', role: 'orchestrator', paneId: 'op' }),
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

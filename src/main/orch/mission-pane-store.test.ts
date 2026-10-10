import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionPaneStore, workerContinuationSpecHash } from './mission-pane-store';
import { createScopedMissionStore } from './mission-store';
import { compileIntentContract } from '../../shared/mission-intent';
import {
  createMissionPaneAuthoritySeal,
  sameMissionPaneAuthoritySeal,
} from './mission-pane-authority';

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
      visualTask: { since: 75, id: 'original-assignment' },
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
      visualTask: { since: 75, id: 'original-assignment' },
    });
  });

  it('F-231: record/list preserva operatorOpened e pane sem a marca não a ganha', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-a',
    });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    missions.create({ title: 'Mission A' });

    panes.record({
      missionId: 'mission-a',
      adapterId: 'codex',
      paneId: 'pane-op',
      role: 'worker',
      operatorOpened: true,
    });
    panes.record({
      missionId: 'mission-a',
      adapterId: 'codex',
      paneId: 'pane-worker',
      role: 'worker',
    });

    expect(panes.findByPaneId('pane-op')?.operatorOpened).toBe(true);
    expect(panes.findByPaneId('pane-worker')?.operatorOpened).toBeUndefined();

    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope);
    // Sobrevive ao restart (coluna operator_opened, migração 040).
    expect(reopened.findByPaneId('pane-op')?.operatorOpened).toBe(true);
    expect(
      reopened.list('mission-a').some(
        (spec) => spec.paneId === 'pane-op' && spec.operatorOpened === true,
      ),
    ).toBe(true);
  });

  it('persists reused-worker visual assignments with mission and incarnation fences', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Visual assignment' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({ missionId: mission.id, adapterId: 'codex', paneId: 'reused-pane', role: 'worker', workerIncarnationId: 'inc-1' });
    expect(panes.assignVisualTask('reused-pane', mission.id, 'inc-1', undefined, { since: 2000, id: 'reused-assignment' })).toBe(true);
    expect(panes.assignVisualTask('reused-pane', 'other', 'inc-1', { since: 2000, id: 'reused-assignment' }, undefined)).toBe(false);
    expect(panes.assignVisualTask('reused-pane', mission.id, 'old-inc', { since: 2000, id: 'reused-assignment' }, undefined)).toBe(false);
    expect(panes.assignVisualTask('reused-pane', mission.id, 'inc-1', undefined, undefined)).toBe(false);
    runtimeManager.close(scope);
    const restored = createScopedMissionPaneStore(runtimeManager, scope);
    expect(restored.findByPaneId('reused-pane')?.visualTask).toEqual({ since: 2000, id: 'reused-assignment' });
    expect(restored.assignVisualTask('reused-pane', mission.id, 'inc-1', { since: 2000, id: 'wrong-assignment' }, undefined)).toBe(false);
    expect(restored.assignVisualTask('reused-pane', mission.id, 'inc-1', { since: 2000, id: 'reused-assignment' }, undefined)).toBe(true);
    expect(restored.findByPaneId('reused-pane')?.visualTask).toBeUndefined();
  });

  it('keeps legacy V6 visual restrictions while writing assignment identity in V7', () => {
    const runtimeManager = manager(); const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Legacy visual' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const recorded = panes.record({ missionId: mission.id, adapterId: 'codex', paneId: 'legacy-pane', role: 'worker',
      visualTask: { since: 1000, id: 'current-assignment' } });
    const db = runtimeManager.open(scope).db;
    const row = db.prepare('SELECT scope_json FROM mission_panes WHERE id = ?').get(recorded.id) as { scope_json: string };
    const legacy = JSON.parse(row.scope_json); legacy.schemaVersion = 6; delete legacy.visualTask.id; delete legacy.workerContinuation;
    db.prepare('UPDATE mission_panes SET scope_json = ? WHERE id = ?').run(JSON.stringify(legacy), recorded.id);
    runtimeManager.close(scope);
    const restored = createScopedMissionPaneStore(runtimeManager, scope).findByPaneId('legacy-pane')!;
    expect(restored.visualTask).toMatchObject({ since: 1000, id: expect.stringMatching(/^legacy-/) });
    expect(createScopedMissionPaneStore(runtimeManager, scope).findByPaneId('legacy-pane')?.visualTask).toEqual(restored.visualTask);
  });

  it('F-1151: a real V7 row (no continuation field) is read as-is and only a continuation write upgrades it to V8', () => {
    const runtimeManager = manager(); const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'V7 to V8' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const recorded = panes.record({ missionId: mission.id, adapterId: 'codex', paneId: 'v7-pane', role: 'worker',
      workerIncarnationId: 'inc-v7', visualTask: { since: 1000, id: 'assignment-v7' } });
    const db = runtimeManager.open(scope).db;
    const readEnvelope = () => JSON.parse((db.prepare('SELECT scope_json FROM mission_panes WHERE id = ?').get(recorded.id) as { scope_json: string }).scope_json);
    const v7 = readEnvelope(); v7.schemaVersion = 7; delete v7.workerContinuation;
    db.prepare('UPDATE mission_panes SET scope_json = ? WHERE id = ?').run(JSON.stringify(v7), recorded.id);
    runtimeManager.close(scope);
    const restored = createScopedMissionPaneStore(runtimeManager, scope);
    const source = restored.findByPaneId('v7-pane')!;
    expect(source).toMatchObject({ workerIncarnationId: 'inc-v7', visualTask: { since: 1000, id: 'assignment-v7' } });
    expect(source.workerContinuation).toBeUndefined();
    // Reading never rewrites a V7 row.
    expect(runtimeManager.open(scope).db.prepare('SELECT scope_json FROM mission_panes WHERE id = ?').get(recorded.id)).toMatchObject({ scope_json: JSON.stringify(v7) });
    const claim = { attemptId: 'attempt-v7', sourceSpecHash: workerContinuationSpecHash(source), ownerEpoch: 'epoch-1',
      nativeIdentityHash: 'a'.repeat(64), state: 'reserved' as const, childPossible: false, target: null, dispatch: null };
    restored.reserveWorkerContinuation(source, claim);
    const upgraded = JSON.parse((runtimeManager.open(scope).db.prepare('SELECT scope_json FROM mission_panes WHERE id = ?').get(recorded.id) as { scope_json: string }).scope_json);
    expect(upgraded.schemaVersion).toBe(8);
    expect(upgraded.visualTask).toEqual({ since: 1000, id: 'assignment-v7' });
    expect(restored.findByPaneId('v7-pane')?.workerContinuation).toMatchObject({ attemptId: 'attempt-v7', state: 'reserved' });
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

  it('missão livre sem squad: selo → record persistido → restauração', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Livre' });
    const contract = compileIntentContract({ goal: 'Missão livre', intentVersion: 1 });
    const seal = createMissionPaneAuthoritySeal({
      mission: {
        ...mission, status: 'running', squadId: undefined, intentState: 'executing', intentVersion: 1,
        intentContract: { ...contract, approvedAt: 10, dispatchedAt: 11, freeAgentChoice: true },
      },
      squad: null,
    });
    expect(seal).not.toBeNull();
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    panes.record({
      missionId: mission.id, adapterId: 'codex', role: 'worker', paneId: 'free-pane', authoritySeal: seal!,
    });
    runtimeManager.close(scope);
    const restored = createScopedMissionPaneStore(runtimeManager, scope).findByPaneId('free-pane');
    expect(restored?.missionId).toBe(mission.id);
    expect(sameMissionPaneAuthoritySeal(restored?.authoritySeal, seal)).toBe(true);
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

describe('selo da missão livre sem squad', () => {
  it('persiste na composição e volta igual na retomada', async () => {
    const { compileIntentContract } = await import('../../shared/mission-intent');
    const { createMissionPaneAuthoritySeal, sameMissionPaneAuthoritySeal } = await import('./mission-pane-authority');
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const contract = compileIntentContract({ goal: 'Missão · Login', intentVersion: 1 });
    const created = missions.create({
      title: 'Missão · Login',
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: { ...contract, approvedAt: 10, dispatchedAt: 11, freeAgentChoice: true },
    });
    const mission = missions.update(created.id, { status: 'running' })!;
    const seal = createMissionPaneAuthoritySeal({ mission, squad: null });
    expect(seal).not.toBeNull();

    createScopedMissionPaneStore(runtimeManager, scope).record({
      missionId: mission.id,
      adapterId: 'claude',
      paneId: 'pane-lider',
      role: 'orchestrator',
      authoritySeal: seal!,
    });
    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope).findByPaneId('pane-lider');
    expect(sameMissionPaneAuthoritySeal(reopened?.authoritySeal, seal)).toBe(true);
  });
});

describe('retomada da missão da aba move o pane do orquestrador (F-664)', () => {
  function setup() {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Missão · Terminais' });
    let id = 0;
    const panes = createScopedMissionPaneStore(runtimeManager, scope, { idFactory: () => `mpane-${++id}` });
    const leader = panes.record({
      missionId: mission.id, adapterId: 'claude', model: 'claude-opus-5-5', paneId: 'pane-operador',
      role: 'orchestrator', title: 'Orquestrador',
    });
    return { mission, panes, leader };
  }

  it('o record() deduplica o pane retomado; a linha passa a apontar para ele', () => {
    const { mission, panes, leader } = setup();
    // Campo 28/09: três "Retomar" seguidos e a linha sempre no pane antigo.
    const deduped = panes.record({
      missionId: mission.id, adapterId: 'claude', model: 'claude-opus-5-5', paneId: 'pane-retomado',
      role: 'orchestrator', title: 'Orquestrador',
    });
    expect(deduped.id).toBe(leader.id);
    expect(panes.findByPaneId('pane-retomado')).toBeNull();

    const moved = panes.moveOrchestratorPane(mission.id, leader.id, 'pane-retomado');
    expect(moved.paneId).toBe('pane-retomado');
    expect(panes.findByPaneId('pane-retomado')?.id).toBe(leader.id);
    expect(panes.findByPaneId('pane-operador')).toBeNull();
  });

  it('recusa mover worker e pane que já pertence a outra linha', () => {
    const { mission, panes, leader } = setup();
    const worker = panes.record({
      missionId: mission.id, adapterId: 'codex', paneId: 'pane-helper', role: 'worker', title: 'Helper',
    });
    expect(() => panes.moveOrchestratorPane(mission.id, worker.id, 'pane-x')).toThrow(/orchestrator/);
    expect(() => panes.moveOrchestratorPane(mission.id, leader.id, 'pane-helper')).toThrow(/already belongs/);
    expect(panes.findByPaneId('pane-operador')?.id).toBe(leader.id);
  });

  it('F-995: troca só a conta selada do orquestrador exato, com CAS na conta esperada', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Missão · Meus terminais' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    const leader = panes.record({
      missionId: mission.id,
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      accountId: 'acct-co-claude',
      title: 'Claude',
      agentName: 'Orquestrador',
      role: 'orchestrator',
      paneId: 'pane-12502a80',
    });
    const reviewer = panes.record({
      missionId: mission.id,
      adapterId: 'codex',
      accountId: 'acct-codex',
      title: 'Revisão sênior',
      role: 'worker',
      paneId: 'pane-muys5pen-1a',
      readOnly: true,
      workerIncarnationId: 'worker-incarnation-reviewer',
    });

    // CAS perdido (conta esperada errada) e worker: nada muda.
    expect(panes.rebindPaneAccount(mission.id, 'pane-12502a80', 'acct-outra', 'acct-re-claude')).toBeNull();
    expect(panes.rebindPaneAccount(mission.id, 'pane-muys5pen-1a', 'acct-codex', 'acct-x')).toBeNull();
    expect(panes.findByPaneId('pane-muys5pen-1a')?.accountId).toBe('acct-codex');

    const rebound = panes.rebindPaneAccount(mission.id, 'pane-12502a80', 'acct-co-claude', 'acct-re-claude');
    expect(rebound).toMatchObject({ id: leader.id, accountId: 'acct-re-claude', role: 'orchestrator' });
    // Persistido: reabrir o store lê a conta nova; o resto da composição fica.
    runtimeManager.close(scope);
    const reopened = createScopedMissionPaneStore(runtimeManager, scope).findByPaneId('pane-12502a80');
    expect(reopened).toMatchObject({ accountId: 'acct-re-claude', model: 'claude-opus-5-5', agentName: 'Orquestrador' });
    expect(reviewer.readOnly).toBe(true);
  });

  it('F-1002: preenche só a conta ausente da linha do pane do operador, nunca sobrescreve', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({ title: 'Missão · Meus terminais' });
    const panes = createScopedMissionPaneStore(runtimeManager, scope);
    // A linha de 07/10: "+ Pane → Nesta missão" sem account_id.
    const operator = panes.record({
      missionId: mission.id,
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      title: 'Claude · operador',
      agentName: 'Claude · operador',
      role: 'worker',
      paneId: 'pane-muyuzbjn-1e',
      workerIncarnationId: 'workerinc-muyuzbil-1c',
      operatorOpened: true,
    });
    const maestroWorker = panes.record({
      missionId: mission.id,
      adapterId: 'claude',
      title: 'Worker do Maestro',
      role: 'worker',
      paneId: 'pane-worker',
      workerIncarnationId: 'workerinc-worker',
    });
    const fill = (paneId: string, workerIncarnationId: string, accountId: string) =>
      panes.fillOperatorPaneSealedRuntime({
        missionId: mission.id, paneId, workerIncarnationId, accountId, effort: undefined,
      });

    // Encarnação errada e worker que não é do operador: nada muda.
    expect(fill('pane-muyuzbjn-1e', 'workerinc-outra', 'acct-mrqvpdwz-1')).toBeNull();
    expect(fill('pane-worker', 'workerinc-worker', 'acct-mrqvpdwz-1')).toBeNull();
    expect(panes.findByPaneId('pane-worker')?.accountId).toBeUndefined();
    expect(maestroWorker.operatorOpened).toBeUndefined();

    expect(fill('pane-muyuzbjn-1e', 'workerinc-muyuzbil-1c', 'acct-mrqvpdwz-1')).toMatchObject({
      id: operator.id, accountId: 'acct-mrqvpdwz-1', operatorOpened: true,
    });
    // Conta já gravada nunca é trocada por este caminho.
    expect(fill('pane-muyuzbjn-1e', 'workerinc-muyuzbil-1c', 'acct-outra')).toBeNull();
    runtimeManager.close(scope);
    expect(
      createScopedMissionPaneStore(runtimeManager, scope).findByPaneId('pane-muyuzbjn-1e'),
    ).toMatchObject({ accountId: 'acct-mrqvpdwz-1', model: 'claude-opus-5-5' });
  });

  it('fills omitted runtime values only while CAS-moving the expected orchestrator row (F-428)', () => {
    const { mission, panes, leader } = setup();
    const moved = panes.moveOrchestratorPane(mission.id, leader.id, 'pane-new', {
      expected: leader, model: leader.model, effort: 'medium',
    });
    expect(moved).toMatchObject({ id: leader.id, paneId: 'pane-new', effort: 'medium' });
    expect(panes.findByPaneId('pane-operador')).toBeNull();
    expect(panes.list(mission.id)).toMatchObject([{ paneId: 'pane-new', effort: 'medium' }]);
    expect(() => panes.moveOrchestratorPane(mission.id, leader.id, 'pane-stale', {
      expected: leader, model: leader.model, effort: 'medium',
    })).toThrow(/changed/);
    expect(panes.findByPaneId('pane-new')?.effort).toBe('medium');
  });

  it('does not change an explicit model or fill defaults on the same pane identity (F-428)', () => {
    const { mission, panes, leader } = setup();
    expect(() => panes.moveOrchestratorPane(mission.id, leader.id, 'pane-new', {
      expected: leader, model: 'different-model', effort: 'medium',
    })).toThrow(/model/);
    expect(() => panes.moveOrchestratorPane(mission.id, leader.id, leader.paneId!, {
      expected: leader, model: leader.model, effort: 'medium',
    })).toThrow(/new pane/);
    expect(panes.findByPaneId(leader.paneId!)?.effort).toBeUndefined();
  });

  it('F-1116: compensates only the entire captured replacement and restores omitted native defaults', () => {
    const { mission, panes, leader } = setup();
    const moved = panes.moveOrchestratorPane(mission.id, leader.id, 'pane-failed-resume', {
      expected: leader, model: leader.model, effort: 'medium',
    });
    expect(panes.compensateOrchestratorSpawn(moved, leader)).toBe(true);
    expect(panes.findByPaneId(leader.paneId!)).toEqual(leader);
    expect(panes.findByPaneId('pane-failed-resume')).toBeNull();
    const newer = panes.moveOrchestratorPane(mission.id, leader.id, 'pane-newer');
    expect(panes.compensateOrchestratorSpawn(moved, leader)).toBe(false);
    expect(panes.findByPaneId('pane-newer')).toEqual(newer);
  });

  it('F-1116: compensation refuses foreign identity and an old pane now owned by a participant', () => {
    const { mission, panes, leader } = setup();
    const moved = panes.moveOrchestratorPane(mission.id, leader.id, 'pane-failed-resume');
    expect(() => panes.compensateOrchestratorSpawn(moved, { ...leader, title: 'Foreign native identity' })).toThrow(/authority/);
    expect(() => panes.compensateOrchestratorSpawn({ ...moved, scope: { ...moved.scope, checkoutId: 'foreign' } }, leader)).toThrow(/authority/);
    const participant = panes.record({ missionId: mission.id, adapterId: 'codex', paneId: leader.paneId!,
      role: 'worker', agentName: 'Operator participant', operatorOpened: true });
    expect(panes.compensateOrchestratorSpawn(moved, leader)).toBe(false);
    expect(panes.findByPaneId(moved.paneId!)).toEqual(moved);
    expect(panes.findByPaneId(participant.paneId!)).toEqual(participant);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { compileIntentContract } from '../../shared/mission-intent';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped mission store', () => {
  it('rejects intentVersion skew and clones nested contract arrays', () => {
    const runtimeManager = manager();
    const store = createScopedMissionStore(runtimeManager, testProjectScope());
    const contract = {
      ...compileIntentContract({ goal: 'Ship safely', intentVersion: 2 }),
      deniedTools: ['terminal_run'],
    };
    expect(() => store.create({
      title: 'Skewed', intentVersion: 1, intentContract: contract,
    })).toThrow(/version must match/i);

    const created = store.create({
      title: 'Current', intentState: 'ready_to_start',
      intentVersion: 2, intentContract: contract,
    });
    expect(created.intentContract?.deniedTools).toEqual(['terminal_run']);
    expect(created.intentContract?.deniedTools).not.toBe(contract.deniedTools);
  });

  it('physically isolates projects and returns explicit scope coordinates', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ projectId: 'project-b', checkoutId: 'checkout-b' });
    const storeA = createScopedMissionStore(runtimeManager, scopeA);
    const storeB = createScopedMissionStore(runtimeManager, scopeB);

    const mission = storeA.create({ title: 'Only A', milestones: ['one'] });

    expect(mission).toMatchObject({
      title: 'Only A',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
    });
    expect(mission.milestones).toEqual([
      { id: 'step-1', label: 'one', status: 'pending', evidenceIds: [] },
    ]);
    expect(storeA.list()).toEqual([mission]);
    expect(storeB.list()).toEqual([]);
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeB).databasePath,
    );
  });

  it('persists every mutation and never exposes mutable stored arrays', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => 42,
      idFactory: () => 'mission-stable',
    });
    const created = store.create({
      title: 'Review',
      milestones: ['design'],
      orchestratorSessionId: 'session-a',
    });
    created.milestones.push({
      id: 'mutated',
      label: 'mutated-outside',
      status: 'pending',
      evidenceIds: [],
    });

    expect(store.get('mission-stable')?.milestones).toEqual([
      { id: 'step-1', label: 'design', status: 'pending', evidenceIds: [] },
    ]);
    expect(store.update('mission-stable', { milestones: ['tested'] })).toMatchObject({
      status: 'pending',
      milestones: [
        { id: 'step-1', label: 'tested', status: 'pending', evidenceIds: [] },
      ],
    });
    expect(store.setStatus('mission-stable', 'running')?.status).toBe('running');
    expect(store.setOrchestratorSession('mission-stable', 'session-b')).toMatchObject({
      orchestratorSessionId: 'session-b',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-stable')).toMatchObject({
      status: 'running',
      orchestratorSessionId: 'session-b',
      milestones: [
        { id: 'step-1', label: 'tested', status: 'pending', evidenceIds: [] },
      ],
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    expect(reopened.remove('mission-stable')).toBe(true);
    expect(reopened.remove('mission-stable')).toBe(false);
  });

  it('notifies only observers bound to the mutated scope', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedMissionStore(runtimeManager, scopeA);
    const storeB = createScopedMissionStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.onChange(listenerA);
    storeB.onChange(listenerB);

    storeA.create({ title: 'A' });

    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('fails closed when the runtime is unavailable instead of retaining memory data', () => {
    const unavailable = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    managers.push(unavailable);
    const store = createScopedMissionStore(unavailable, testProjectScope());

    expect(() => store.list()).toThrow(/no persistence fallback/i);
    expect(() => store.create({ title: 'must not exist' })).toThrow(
      /no persistence fallback/i,
    );
  });

  it('allows inspection but rejects writes in engine-enforced safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only' });
    const writableManager = manager();
    createScopedMissionStore(writableManager, scope, {
      idFactory: () => 'mission-read-only',
    }).create({ title: 'Persisted before failure' });
    writableManager.closeAll();

    const original = INITIAL_PROJECT_MIGRATIONS[0];
    const changed = createProjectMigration({
      id: original.id,
      schemaVersion: original.schemaVersion,
      appVersion: original.appVersion,
      sql: `${original.sql}\n-- immutable checksum changed`,
    });
    const safeReadOnlyManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      migrations: [changed],
    });
    managers.push(safeReadOnlyManager);
    const store = createScopedMissionStore(safeReadOnlyManager, scope);

    expect(store.list()).toHaveLength(1);
    expect(safeReadOnlyManager.open(scope).mode).toBe('safe-read-only');
    expect(() => store.create({ title: 'forbidden' })).toThrow(/read-only/i);
    expect(() => store.update('missing', {})).toThrow(/read-only/i);
    expect(store.list()).toHaveLength(1);
  });

  it('learnings começa vazio; appendLearning anexa com separador e persiste', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-learn',
    });
    const created = store.create({ title: 'Aprender' });
    expect(created.learnings).toBe('');

    const first = store.appendLearning(
      'mission-learn',
      '## Padrões\n- use X para Y',
    );
    expect(first?.learnings).toBe('## Padrões\n- use X para Y');

    // Segunda entrada ganha separador de parágrafo (não cola na anterior).
    const second = store.appendLearning(
      'mission-learn',
      '## Entrada\n- descobri Z',
    );
    expect(second?.learnings).toBe(
      '## Padrões\n- use X para Y\n\n## Entrada\n- descobri Z',
    );

    // Persiste após reabrir o runtime (provou que foi ao DB, não só memória).
    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-learn')?.learnings).toBe(
      '## Padrões\n- use X para Y\n\n## Entrada\n- descobri Z',
    );
  });

  it('appendLearning retorna null para missão inexistente', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope);
    expect(store.appendLearning('nope', 'entry')).toBeNull();
  });

  it('coerces legacy string[] milestones to structured on create and reload', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-legacy',
    });
    const created = store.create({
      title: 'Legacy',
      milestones: ['design', 'build', 'ship'],
    });
    expect(created.milestones).toEqual([
      { id: 'step-1', label: 'design', status: 'pending', evidenceIds: [] },
      { id: 'step-2', label: 'build', status: 'pending', evidenceIds: [] },
      { id: 'step-3', label: 'ship', status: 'pending', evidenceIds: [] },
    ]);
    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-legacy')?.milestones).toEqual(created.milestones);
  });

  it('persists structured milestones round-trip and rejects done without evidence', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-struct',
    });
    store.create({
      title: 'Structured',
      milestones: [
        {
          id: 's1',
          label: 'Scaffold',
          status: 'in-progress',
          evidenceIds: [],
        },
        {
          id: 's2',
          label: 'Ship',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    // Attempt to mark done without evidenceIds → structural coerce to pending.
    const coerced = store.update('mission-struct', {
      milestones: [
        {
          id: 's1',
          label: 'Scaffold',
          status: 'done',
          evidenceIds: [],
        },
        {
          id: 's2',
          label: 'Ship',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    expect(coerced?.milestones[0]?.status).toBe('pending');
    expect(coerced?.milestones[0]?.evidenceIds).toEqual([]);

    // With evidenceIds present, update stores the claim; markMilestoneDone
    // still requires those ids to be in the trusted set.
    store.update('mission-struct', {
      milestones: [
        {
          id: 's1',
          label: 'Scaffold',
          status: 'in-progress',
          evidenceIds: ['ev-1'],
        },
        {
          id: 's2',
          label: 'Ship',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    const untrusted = store.markMilestoneDone('mission-struct', 's1', []);
    expect(untrusted?.milestones.find((s) => s.id === 's1')?.status).toBe(
      'in-progress',
    );
    const trusted = store.markMilestoneDone('mission-struct', 's1', ['ev-1']);
    expect(trusted?.milestones.find((s) => s.id === 's1')?.status).toBe('done');

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-struct')?.milestones).toEqual([
      {
        id: 's1',
        label: 'Scaffold',
        status: 'done',
        evidenceIds: ['ev-1'],
      },
      {
        id: 's2',
        label: 'Ship',
        status: 'pending',
        evidenceIds: [],
      },
    ]);
  });

  it('loads mixed legacy string + structured rows from milestones_json', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-mixed',
    });
    // Write raw mixed JSON the way an older client + new client might leave it.
    const created = store.create({ title: 'Mixed' });
    const db = runtimeManager.open(scope).db;
    db.prepare(
      'UPDATE missions SET milestones_json = ? WHERE id = ?',
    ).run(
      JSON.stringify([
        'legacy-label',
        {
          id: 'custom',
          label: 'Structured step',
          status: 'blocked',
          evidenceIds: ['e1'],
        },
      ]),
      created.id,
    );
    const loaded = store.get('mission-mixed');
    expect(loaded?.milestones).toEqual([
      {
        id: 'step-1',
        label: 'legacy-label',
        status: 'pending',
        evidenceIds: [],
      },
      {
        id: 'custom',
        label: 'Structured step',
        status: 'blocked',
        evidenceIds: ['e1'],
      },
    ]);
  });

  it('persists Ralph budget, failed attempts and signal debounce across restart', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'ralph-runtime' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-ralph',
    });
    store.create({ title: 'Durable loop' });

    expect(store.ensureDriveRuntimeState('mission-ralph', 100)).toMatchObject({
      runStartedAt: 100,
      attemptCount: 0,
    });
    expect(
      store.reserveDriveAttempt('mission-ralph', 'signal-stall', 200),
    ).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: 200,
      lastOutcome: 'reserved',
    });
    expect(
      store.finishDriveAttempt(
        'mission-ralph',
        'failed',
        250,
        'delivery failed',
      ),
    ).toMatchObject({
      attemptCount: 1,
      lastOutcome: 'failed',
      lastError: 'delivery failed',
    });
    store.recordDriveSignal('mission-ralph', 275);

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.getDriveRuntimeState('mission-ralph')).toMatchObject({
      runStartedAt: 100,
      attemptCount: 1,
      lastAttemptAt: 200,
      lastSignalAt: 275,
      lastOutcome: 'failed',
    });
    expect(
      reopened.reserveDriveAttempt('mission-ralph', 'advance', 300),
    ).toMatchObject({
      runStartedAt: 100,
      attemptCount: 2,
      lastAttemptAt: 300,
    });
    reopened.setStatus('mission-ralph', 'blocked');
    reopened.setStatus('mission-ralph', 'running');
    expect(reopened.getDriveRuntimeState('mission-ralph')).toBeNull();
  });
});

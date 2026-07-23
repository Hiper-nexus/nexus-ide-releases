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
      attachmentPaths: ['/Users/me/.nexus/dropped/proof.png'],
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
    expect(created.intentContract?.attachmentPaths).toEqual(
      contract.attachmentPaths,
    );
    expect(created.intentContract?.attachmentPaths).not.toBe(
      contract.attachmentPaths,
    );
    contract.attachmentPaths.push('/tmp/forged-after-create');
    expect(store.get(created.id)?.intentContract?.attachmentPaths).toEqual([
      '/Users/me/.nexus/dropped/proof.png',
    ]);

    runtimeManager.close(testProjectScope());
    const reopened = createScopedMissionStore(
      runtimeManager,
      testProjectScope(),
    );
    expect(reopened.get(created.id)?.intentContract?.attachmentPaths).toEqual([
      '/Users/me/.nexus/dropped/proof.png',
    ]);
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

  it('preserves explicit technical blocks and defaults only unspecified blocks to user', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'blocking-contract' });
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => `mission-block-${++sequence}`,
    });
    const technical = store.create({
      title: 'Falha recuperável',
      intentState: 'executing',
    });
    store.setStatus(technical.id, 'running');

    expect(
      store.update(technical.id, {
        status: 'blocked',
        intentState: 'blocked_technical',
      }),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(
      store.update(technical.id, { description: 'Diagnóstico atualizado' }),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(store.setStatus(technical.id, 'blocked')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    const unspecified = store.create({
      title: 'Espera humana sem classificação',
      intentState: 'executing',
    });
    store.setStatus(unspecified.id, 'running');
    expect(store.setStatus(unspecified.id, 'blocked')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });

    const canonical = store.create({
      title: 'Contrato técnico canônico',
      intentState: 'executing',
    });
    store.setStatus(canonical.id, 'running');
    expect(store.block(canonical.id, 'technical')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get(technical.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(reopened.get(unspecified.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
    expect(reopened.get(canonical.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('persiste RouteReservation, consome uma vez e invalida expiração/intenção', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });
    const mission = store.create({
      title: 'Rota durável',
      intentState: 'dispatched',
      intentVersion: 1,
    });
    store.setStatus(mission.id, 'running');
    const decision = {
      tier: 'medium' as const,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      reason: 'modelo real do CLI para execução isolada',
      alternatives: [
        { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'medium' },
      ],
    };
    const reserved = store.reserveRouteDecision(mission.id, 'implementar RC3', decision);
    expect(reserved).toMatchObject({
      id: 'route-reservation-2',
      missionId: mission.id,
      intentVersion: 1,
      decision,
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    expect(store.get(mission.id)?.latestRoute).toMatchObject({
      reservationId: reserved.id,
      taskPreview: 'implementar RC3',
      tier: 'medium',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      reason: 'modelo real do CLI para execução isolada',
      state: 'reserved',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.getRouteReservation(reserved.id)).toMatchObject({
      id: reserved.id,
      decision,
    });
    const expectation = {
      reservationId: reserved.id,
      missionId: mission.id,
      adapterId: decision.adapterId,
      model: decision.model,
      effort: decision.effort,
      at: 1_001,
    };
    expect(reopened.assertRouteReservation(expectation).consumedAt).toBeUndefined();
    expect(
      reopened.consumeRouteReservation(expectation, 'orchestrator-session'),
    ).toMatchObject({
      consumedAt: 1_001,
      consumedBySession: 'orchestrator-session',
    });
    expect(reopened.list()[0]?.latestRoute).toMatchObject({
      reservationId: reserved.id,
      state: 'consumed',
      consumedBySession: 'orchestrator-session',
    });
    expect(() => reopened.consumeRouteReservation(expectation, 'other-session')).toThrow(
      /já foi consumida/i,
    );

    now = 2_000;
    const fresh = store.reserveRouteDecision(mission.id, 'outra tarefa', decision, 1_000);
    expect(() =>
      store.assertRouteReservation({
        ...expectation,
        reservationId: fresh.id,
        at: fresh.expiresAt,
      }),
    ).toThrow(/expirou/i);

    const stale = store.reserveRouteDecision(mission.id, 'intenção atual', decision);
    store.update(mission.id, { intentVersion: 2 });
    expect(() =>
      store.assertRouteReservation({
        ...expectation,
        reservationId: stale.id,
        at: now,
      }),
    ).toThrow(/intenção.*mudou/i);
  });

  it('persiste aceite do kickoff e invalida sessão/revisão antigas após restart', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'kickoff-proof' });
    let now = 7_000;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
      idFactory: () => 'mission-kickoff-proof',
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Executar uma missão real com kickoff observado',
        intentVersion: 3,
      }),
      approvedAt: 6_000,
      dispatchedAt: 6_500,
    };
    const mission = store.create({
      title: 'Kickoff durável',
      intentState: 'dispatched',
      intentVersion: 3,
      intentContract: contract,
      orchestratorSessionId: 'orch-a',
    });
    store.setStatus(mission.id, 'running');

    expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
    expect(
      store.recordKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toMatchObject({
      missionId: mission.id,
      intentVersion: 3,
      orchestratorSessionId: 'orch-a',
      promptHash: 'a'.repeat(64),
      acceptedAt: 7_000,
    });
    expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(true);
    expect(
      store.hasExactCurrentKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toBe(true);
    expect(
      store.hasExactCurrentKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'b'.repeat(64),
      }),
    ).toBe(false);

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
    });
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(true);

    reopened.setOrchestratorSession(mission.id, 'orch-b');
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
    expect(
      reopened.hasExactCurrentKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toBe(false);
    expect(() =>
      reopened.recordKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toThrow(/autoridade.*kickoff/i);

    now = 8_000;
    reopened.recordKickoffAcceptance({
      missionId: mission.id,
      intentVersion: 3,
      orchestratorSessionId: 'orch-b',
      promptHash: 'b'.repeat(64),
    });
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(true);

    reopened.update(mission.id, {
      intentVersion: 4,
      intentContract: {
        ...contract,
        intentVersion: 4,
        approvedAt: 7_500,
        dispatchedAt: 7_600,
      },
    });
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
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

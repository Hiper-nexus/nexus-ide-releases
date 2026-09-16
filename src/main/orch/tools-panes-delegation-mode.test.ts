import { describe, expect, it } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  activeSameCheckoutWorker,
  decideSameCheckoutSpawn,
  reserveWorkerSpawnSlot,
  shouldReleaseWorkerReservation,
  withSameCheckoutWorkerContract,
  withIsolatedWriterContract,
} from './tools-panes';
import { testProjectScope } from './__tests__/scope-fixture';
import { compileIntentContract } from '../../shared/mission-intent';

function pane(
  state: PaneSnapshot['state'],
  role: PaneSnapshot['role'] = 'worker',
  missionId = 'mission-a',
  checkoutRoot = '/repo/a',
  extra: Partial<PaneSnapshot> = {},
): PaneSnapshot {
  return {
    paneId: `${missionId}-${role}-${state}`,
    sessionId: 'session-a',
    title: 'worker',
    kind: 'cli-agent',
    state,
    role,
    missionId,
    executionScope: testProjectScope({ rootRealPath: checkoutRoot }),
    ...extra,
  };
}

describe('pre-contract same-checkout delegation', () => {
  it('states isolated writer conflicts, integration limits and required handoff diff', () => {
    const prompt = withIsolatedWriterContract('Implementar tarefa.', { worktreePath: '/worktree/a', branch: 'worker-a' });
    expect(prompt).toMatch(/mesmo arquivo.*conflit/i);
    expect(prompt).toMatch(/não há merge automático/i);
    expect(prompt).toMatch(/branch.*não pode ser publicada/i);
    expect(prompt).toMatch(/arquivos tocados.*diff/i);
    for (const operation of ['push', 'pull', 'stash', 'checkout', 'reset', 'clean']) expect(prompt).toContain(operation);
    expect(prompt).toContain('Implementar tarefa.');
  });
  it('blocks another active worker anywhere in the same checkout', () => {
    expect(activeSameCheckoutWorker([
      pane('idle'),
      pane('busy', 'orchestrator'),
      pane('busy', 'worker', 'mission-b', '/repo/b'),
    ], '/repo/a')).toBeNull();

    expect(activeSameCheckoutWorker([
      pane('busy'),
    ], '/repo/a')?.state).toBe('busy');
    expect(activeSameCheckoutWorker([
      pane('spawning', 'worker', 'mission-b'),
    ], '/repo/a')?.state).toBe('spawning');
  });

  it('does NOT block on read-only workers (they cannot mutate the shared checkout)', () => {
    // A doutrina é "1 worker ESCRITOR por vez". Um fan-out de leitura (mapa
    // de viabilidade + auditoria cética) não pode ficar serializado como se
    // fosse escrita concorrente — leitura não muta o índice do checkout.
    expect(activeSameCheckoutWorker([
      pane('busy', 'worker', 'mission-a', '/repo/a', { readOnly: true }),
    ], '/repo/a')).toBeNull();

    expect(activeSameCheckoutWorker([
      pane('spawning', 'worker', 'mission-a', '/repo/a', { nativeReadOnly: true }),
    ], '/repo/a')).toBeNull();

    // Um escritor vivo ao lado de um leitor vivo ainda bloqueia (escritor é o
    // limitador, não o leitor).
    expect(activeSameCheckoutWorker([
      pane('busy', 'worker', 'mission-a', '/repo/a', { readOnly: true }),
      pane('busy', 'worker', 'mission-a', '/repo/a'),
    ], '/repo/a')?.state).toBe('busy');
  });

  it('injects a non-destructive ownership contract into the worker prompt', () => {
    const prompt = withSameCheckoutWorkerContract('Corrija o fluxo de voz.');

    expect(prompt).toContain('executionMode=\`same_checkout\`');
    expect(prompt).toContain('não use stash, reset, checkout');
    expect(prompt).toContain('Corrija o fluxo de voz.');
    expect(prompt).toContain('nexus_handoff_submit');
  });

  it('serializes maxWorkers reservations across concurrent spawn attempts', () => {
    const scope = testProjectScope();
    const base = compileIntentContract({ goal: 'ship', intentVersion: 1 });
    const contract = {
      ...base,
      budgets: { ...base.budgets, maxWorkers: 1 },
    };

    const first = reserveWorkerSpawnSlot({
      scope,
      missionId: 'mission-race',
      contract,
      currentWorkerCount: 0,
      allowedTools: ['file_read'],
    });
    expect(first.ok).toBe(true);
    const second = reserveWorkerSpawnSlot({
      scope,
      missionId: 'mission-race',
      contract,
      currentWorkerCount: 0,
      allowedTools: ['file_read'],
    });
    expect(second).toMatchObject({ ok: false, code: 'budget_exhausted' });

    if (first.ok) first.release();
    const afterRelease = reserveWorkerSpawnSlot({
      scope,
      missionId: 'mission-race',
      contract,
      currentWorkerCount: 0,
      allowedTools: ['file_read'],
    });
    expect(afterRelease.ok).toBe(true);
    if (afterRelease.ok) afterRelease.release();
  });

  it('only drops the reservation once the spawned worker is durably counted', () => {
    // Spawn failed — nothing to count, always release.
    expect(
      shouldReleaseWorkerReservation({
        spawnedPaneId: undefined,
        recordedPaneIds: [],
      }),
    ).toBe(true);

    // Success + durable missionPanes row — safe to release.
    expect(
      shouldReleaseWorkerReservation({
        spawnedPaneId: 'pane-9',
        recordedPaneIds: ['pane-1', 'pane-9'],
      }),
    ).toBe(true);

    // Success but the row is missing: releasing would reopen the maxWorkers
    // TOCTOU (neither live count nor reservation covers the new worker).
    expect(
      shouldReleaseWorkerReservation({
        spawnedPaneId: 'pane-9',
        recordedPaneIds: ['pane-1'],
      }),
    ).toBe(false);
  });
});

describe('decideSameCheckoutSpawn (leitor acompanha escritor)', () => {
  it('spawn read-only é PERMITIDO ao lado de um escritor ativo', () => {
    expect(
      decideSameCheckoutSpawn({
        spawnReadOnly: true,
        activeWorker: { paneId: 'pane-executor', state: 'busy' },
      }),
    ).toEqual({ allowed: true });
  });

  it('spawn escritor continua serializado atrás de escritor ativo', () => {
    const decision = decideSameCheckoutSpawn({
      spawnReadOnly: false,
      activeWorker: { paneId: 'pane-executor', state: 'busy' },
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('serialized');
      expect(decision.reason).toContain('pane-executor');
    }
  });

  it('sem worker ativo, qualquer spawn passa', () => {
    expect(
      decideSameCheckoutSpawn({ spawnReadOnly: false, activeWorker: null }),
    ).toEqual({ allowed: true });
  });
});

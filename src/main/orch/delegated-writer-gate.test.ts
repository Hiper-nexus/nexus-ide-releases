import { describe, expect, it } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  claimSameCheckoutWriter,
  decideDelegatedWriterSpawn,
  delegatedPaneFacts,
  hasPendingWriterClaim,
  resetWriterClaimsForTests,
  type DelegatedPaneFact,
} from './delegated-writer-gate';

const writer = (over: Partial<DelegatedPaneFact> = {}): DelegatedPaneFact => ({
  paneId: 'pane-w', paneNumber: 4, state: 'busy', readOnly: false, checkoutId: 'ck', delegated: true, ...over,
});

describe('decideDelegatedWriterSpawn', () => {
  it('serializes writers within a tab, while independent tab worktrees can run together', () => {
    const panes = [writer({ executionRoot: '/worktrees/tab-a' })];
    expect(decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', executionRoot: '/worktrees/tab-b', panes }).allowed).toBe(true);
    expect(decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', executionRoot: '/worktrees/tab-a', panes }).allowed).toBe(false);
  });
  it('writer × writer delegado vivo no mesmo checkout: recusa nomeando o pane', () => {
    const out = decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', panes: [writer()] });
    expect(out).toEqual({
      allowed: false,
      reason: 'writer pane 4 ainda ativo — espere a entrega dele ou abra este como readOnly',
    });
  });

  it('reader sempre passa', () => {
    expect(decideDelegatedWriterSpawn({ spawnReadOnly: true, checkoutId: 'ck', panes: [writer()] })).toEqual({ allowed: true });
  });

  it('não contam: pane manual, reader, outro checkout, encerrado/estacionado/hibernado', () => {
    for (const pane of [
      writer({ delegated: false }),
      writer({ readOnly: true }),
      writer({ checkoutId: 'other' }),
      writer({ state: 'exited' }),
      writer({ state: 'parked' }),
      writer({ state: 'hibernated' }),
    ]) {
      expect(decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', panes: [pane] })).toEqual({ allowed: true });
    }
  });

  it('idle e spawning ainda bloqueiam (trabalho possivelmente não entregue)', () => {
    for (const state of ['idle', 'spawning', 'unknown'] as const) {
      expect(decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', panes: [writer({ state })] }).allowed).toBe(false);
    }
  });

  it('delegatedPaneFacts marca delegado quem tem pai', () => {
    const snapshots = [
      { paneId: 'a', sessionId: 's-a', title: 'a', kind: 'cli-agent', state: 'busy', scope: { checkoutId: 'ck' } },
      { paneId: 'b', sessionId: null, title: 'b', kind: 'cli-agent', state: 'busy' },
    ] as unknown as PaneSnapshot[];
    const facts = delegatedPaneFacts(snapshots, (sid) => (sid === 's-a' ? 'parent' : undefined));
    expect(facts.map((fact) => [fact.paneId, fact.delegated, fact.checkoutId])).toEqual([
      ['a', true, 'ck'],
      ['b', false, undefined],
    ]);
  });
});

describe('F-955: claim do writer vale até o pane nascido passar da largada', () => {
  const snap = (state: PaneSnapshot['state'], sessionId: string | null = null): PaneSnapshot[] =>
    [{ paneId: 'p1', sessionId, title: 'w', kind: 'cli-agent', state }];

  it('ACK pendente ainda não espelhado segura o checkout enquanto o Main tem o spawn pendente', () => {
    resetWriterClaimsForTests();
    let pending = true;
    const spawnPending = (paneId: string) => pending && paneId === 'p1';
    claimSameCheckoutWriter('/repo').settle('p1');
    expect(hasPendingWriterClaim('/repo', [], spawnPending)).toBe(true);
    expect(hasPendingWriterClaim('/other', [], spawnPending)).toBe(false);
    pending = false;
    expect(hasPendingWriterClaim('/repo', [], spawnPending)).toBe(false);
    // Visto no espelho e depois sumido: fechou, mesmo com concessão pendente.
    pending = true;
    claimSameCheckoutWriter('/repo').settle('p1');
    expect(hasPendingWriterClaim('/repo', snap('unknown'), spawnPending)).toBe(true);
    expect(hasPendingWriterClaim('/repo', [], spawnPending)).toBe(false);
  });

  it('com sessão: spawning/unknown seguram; busy/idle passam aos snapshots; encerrado solta', () => {
    for (const [state, held] of [['spawning', true], ['unknown', true], ['busy', false], ['idle', false], ['exited', false], ['parked', false]] as const) {
      resetWriterClaimsForTests();
      claimSameCheckoutWriter('/repo').settle('p1');
      expect(hasPendingWriterClaim('/repo', snap(state, 's1'))).toBe(held);
    }
    resetWriterClaimsForTests();
    claimSameCheckoutWriter('/repo').settle('p1');
    expect(hasPendingWriterClaim('/repo', snap('exited'))).toBe(false);
    claimSameCheckoutWriter('/repo').settle();
    expect(hasPendingWriterClaim('/repo', [])).toBe(false);
  });
});

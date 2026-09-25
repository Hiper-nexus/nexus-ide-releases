import { describe, expect, it } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  decideDelegatedWriterSpawn,
  delegatedPaneFacts,
  type DelegatedPaneFact,
} from './delegated-writer-gate';

const writer = (over: Partial<DelegatedPaneFact> = {}): DelegatedPaneFact => ({
  paneId: 'pane-w', paneNumber: 4, state: 'busy', readOnly: false, checkoutId: 'ck', delegated: true, ...over,
});

describe('decideDelegatedWriterSpawn', () => {
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

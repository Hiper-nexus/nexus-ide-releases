import { describe, expect, it } from 'vitest';
import {
  BLOCKING_SETTLEMENT_EFFECT_TYPES,
  canMarkTurnSettled,
  hasUnsettledBlockingEffects,
  unsettledBlockingEffectIds,
} from './effect-settlement-gate';
import { automaticCompletionEffectsSettled } from './automatic-completion-proof';

describe('ORC-02 effect settlement gate', () => {
  it('blocking types are exactly checkpoint.capture and handoff.deliver (T3)', () => {
    expect([...BLOCKING_SETTLEMENT_EFFECT_TYPES]).toEqual([
      'checkpoint.capture',
      'handoff.deliver',
    ]);
  });

  it('pending/running blocking effects prevent settling the terminal turn', () => {
    const effects = [
      { type: 'checkpoint.capture', status: 'running', threadId: 't1' },
      { type: 'turn.start', status: 'pending', threadId: 't1' },
    ];
    expect(hasUnsettledBlockingEffects(effects, 't1')).toBe(true);
    const gate = canMarkTurnSettled(effects, 't1');
    expect(gate.settled).toBe(false);
    expect(gate.blocking).toHaveLength(1);
    expect(gate.reason).toContain('checkpoint.capture=running');
  });

  it('settled (succeeded/failed/cancelled) blocking effects do not block', () => {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      const effects = [{ type: 'handoff.deliver', status, threadId: 't1' }];
      expect(canMarkTurnSettled(effects, 't1').settled).toBe(true);
    }
  });

  it('non-blocking types never hold the turn', () => {
    const effects = [
      { type: 'thread-title.generate', status: 'running', threadId: 't1' },
      { type: 'runtime.continue', status: 'pending', threadId: 't1' },
    ];
    expect(canMarkTurnSettled(effects, 't1').settled).toBe(true);
  });

  it('filters by threadId — another thread pending does not hold this turn', () => {
    const effects = [
      { type: 'checkpoint.capture', status: 'pending', threadId: 'other' },
      { type: 'handoff.deliver', status: 'succeeded', threadId: 't1' },
    ];
    expect(canMarkTurnSettled(effects, 't1').settled).toBe(true);
    expect(canMarkTurnSettled(effects, 'other').settled).toBe(false);
  });

  it('without threadId any blocking effect counts', () => {
    const effects = [
      { type: 'checkpoint.capture', status: 'pending', threadId: 'other' },
    ];
    expect(canMarkTurnSettled(effects).settled).toBe(false);
  });

  it('unsettledBlockingEffectIds lists open blocking rows of the thread (T3 cancelUnsettled)', () => {
    const effects = [
      { id: 'e1', type: 'checkpoint.capture', status: 'running', threadId: 't1' },
      { id: 'e2', type: 'handoff.deliver', status: 'pending', threadId: 't1' },
      { id: 'e3', type: 'checkpoint.capture', status: 'succeeded', threadId: 't1' },
      { id: 'e4', type: 'checkpoint.capture', status: 'pending', threadId: 'other' },
    ];
    expect(unsettledBlockingEffectIds(effects, 't1')).toEqual(['e1', 'e2']);
  });

  it('automaticCompletionEffectsSettled mirrors the gate', () => {
    expect(
      automaticCompletionEffectsSettled([
        { type: 'checkpoint.capture', status: 'pending', threadId: 't1' },
      ], 't1'),
    ).toBe(false);
    expect(
      automaticCompletionEffectsSettled([
        { type: 'checkpoint.capture', status: 'succeeded', threadId: 't1' },
      ], 't1'),
    ).toBe(true);
  });
});

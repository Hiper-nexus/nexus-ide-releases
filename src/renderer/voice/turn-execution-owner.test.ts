import { describe, expect, it } from 'vitest';
import { TurnExecutionOwner, type TurnExecutionPath } from './turn-execution-owner';

describe('TurnExecutionOwner', () => {
  it('lets the first claimant win and the second no-op (classic then tool)', () => {
    const owner = new TurnExecutionOwner();
    const token = owner.beginTurn();
    expect(owner.claim('classic-brain', token)).toBe(true);
    expect(owner.claim('realtime-tool', token)).toBe(false);
    expect(owner.owner).toBe('classic-brain');
  });

  it('lets the realtime tool win when it claims first', () => {
    const owner = new TurnExecutionOwner();
    const token = owner.beginTurn();
    expect(owner.claim('realtime-tool', token)).toBe(true);
    expect(owner.claim('classic-brain', token)).toBe(false);
    expect(owner.owner).toBe('realtime-tool');
  });

  it('rejects a stale claim carrying a previous turn token', () => {
    const owner = new TurnExecutionOwner();
    const stale = owner.beginTurn();
    // A new turn opens; the tool-call from the old turn arrives late.
    owner.beginTurn();
    expect(owner.claim('realtime-tool', stale)).toBe(false);
    expect(owner.owner).toBeNull();
  });

  // DRIVING test for NEW-A: reproduce the exact race ordering — the realtime
  // toolCall IPC handler runs AFTER finishAndProcess passed its transcript check,
  // so BOTH paths reach their claim within the same turn but in nondeterministic
  // order. Prove exactly ONE execution regardless of which microtask runs first.
  it('single execution under both IPC interleavings of the same turn', async () => {
    for (const toolFirst of [false, true]) {
      const owner = new TurnExecutionOwner();
      const token = owner.beginTurn();
      const executed: TurnExecutionPath[] = [];

      // Classic path: transcript resolved, hasRealtimeNativeToolSince() was false
      // (toolCall had not landed yet), now about to run the brain.
      const classicPath = async (): Promise<void> => {
        await Promise.resolve();
        if (owner.claim('classic-brain', token)) executed.push('classic-brain');
      };
      // Realtime tool path: the fire-and-forget onLiveToolCall handler for THIS
      // turn, arriving after the transcript-check point.
      const toolPath = async (): Promise<void> => {
        await Promise.resolve();
        if (owner.claim('realtime-tool', token)) executed.push('realtime-tool');
      };

      await Promise.all(
        toolFirst ? [toolPath(), classicPath()] : [classicPath(), toolPath()],
      );

      expect(executed).toHaveLength(1);
    }
  });

  // DRIVING test for ITEM 2 (one responder per turn — the SPOKEN reply, not just
  // actions): reproduce "two voices answered one utterance". The live provider
  // claims the audio reply while, in the other IPC interleaving, the Classic
  // brain tries to speak the same turn. Exactly one voice must own it either way.
  it('single SPOKEN responder: realtime-audio and classic-brain never both answer', async () => {
    for (const realtimeFirst of [false, true]) {
      const owner = new TurnExecutionOwner();
      const token = owner.beginTurn();
      const spoke: TurnExecutionPath[] = [];

      const realtimeVoice = async (): Promise<void> => {
        await Promise.resolve();
        if (owner.claim('realtime-audio', token)) spoke.push('realtime-audio');
      };
      const classicVoice = async (): Promise<void> => {
        await Promise.resolve();
        if (owner.claim('classic-brain', token)) spoke.push('classic-brain');
      };

      await Promise.all(
        realtimeFirst ? [realtimeVoice(), classicVoice()] : [classicVoice(), realtimeVoice()],
      );

      expect(spoke).toHaveLength(1);
    }
  });
});

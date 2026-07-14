// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createEmptyPromptQueue,
  nextDeliverablePrompt,
  promptQueueSnapshot,
  prunePromptQueueHistory,
  reducePromptQueue,
} from './mission-prompt-queue';

describe('MissionPromptQueue', () => {
  it('enqueues with monotonic seq', () => {
    let q = createEmptyPromptQueue('m1');
    const a = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'user_goal',
      body: 'fix login',
      intentVersion: 1,
      source: 'typed',
      now: 10,
    });
    q = a.state;
    const b = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'preflight',
      body: 'warm map',
      intentVersion: 1,
      source: 'system',
      now: 11,
    });
    expect(b.state.items).toHaveLength(2);
    expect(b.state.items[0]!.seq).toBe(1);
    expect(b.state.items[1]!.seq).toBe(2);
  });

  it('preempts in-flight preflight when intentVersion advances', () => {
    let q = createEmptyPromptQueue('m1');
    q = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'preflight',
      body: 'doctor',
      intentVersion: 1,
      source: 'system',
      id: 'old-preflight',
      now: 1,
    }).state;
    q = reducePromptQueue(q, { type: 'start', id: 'old-preflight' }).state;
    expect(q.executingId).toBe('old-preflight');

    const next = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'user_goal',
      body: 'new goal instead',
      intentVersion: 2,
      source: 'typed',
      id: 'new-goal',
      now: 2,
    });

    expect(next.cancelledIds).toContain('old-preflight');
    const old = next.state.items.find((i) => i.id === 'old-preflight');
    expect(old?.status).toBe('cancelled');
    expect(next.state.executingId).toBeNull();
    expect(next.state.currentIntentVersion).toBe(2);

    const snap = promptQueueSnapshot(next.state);
    expect(snap.cancelled.map((i) => i.id)).toContain('old-preflight');
    expect(snap.queued.map((i) => i.id)).toContain('new-goal');
  });

  it('does not deliver cancelled work as next', () => {
    let q = createEmptyPromptQueue('m1');
    q = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'bootstrap',
      body: 'x',
      intentVersion: 1,
      source: 'system',
      id: 'boot',
    }).state;
    q = reducePromptQueue(q, {
      type: 'bump_intent',
      intentVersion: 2,
    }).state;
    expect(nextDeliverablePrompt(q)).toBeNull();
  });

  it('voice path uses same preemption primitives', () => {
    let q = createEmptyPromptQueue('m-voice');
    q = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'bootstrap',
      body: 'prepare',
      intentVersion: 1,
      source: 'system',
      id: 'boot',
    }).state;
    q = reducePromptQueue(q, { type: 'start', id: 'boot' }).state;

    const voice = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'voice_goal',
      body: 'abra navalhago e corrija o form',
      intentVersion: 2,
      source: 'voice',
      id: 'voice-1',
    });

    expect(voice.cancelledIds).toContain('boot');
    expect(
      voice.state.items.find((i) => i.id === 'voice-1')?.source,
    ).toBe('voice');
  });

  it('complete marks delivered and frees executing slot', () => {
    let q = createEmptyPromptQueue('m1');
    q = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'user_message',
      body: 'go',
      intentVersion: 1,
      source: 'typed',
      id: 'msg',
    }).state;
    q = reducePromptQueue(q, { type: 'start', id: 'msg' }).state;
    q = reducePromptQueue(q, { type: 'complete', id: 'msg', ok: true }).state;
    expect(q.executingId).toBeNull();
    expect(q.items[0]!.status).toBe('delivered');
  });

  it('cancels work that arrives after a newer intent was already observed', () => {
    let q = createEmptyPromptQueue('m-stale');
    q = reducePromptQueue(q, { type: 'bump_intent', intentVersion: 3 }).state;
    const stale = reducePromptQueue(q, {
      type: 'enqueue',
      kind: 'bootstrap',
      body: 'late bootstrap',
      intentVersion: 2,
      source: 'system',
      id: 'late-boot',
    });
    expect(stale.cancelledIds).toContain('late-boot');
    expect(stale.state.items.at(-1)?.status).toBe('cancelled');
    expect(nextDeliverablePrompt(stale.state)).toBeNull();
  });

  it('does not overwrite an active execution slot', () => {
    let q = createEmptyPromptQueue('m-serial');
    for (const id of ['one', 'two']) {
      q = reducePromptQueue(q, {
        type: 'enqueue', kind: 'user_message', body: id,
        intentVersion: 1, source: 'typed', id,
      }).state;
    }
    q = reducePromptQueue(q, { type: 'start', id: 'one' }).state;
    q = reducePromptQueue(q, { type: 'start', id: 'two' }).state;
    expect(q.executingId).toBe('one');
    expect(q.items.find((item) => item.id === 'two')?.status).toBe('queued');
  });

  it('only completes the item that is currently executing', () => {
    let q = createEmptyPromptQueue('m-complete');
    q = reducePromptQueue(q, {
      type: 'enqueue', kind: 'user_message', body: 'queued',
      intentVersion: 1, source: 'typed', id: 'queued',
    }).state;
    q = reducePromptQueue(q, { type: 'complete', id: 'queued', ok: true }).state;
    expect(q.items[0]?.status).toBe('queued');
  });

  it('treats an identical duplicate id as an idempotent enqueue', () => {
    let q = createEmptyPromptQueue('m-duplicate');
    const event = {
      type: 'enqueue' as const, kind: 'system' as const, body: 'same work',
      intentVersion: 1, source: 'system' as const, id: 'stable-id', now: 10,
    };
    q = reducePromptQueue(q, event).state;
    const duplicate = reducePromptQueue(q, event);
    expect(duplicate.state).toBe(q);
    expect(duplicate.state.items).toHaveLength(1);
    expect(duplicate.state.nextSeq).toBe(2);
  });

  it('rejects a conflicting duplicate id', () => {
    let q = createEmptyPromptQueue('m-conflict');
    q = reducePromptQueue(q, {
      type: 'enqueue', kind: 'system', body: 'first',
      intentVersion: 1, source: 'system', id: 'same-id',
    }).state;
    expect(() => reducePromptQueue(q, {
      type: 'enqueue', kind: 'system', body: 'different',
      intentVersion: 1, source: 'system', id: 'same-id',
    })).toThrow(/duplicate prompt id/i);
  });

  it('bounds terminal history without dropping active prompts', () => {
    let q = createEmptyPromptQueue('m-history');
    for (let i = 0; i < 5; i += 1) {
      const id = `done-${i}`;
      q = reducePromptQueue(q, {
        type: 'enqueue', kind: 'system', body: id,
        intentVersion: 1, source: 'system', id,
      }).state;
      q = reducePromptQueue(q, { type: 'start', id }).state;
      q = reducePromptQueue(q, { type: 'complete', id, ok: true }).state;
    }
    q = reducePromptQueue(q, {
      type: 'enqueue', kind: 'user_message', body: 'still queued',
      intentVersion: 1, source: 'typed', id: 'active',
    }).state;

    const pruned = prunePromptQueueHistory(q, 2);
    expect(pruned.items.map((item) => item.id)).toEqual([
      'done-3', 'done-4', 'active',
    ]);
    expect(pruned.nextSeq).toBe(q.nextSeq);
  });
});

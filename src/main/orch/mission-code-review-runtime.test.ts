import { describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionCodeCandidate } from './mission-code-completion';
import { MissionCodeReviewRuntime, type CodeReviewerPorts } from './mission-code-review-runtime';

function fixture() {
  const scope = testProjectScope();
  const input = {
    scope, executionScope: scope, baseSha: 'b'.repeat(40), coverage: 'delta',
    mission: { id: 'mission', intentVersion: 1, status: 'running', orchestratorSessionId: 'author' },
    candidate: { source: 'git', headSha: 'a'.repeat(40), fingerprint: 'f'.repeat(64), changedPaths: ['src/app.ts'],
      untrackedPaths: [], deletedPaths: [], diff: '', complete: true, incompleteReasons: [] },
  } as unknown as MissionCodeCandidate;
  let current = true;
  let now = 1000;
  let snapshot = input.candidate;
  const live = new Set<string>();
  const spawned: string[] = [];
  const closed: string[] = [];
  const ports: CodeReviewerPorts = {
    now: () => now,
    isCurrent: () => current,
    select: async () => ({ adapterId: 'codex', model: 'frontier' }),
    isFrontier: seat => seat.model === 'frontier',
    spawn: async () => {
      const sessionId = `review-${spawned.length + 1}`;
      spawned.push(sessionId); live.add(sessionId);
      return { paneId: sessionId, sessionId };
    },
    isLive: id => live.has(id),
    capture: async () => snapshot,
    close: async (_scope, _missionId, pane) => { closed.push(pane.sessionId); live.delete(pane.sessionId); return true; },
  };
  const runtime = new MissionCodeReviewRuntime(ports);
  const submit = (sessionId = spawned[0], overrides = {}) => runtime.record({
    scope, missionId: input.mission.id, sessionId, adapterId: 'codex', model: 'frontier', readOnly: true,
    verdict: 'approve', summary: 'Inspected current candidate', findings: [], ...overrides,
  });
  return { input, ports, runtime, spawned, closed, live, submit,
    change: (next: typeof snapshot) => { snapshot = next; },
    revoke: () => { current = false; }, advance: () => { now += 31_000; } };
}

describe('Main candidate reviewer ownership', () => {
  it('F-1301: every recapture of the ticket cuts the same delta (untrackedSince)', async () => {
    const f = fixture();
    const seen: Array<number | undefined> = [];
    const original = f.ports.capture;
    f.ports.capture = async binding => { seen.push(binding.untrackedSince); return original(binding); };
    const input = { ...f.input, untrackedSince: 1_234 };
    await f.runtime.ensure(input);
    expect((await f.submit()).accepted).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(value => value === 1_234)).toBe(true);
    expect(f.runtime.receipt(f.input.scope, f.input.mission.id)?.binding.untrackedSince).toBe(1_234);
    // Outro recorte = outro candidato: o ticket velho é aposentado.
    await f.runtime.ensure({ ...f.input, untrackedSince: 9_999 });
    expect(f.closed).toEqual(['review-1']);
  });

  it('coalesces concurrent completion attempts into one independent reviewer', async () => {
    const f = fixture();
    const results = await Promise.all([f.runtime.ensure(f.input), f.runtime.ensure(f.input), f.runtime.ensure(f.input)]);
    expect(f.spawned).toEqual(['review-1']);
    expect(results.every(result => result.kind === 'waiting')).toBe(true);
    expect((await f.submit()).accepted).toBe(true);
    const review = await f.runtime.ensure(f.input);
    expect(review.kind).toBe('reviewed');
    if (review.kind === 'reviewed') expect(review.candidateFingerprint).toBe(f.input.candidate.fingerprint);
  });

  it('cannot accept another pane, a cheap model, writable authority or another checkout', async () => {
    const f = fixture(); await f.runtime.ensure(f.input);
    expect((await f.submit('author')).accepted).toBe(false);
    expect((await f.submit(undefined, { model: 'cheap' })).accepted).toBe(false);
    expect((await f.submit(undefined, { readOnly: false })).accepted).toBe(false);
    expect((await f.submit(undefined, { scope: { ...f.input.scope, checkoutId: 'other' } })).accepted).toBe(false);
    expect((await f.runtime.ensure(f.input)).kind).toBe('waiting');
  });

  it('does not spawn a cheap substitute when a frontier reviewer is unavailable', async () => {
    const f = fixture(); f.ports.select = async () => ({ adapterId: 'codex', model: 'cheap' });
    expect((await f.runtime.ensure(f.input)).kind).toBe('waiting');
    expect(f.spawned).toHaveLength(0);
  });

  it('discards review after candidate mutation and replaces only its own old pane', async () => {
    const f = fixture(); await f.runtime.ensure(f.input);
    const changed = { ...f.input.candidate, fingerprint: 'e'.repeat(64) };
    f.change(changed);
    expect((await f.submit()).accepted).toBe(false);
    await f.runtime.ensure({ ...f.input, candidate: changed });
    expect(f.closed).toEqual(['review-1']);
    expect(f.spawned).toEqual(['review-1', 'review-2']);
  });

  it('revocation during routing cannot create a new pane', async () => {
    const f = fixture();
    f.ports.select = async () => { f.revoke(); return { adapterId: 'codex', model: 'frontier' }; };
    expect((await f.runtime.ensure(f.input)).kind).toBe('unavailable');
    expect(f.spawned).toHaveLength(0);
  });

  it('retries an exited reviewer without permanently blocking the candidate', async () => {
    const f = fixture(); await f.runtime.ensure(f.input); f.live.clear(); f.advance();
    await f.runtime.ensure(f.input);
    expect(f.spawned).toEqual(['review-1', 'review-2']);
  });

  it('can bind a non-Git current-state review without inventing a commit', async () => {
    const f = fixture();
    const candidate = { ...f.input.candidate, source: 'filesystem' as const, headSha: null };
    f.change(candidate);
    const input = { ...f.input, candidate, baseSha: null, coverage: 'current-state' as const };
    await f.runtime.ensure(input); expect((await f.submit()).accepted).toBe(true);
    const result = await f.runtime.ensure(input);
    if (result.kind !== 'reviewed') throw new Error('expected actual reviewer receipt');
    expect(result.verdict.headSha).toBeNull();
  });

  it('forget closes a live owned reviewer instead of orphaning it', async () => {
    const f = fixture(); await f.runtime.ensure(f.input);
    await f.runtime.forget(f.input.scope, f.input.mission.id);
    expect(f.closed).toEqual(['review-1']);
    expect(f.live.size).toBe(0);
  });

  it('retains a failed close and retries before replacing the old physical reviewer', async () => {
    const f = fixture(); await f.runtime.ensure(f.input);
    const realClose = f.ports.close;
    f.ports.close = vi.fn().mockResolvedValueOnce(false).mockImplementation(realClose);
    const changed = { ...f.input, candidate: { ...f.input.candidate, fingerprint: 'new-candidate' } };
    expect((await f.runtime.ensure(changed)).kind).toBe('waiting');
    expect(f.spawned).toHaveLength(1);
    f.advance(); await f.runtime.ensure(changed);
    expect(f.closed).toContain('review-1');
    expect(f.spawned).toHaveLength(2);
  });

  it('closes a child that materializes after cancellation or forgetting during spawn', async () => {
    const f = fixture(); const spawn = f.ports.spawn;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.ports.spawn = async (...args) => { await blocked; return spawn(...args); };
    const controller = new AbortController();
    const starting = f.runtime.ensure(f.input, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    const forgotten = f.runtime.forget(f.input.scope, f.input.mission.id);
    release(); await starting; await forgotten;
    expect(f.spawned).toHaveLength(1);
    expect(f.closed).toEqual(['review-1']);
    expect(f.live.size).toBe(0);
  });

  it('keeps a rejected receipt after the reviewer exits, exposes it read-only and deduplicates a replay', async () => {
    const f = fixture(); f.ports.persist = vi.fn(async (_binding, result) => result);
    await f.runtime.ensure(f.input);
    const payload = { verdict: 'reject', findings: ['F-42 src/app.ts:7 erro'] };
    await f.submit(undefined, payload); await f.submit(undefined, payload);
    expect(f.ports.persist).toHaveBeenCalledOnce();
    f.live.clear(); f.advance();
    expect((await f.runtime.ensure(f.input)).kind).toBe('reviewed');
    expect(f.spawned).toHaveLength(1);
    const rejected = f.runtime.rejection(f.input.scope, f.input.mission.id);
    expect(rejected?.result.verdict.verdict).toBe('reject');
    expect(Object.isFrozen(rejected)).toBe(true);
    f.revoke(); expect(f.runtime.rejection(f.input.scope, f.input.mission.id)).toBeNull();
  });

  it('a late journal write cannot certify files that changed while it was awaited', async () => {
    const f = fixture(); await f.runtime.ensure(f.input);
    f.ports.persist = async (_binding, result) => { f.change({ ...f.input.candidate, fingerprint: 'changed-during-persist' }); return result; };
    expect((await f.submit()).accepted).toBe(false);
  });

  it('F-1261: o wake que dispara antes do relógio de parede ainda refaz a seleção', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let selections = 0;
      f.ports.select = async () => {
        selections += 1;
        return selections === 1 ? null : { adapterId: 'codex', model: 'frontier' };
      };
      expect((await f.runtime.ensure(f.input)).kind).toBe('waiting');
      // Só os timers andam: ports.now() fica antes do retryAt (disparo adiantado).
      await vi.advanceTimersByTimeAsync(31_000);
      expect(selections).toBeGreaterThanOrEqual(2);
      expect(f.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-1261: wake coalescido no retryAt refaz a seleção sem evento externo', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let selections = 0;
      f.ports.select = async () => {
        selections += 1;
        return selections === 1 ? null : { adapterId: 'codex', model: 'frontier' };
      };
      const result = await f.runtime.ensure(f.input);
      expect(result.kind).toBe('waiting');
      expect(f.spawned).toHaveLength(0);
      expect(selections).toBe(1);
      // Sem eventos: só o timer do retryAt pode reconsultar. O relógio da
      // fixture (ports.now) anda junto com os timers falsos.
      f.advance();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(selections).toBeGreaterThanOrEqual(2);
      expect(f.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createPtyHostBridge,
  escalateDarwinSupervisorTermination,
  PhysicalExitReceipts,
  PreSpawnFailureTombstones,
  type HostControlMsg,
  type PtyKillSignal,
  type PtySpawnSpec,
} from './pty-host-core';

function fakeTransport() {
  const posted: HostControlMsg[] = [];
  let ensured = 0;
  return {
    posted,
    ensured: () => ensured,
    transport: {
      ensure: () => {
        ensured += 1;
      },
      post: (msg: HostControlMsg) => {
        posted.push(msg);
      },
    },
  };
}

const spec: PtySpawnSpec = {
  sessionId: 's1',
  file: '/bin/zsh',
  args: [],
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  env: { PATH: '/usr/bin' },
};

describe('escalateDarwinSupervisorTermination', () => {
  const realDelay = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  it('settles on the canonical receipt after only SIGTERM', async () => {
    const signals: PtyKillSignal[] = [];
    const proof = await escalateDarwinSupervisorTermination({
      termGraceMs: 10_000,
      killGraceMs: 20_000,
      sendSignal: (signal) => signals.push(signal),
      exitObservation: Promise.resolve({ exitCode: 0 }),
      isProvenExit: () => true,
      delay: realDelay,
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(proof).toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
  });

  it('reports rootExited but not descendantsExited on a non-canonical exit', async () => {
    const signals: PtyKillSignal[] = [];
    const proof = await escalateDarwinSupervisorTermination({
      termGraceMs: 10_000,
      killGraceMs: 20_000,
      sendSignal: (signal) => signals.push(signal),
      exitObservation: Promise.resolve({ exitCode: 137, signal: 9 }),
      isProvenExit: () => false,
      delay: realDelay,
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(proof).toMatchObject({
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error: expect.stringMatching(/canônico/i),
    });
  });

  it('escalates to SIGKILL and settles fail-closed when the root never exits', async () => {
    vi.useFakeTimers();
    try {
      const signals: PtyKillSignal[] = [];
      const proof = escalateDarwinSupervisorTermination({
        termGraceMs: 10_000,
        killGraceMs: 20_000,
        sendSignal: (signal) => signals.push(signal),
        // Never resolves: the confirmed v0.25.0 stuck-but-alive child.
        exitObservation: new Promise<never>(() => {}),
        isProvenExit: () => true,
        delay: (ms) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          }),
      });
      const settled = vi.fn();
      void proof.then(settled);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20_000);
      await expect(proof).resolves.toMatchObject({
        ok: false,
        rootExited: false,
        descendantsExited: false,
        error: expect.stringMatching(/SIGKILL|prazo/i),
      });
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a late exit that arrives after SIGKILL, within the kill grace', async () => {
    vi.useFakeTimers();
    try {
      const signals: PtyKillSignal[] = [];
      let resolveExit!: (observation: { exitCode: number }) => void;
      const proof = escalateDarwinSupervisorTermination({
        termGraceMs: 10_000,
        killGraceMs: 20_000,
        sendSignal: (signal) => signals.push(signal),
        exitObservation: new Promise((resolve) => {
          resolveExit = resolve;
        }),
        isProvenExit: () => true,
        delay: (ms) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          }),
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      resolveExit({ exitCode: 0 });
      await expect(proof).resolves.toMatchObject({
        ok: true,
        rootExited: true,
        descendantsExited: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed without escalating when SIGTERM delivery throws', async () => {
    const signals: PtyKillSignal[] = [];
    const proof = await escalateDarwinSupervisorTermination({
      termGraceMs: 10_000,
      killGraceMs: 20_000,
      sendSignal: (signal) => {
        signals.push(signal);
        throw new Error('root pid is gone');
      },
      exitObservation: new Promise<never>(() => {}),
      isProvenExit: () => true,
      delay: realDelay,
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(proof).toMatchObject({
      ok: false,
      rootExited: false,
      descendantsExited: false,
      error: expect.stringMatching(/root pid is gone/),
    });
  });
});

describe('PreSpawnFailureTombstones', () => {
  it('proves only the exact recorded session and consumes the evidence once', () => {
    const tombstones = new PreSpawnFailureTombstones();
    tombstones.record('failed-before-spawn');

    expect(tombstones.consume('unknown')).toBe(false);
    expect(tombstones.consume('failed-before-spawn')).toBe(true);
    expect(tombstones.consume('failed-before-spawn')).toBe(false);
  });

  it('expires evidence at its bounded TTL', () => {
    let now = 1_000;
    const tombstones = new PreSpawnFailureTombstones({
      ttlMs: 50,
      now: () => now,
    });
    tombstones.record('expired');

    now = 1_049;
    expect(tombstones.size()).toBe(1);
    now = 1_050;
    expect(tombstones.consume('expired')).toBe(false);
    expect(tombstones.size()).toBe(0);
  });

  it('evicts the oldest evidence when the hard bound is reached', () => {
    const tombstones = new PreSpawnFailureTombstones({ maxEntries: 2 });
    tombstones.record('oldest');
    tombstones.record('middle');
    tombstones.record('newest');

    expect(tombstones.size()).toBe(2);
    expect(tombstones.consume('oldest')).toBe(false);
    expect(tombstones.consume('middle')).toBe(true);
    expect(tombstones.consume('newest')).toBe(true);
  });

  it('forgets stale evidence when the same session id starts a new attempt', () => {
    const tombstones = new PreSpawnFailureTombstones();
    tombstones.record('retry');
    tombstones.forget('retry');

    expect(tombstones.consume('retry')).toBe(false);
  });
});

describe('PhysicalExitReceipts', () => {
  it('returns the same exact process-tree proof after natural exit and on retry', () => {
    const receipts = new PhysicalExitReceipts();
    receipts.record('natural-exit', {
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });

    expect(receipts.read('unknown')).toBeNull();
    expect(receipts.read('natural-exit')).toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(receipts.read('natural-exit')).toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
  });

  it('never upgrades incomplete evidence and forgets a reused session id', () => {
    const receipts = new PhysicalExitReceipts();
    receipts.record('incomplete', {
      ok: false,
      rootExited: true,
      descendantsExited: false,
    });
    expect(receipts.read('incomplete')).toBeNull();

    receipts.record('reused', {
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    receipts.forget('reused');
    expect(receipts.read('reused')).toBeNull();
  });

  it('bounds and expires stable receipts', () => {
    let now = 2_000;
    const receipts = new PhysicalExitReceipts({
      ttlMs: 50,
      maxEntries: 2,
      now: () => now,
    });
    const proof = {
      ok: true,
      rootExited: true,
      descendantsExited: true,
    } as const;
    receipts.record('oldest', proof);
    receipts.record('middle', proof);
    receipts.record('newest', proof);
    expect(receipts.read('oldest')).toBeNull();
    expect(receipts.size()).toBe(2);

    now = 2_050;
    expect(receipts.read('middle')).toBeNull();
    expect(receipts.read('newest')).toBeNull();
  });
});

describe('createPtyHostBridge', () => {
  it('forks (ensure) then posts the spawn spec to the host', () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    bridge.host.spawn(spec, { onData: () => {}, onExit: () => {} });
    expect(t.ensured()).toBe(1);
    expect(t.posted).toEqual([{ type: 'spawn', ...spec }]);
    expect(bridge.sessionCount()).toBe(1);
  });

  it('proxy handle posts write/resize/kill for its own session', () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const proc = bridge.host.spawn(spec, { onData: () => {}, onExit: () => {} });
    t.posted.length = 0;
    proc.write('ls\n');
    proc.resize(120, 40);
    proc.kill('SIGTERM');
    expect(t.posted).toEqual([
      { type: 'write', sessionId: 's1', data: 'ls\n' },
      { type: 'resize', sessionId: 's1', cols: 120, rows: 40 },
      { type: 'kill', sessionId: 's1', signal: 'SIGTERM' },
    ]);
  });

  it('resolves a physical termination only from the exact host proof', async () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const proc = bridge.host.spawn(spec, { onData: () => {}, onExit: () => {} });
    t.posted.length = 0;

    const proof = proc.terminate({
      termTimeoutMs: 100,
      killTimeoutMs: 200,
    });
    const request = t.posted[0];
    expect(request).toMatchObject({
      type: 'terminate',
      sessionId: 's1',
      termTimeoutMs: 100,
      killTimeoutMs: 200,
    });
    if (!request || request.type !== 'terminate') {
      throw new Error('terminate request missing');
    }
    bridge.dispatchEvent({
      type: 'termination-result',
      sessionId: 's1',
      requestId: request.requestId,
      proof: {
        ok: true,
        rootExited: true,
        descendantsExited: true,
      },
    });

    await expect(proof).resolves.toMatchObject({ ok: true });
  });

  it('fails pending physical proof closed when the PTY host restarts', async () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const proc = bridge.host.spawn(spec, { onData: () => {}, onExit: () => {} });
    const proof = proc.terminate({
      termTimeoutMs: 100,
      killTimeoutMs: 200,
    });

    bridge.handleHostDown();

    await expect(proof).resolves.toMatchObject({
      ok: false,
      descendantsExited: false,
      error: expect.stringMatching(/host/i),
    });
  });

  it('times out a silent host and ignores its late physical-proof reply', async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransport();
      const bridge = createPtyHostBridge(t.transport);
      const proc = bridge.host.spawn(spec, {
        onData: () => {},
        onExit: () => {},
      });
      const resolved = vi.fn();
      const proof = proc.terminate({
        termTimeoutMs: 100,
        killTimeoutMs: 200,
      });
      void proof.then(resolved);
      const request = t.posted.at(-1);
      if (!request || request.type !== 'terminate') {
        throw new Error('terminate request missing');
      }

      await vi.advanceTimersByTimeAsync(4_800);
      await expect(proof).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/não respondeu|janela/i),
      });
      expect(resolved).toHaveBeenCalledOnce();

      bridge.dispatchEvent({
        type: 'termination-result',
        sessionId: 's1',
        requestId: request.requestId,
        proof: {
          ok: true,
          rootExited: true,
          descendantsExited: true,
        },
      });
      await Promise.resolve();
      expect(resolved).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the exact host receipt win before the bounded transport deadline', async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransport();
      const bridge = createPtyHostBridge(t.transport);
      const proc = bridge.host.spawn(spec, {
        onData: () => {},
        onExit: () => {},
      });
      const resolved = vi.fn();
      // Transport deadline = term + kill + scan(4000) + margin(500) = 4800ms.
      const proof = proc.terminate({
        termTimeoutMs: 100,
        killTimeoutMs: 200,
      });
      void proof.then(resolved);
      const request = t.posted.at(-1);
      if (!request || request.type !== 'terminate') {
        throw new Error('terminate request missing');
      }

      // The host's own SIGTERM→SIGKILL escalation resolves within
      // term+kill (300ms), comfortably inside the transport deadline, so the
      // exact receipt still owns settlement — elapsed time is not proof.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(resolved).not.toHaveBeenCalled();

      bridge.dispatchEvent({
        type: 'exit',
        sessionId: 's1',
        exitCode: 0,
      });
      bridge.dispatchEvent({
        type: 'termination-result',
        sessionId: 's1',
        requestId: request.requestId,
        proof: {
          ok: true,
          rootExited: true,
          descendantsExited: true,
        },
      });
      await expect(proof).resolves.toMatchObject({ ok: true });
      expect(resolved).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the transport wait so a wedged host can never hang app quit', async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransport();
      const bridge = createPtyHostBridge(t.transport);
      const proc = bridge.host.spawn(spec, {
        onData: () => {},
        onExit: () => {},
      });
      const resolved = vi.fn();
      // The host process itself is wedged: it never posts a termination-result.
      const proof = proc.terminate({
        termTimeoutMs: 100,
        killTimeoutMs: 200,
      });
      void proof.then(resolved);

      await vi.advanceTimersByTimeAsync(4_700);
      expect(resolved).not.toHaveBeenCalled();

      // Past the deadline (4800ms) the wait settles fail-closed instead of
      // hanging forever, as it did on Darwin before v0.25.0.
      await vi.advanceTimersByTimeAsync(200);
      await expect(proof).resolves.toMatchObject({
        ok: false,
        rootExited: false,
        descendantsExited: false,
        error: expect.stringMatching(/não respondeu|janela/i),
      });
      expect(resolved).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails pending Darwin terminations closed when the host process is lost', async () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const proc = bridge.host.spawn(spec, {
      onData: () => {},
      onExit: () => {},
    });
    const hostLoss = proc.terminate({
      termTimeoutMs: 100,
      killTimeoutMs: 200,
    });
    bridge.handleHostDown();
    await expect(hostLoss).resolves.toMatchObject({
      ok: false,
      rootExited: false,
      descendantsExited: false,
      error: expect.stringMatching(/host/i),
    });
  });

  it('routes data events to the owning session only', () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const onData = vi.fn();
    bridge.host.spawn(spec, { onData, onExit: () => {} });
    bridge.dispatchEvent({ type: 'data', sessionId: 's1', data: 'hello' });
    bridge.dispatchEvent({ type: 'data', sessionId: 'other', data: 'nope' });
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('hello');
  });

  it('fires exit once and then drops the session (later events are no-ops)', () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const onData = vi.fn();
    const onExit = vi.fn();
    bridge.host.spawn(spec, { onData, onExit });
    bridge.dispatchEvent({ type: 'exit', sessionId: 's1', exitCode: 0, signal: 15 });
    // A duplicate exit (our own kill echoing back) and any late data must be ignored.
    bridge.dispatchEvent({ type: 'exit', sessionId: 's1', exitCode: 0 });
    bridge.dispatchEvent({ type: 'data', sessionId: 's1', data: 'late' });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0, 15);
    expect(onData).not.toHaveBeenCalled();
    expect(bridge.sessionCount()).toBe(0);
  });

  it('host-down finalizes every live session exactly once with exitCode -1', () => {
    const t = fakeTransport();
    const bridge = createPtyHostBridge(t.transport);
    const a = vi.fn();
    const b = vi.fn();
    bridge.host.spawn(spec, { onData: () => {}, onExit: a });
    bridge.host.spawn({ ...spec, sessionId: 's2' }, { onData: () => {}, onExit: b });
    expect(bridge.sessionCount()).toBe(2);

    bridge.handleHostDown();

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(-1, undefined);
    expect(b).toHaveBeenCalledTimes(1);
    expect(bridge.sessionCount()).toBe(0);

    // After the host is gone, a stray event for a finalized session is a no-op.
    bridge.dispatchEvent({ type: 'exit', sessionId: 's1', exitCode: 0 });
    expect(a).toHaveBeenCalledTimes(1);
  });

  describe('probeLiveness (reconciliador de mortalidade)', () => {
    it('resolve com o conjunto exato que o host reportou vivo', async () => {
      const t = fakeTransport();
      const bridge = createPtyHostBridge(t.transport);
      const pending = bridge.host.probeLiveness!(['s1', 's2', 's3']);
      const request = t.posted[0];
      expect(request).toMatchObject({
        type: 'liveness-probe',
        sessionIds: ['s1', 's2', 's3'],
      });
      const requestId = (request as { requestId: string }).requestId;
      bridge.dispatchEvent({
        type: 'liveness-report',
        requestId,
        live: ['s2'],
      });
      await expect(pending).resolves.toEqual(new Set(['s2']));
    });

    it('host mudo estoura a janela e resolve null (unverifiable)', async () => {
      vi.useFakeTimers();
      try {
        const t = fakeTransport();
        const bridge = createPtyHostBridge(t.transport);
        const pending = bridge.host.probeLiveness!(['s1']);
        vi.advanceTimersByTime(3_100);
        await expect(pending).resolves.toBeNull();
        // Report atrasado depois do timeout é no-op, não explode.
        const requestId = (t.posted[0] as { requestId: string }).requestId;
        bridge.dispatchEvent({
          type: 'liveness-report',
          requestId,
          live: ['s1'],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('host down resolve probes pendentes com null, nunca com morte', async () => {
      const t = fakeTransport();
      const bridge = createPtyHostBridge(t.transport);
      const pending = bridge.host.probeLiveness!(['s1']);
      bridge.handleHostDown();
      await expect(pending).resolves.toBeNull();
    });

    it('transporte quebrado resolve null em vez de rejeitar', async () => {
      const bridge = createPtyHostBridge({
        ensure: () => {},
        post: () => {
          throw new Error('transport down');
        },
      });
      await expect(bridge.host.probeLiveness!(['s1'])).resolves.toBeNull();
    });
  });
});

it('command process ownership replies are session-bound and host loss is unknown, never gone', async () => {
 const transport = fakeTransport(); const bridge = createPtyHostBridge(transport.transport);
 const claim = bridge.host.claimCommandProcess!('s1', 123);
 const request = transport.posted.at(-1)!;
 if (request.type !== 'command-process') throw new Error('missing command request');
 bridge.dispatchEvent({ type: 'command-process-result', requestId: request.requestId, sessionId: 'foreign', claimId: 'forged', state: null });
 bridge.dispatchEvent({ type: 'command-process-result', requestId: request.requestId, sessionId: 's1', claimId: 'owned', state: null });
 expect(await claim).toBe('owned');
 const proof = bridge.host.probeCommandProcess!('s1', 'owned'); bridge.handleHostDown(); expect(await proof).toBe('unknown');
});

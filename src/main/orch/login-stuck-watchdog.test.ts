import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLoginStuckEvent } from '../../shared/types';

const harness = vi.hoisted(() => ({
  stateTap: null as ((sessionId: string, state: string) => void) | null,
  exitTap: null as ((sessionId: string) => void) | null,
  agentInfo: vi.fn(
    (_sessionId: string): { paneId?: string; adapterId: string } | null => null,
  ),
  tail: vi.fn((_sessionId: string, _lines?: number) => ''),
  semantic: vi.fn((_paneId: string): { status: string } | null => null),
  adapter: vi.fn(
    (_id: string): { kind: string; auth: { method: string } } | null => null,
  ),
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionState: (cb: (sessionId: string, state: string) => void) => {
    harness.stateTap = cb;
    return () => {
      harness.stateTap = null;
    };
  },
  tapSessionExit: (cb: (sessionId: string) => void) => {
    harness.exitTap = cb;
    return () => {
      harness.exitTap = null;
    };
  },
  getAgentSessionInfo: (sessionId: string) => harness.agentInfo(sessionId),
}));

vi.mock('./pane-registry', () => ({
  readSessionOutput: (sessionId: string, lines?: number) =>
    harness.tail(sessionId, lines),
}));

vi.mock('./agent-status', () => ({
  getAgentSemanticStatus: (paneId: string) => harness.semantic(paneId),
}));

vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (id: string) => harness.adapter(id),
}));

import {
  LOGIN_STUCK_MAX_SESSIONS,
  createLoginStuckWatchdog,
  getLoginStuckPaneState,
  installLoginStuckWatchdog,
  onPaneLoginStuck,
  type LoginStuckWatchdogDeps,
} from './login-stuck-watchdog';

// ---------------------------------------------------------------------------
// Factory core (injected clock / tails) — no timers involved.
// ---------------------------------------------------------------------------

interface FactoryRig {
  events: PaneLoginStuckEvent[];
  tails: Map<string, string>;
  statuses: Map<string, string>;
  setNow(now: number): void;
}

function makeFactoryRig(overrides: Partial<LoginStuckWatchdogDeps> = {}) {
  let now = 0;
  const rig: FactoryRig = {
    events: [],
    tails: new Map(),
    statuses: new Map(),
    setNow(value: number) {
      now = value;
    },
  };
  const watchdog = createLoginStuckWatchdog({
    now: () => now,
    readTail: (sessionId) => rig.tails.get(sessionId) ?? '',
    getSemanticStatus: (paneId) => {
      const status = rig.statuses.get(paneId);
      return status ? { status } : null;
    },
    canOpenLogin: (adapterId) => adapterId === 'claude',
    emit: (event) => {
      rig.events.push(event);
    },
    log: () => {},
    ...overrides,
  });
  return { watchdog, rig };
}

describe('createLoginStuckWatchdog', () => {

  it('declares login-stuck after 2 quiet 15s windows with the pattern persisting', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'claude');
    rig.tails.set('s1', 'Claude Code\n\nSelect login method:\n> 1. Claude account');

    // ~40s of identical login screen.
    for (let t = 5_000; t <= 40_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }

    const stuck = rig.events.filter((e) => e.stuck);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({
      paneId: 'p1',
      sessionId: 's1',
      adapterId: 'claude',
      pattern: 'claude login menu',
      canOpenLogin: true,
    });
    expect(watchdog.paneState('p1')?.stuck).toBe(true);
  });

  it('stays silent when no pattern is present', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'claude');
    rig.tails.set('s1', 'working on the task…\nediting src/index.ts');
    for (let t = 5_000; t <= 60_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events).toHaveLength(0);
    expect(watchdog.paneState('p1')).toBeNull();
  });

  it('emits recovery when the login screen leaves the tail', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'grok');
    rig.tails.set('s1', 'Signing in…');
    for (let t = 5_000; t <= 40_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events.filter((e) => e.stuck)).toHaveLength(1);

    rig.tails.set('s1', 'Signed in as user@x.ai\n> ');
    rig.setNow(45_000);
    watchdog.tick();

    const recovered = rig.events.filter((e) => !e.stuck);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].paneId).toBe('p1');
    expect(watchdog.paneState('p1')).toBeNull();
  });

  it('clears stuck on the wave-1 working hook even while the pattern persists', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'claude');
    rig.tails.set('s1', 'Select login method:');
    for (let t = 5_000; t <= 40_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events.filter((e) => e.stuck)).toHaveLength(1);

    rig.statuses.set('p1', 'working');
    rig.setNow(45_000);
    watchdog.tick();

    expect(rig.events.filter((e) => !e.stuck)).toHaveLength(1);
    expect(watchdog.paneState('p1')).toBeNull();
  });

  it('new significant output re-arms the quiet windows (never declares stuck)', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'claude');
    // The screen keeps changing (real progress through login steps) — words,
    // not just a counter (counters are spinner-class noise, see quietKeyOf).
    const words = ['fetching', 'oauth', 'token', 'browser', 'callback', 'verify'];
    let t = 0;
    for (let step = 0; step < 12; step += 1) {
      rig.tails.set('s1', `Select login method:\n${words[step % words.length]} now`);
      t += 5_000;
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events).toHaveLength(0);
  });

  it('a repainting braille spinner/counter is NOT significant output', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'grok');
    let t = 0;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⡿', '⣿'];
    for (let step = 0; step < 12; step += 1) {
      // Only the spinner glyph and the counter change between frames.
      rig.tails.set('s1', `${frames[step % frames.length]} Signing in… (${step}s)`);
      t += 5_000;
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events.filter((e) => e.stuck)).toHaveLength(1);
    expect(rig.events[0].pattern).toBe('grok signing-in spinner');
  });

  it('never emits twice for the same stuck episode', () => {
    const { watchdog, rig } = makeFactoryRig();
    watchdog.trackSession('s1', 'p1', 'agy');
    rig.tails.set('s1', 'Sign in with Google');
    for (let t = 5_000; t <= 120_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events.filter((e) => e.stuck)).toHaveLength(1);
  });

  it('enforces the watched-session cap', () => {
    const { watchdog, rig } = makeFactoryRig();
    for (let i = 0; i < LOGIN_STUCK_MAX_SESSIONS; i += 1) {
      expect(watchdog.trackSession(`s${i}`, `p${i}`, 'claude')).toBe(true);
    }
    expect(watchdog.trackSession('overflow', 'p-overflow', 'claude')).toBe(false);
    expect(watchdog.watchedCount()).toBe(LOGIN_STUCK_MAX_SESSIONS);

    rig.tails.set('overflow', 'Select login method:');
    for (let t = 5_000; t <= 60_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events).toHaveLength(0);
  });

  it('trackSession is idempotent and dropSession stops watching', () => {
    const { watchdog, rig } = makeFactoryRig();
    expect(watchdog.trackSession('s1', 'p1', 'claude')).toBe(true);
    expect(watchdog.trackSession('s1', 'p1', 'claude')).toBe(true);
    expect(watchdog.watchedCount()).toBe(1);

    watchdog.dropSession('s1');
    expect(watchdog.watchedCount()).toBe(0);
    rig.tails.set('s1', 'Select login method:');
    for (let t = 5_000; t <= 60_000; t += 5_000) {
      rig.setNow(t);
      watchdog.tick();
    }
    expect(rig.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Production wiring: pty taps + interval + renderer/main broadcast.
// ---------------------------------------------------------------------------

describe('installLoginStuckWatchdog (wiring)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.agentInfo.mockReset().mockReturnValue(null);
    harness.tail.mockReset().mockReturnValue('');
    harness.semantic.mockReset().mockReturnValue(null);
    harness.adapter.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores dumb shell/terminal sessions (no agent info)', () => {
    const events: PaneLoginStuckEvent[] = [];
    const off = onPaneLoginStuck((e) => events.push(e));
    const dispose = installLoginStuckWatchdog();
    try {
      harness.agentInfo.mockReturnValue(null); // shell pane
      harness.stateTap?.('shell-1', 'busy');
      harness.tail.mockReturnValue('Select login method:');
      vi.advanceTimersByTime(120_000);
      expect(events).toHaveLength(0);
      expect(getLoginStuckPaneState('shell-1')).toBeNull();
    } finally {
      dispose();
      off();
    }
  });

  it('tracks busy agent sessions and surfaces the stuck state', () => {
    const events: PaneLoginStuckEvent[] = [];
    const off = onPaneLoginStuck((e) => events.push(e));
    const dispose = installLoginStuckWatchdog();
    try {
      harness.agentInfo.mockReturnValue({ paneId: 'p1', adapterId: 'claude' });
      harness.adapter.mockReturnValue({ kind: 'cli-pty', auth: { method: 'oauth' } });
      harness.stateTap?.('s1', 'busy');
      harness.tail.mockReturnValue('Select login method:');

      vi.advanceTimersByTime(60_000);

      expect(events.filter((e) => e.stuck)).toHaveLength(1);
      expect(events[0]).toMatchObject({
        paneId: 'p1',
        sessionId: 's1',
        adapterId: 'claude',
        canOpenLogin: true,
      });
      expect(getLoginStuckPaneState('p1')?.stuck).toBe(true);
    } finally {
      dispose();
      off();
    }
  });

  it('stops watching a session after exit (no late events)', () => {
    const events: PaneLoginStuckEvent[] = [];
    const off = onPaneLoginStuck((e) => events.push(e));
    const dispose = installLoginStuckWatchdog();
    try {
      harness.agentInfo.mockReturnValue({ paneId: 'p1', adapterId: 'claude' });
      harness.stateTap?.('s1', 'busy');
      harness.exitTap?.('s1');
      harness.tail.mockReturnValue('Select login method:');
      vi.advanceTimersByTime(120_000);
      expect(events).toHaveLength(0);
    } finally {
      dispose();
      off();
    }
  });

  it('second install is a no-op (idempotent)', () => {
    const disposeA = installLoginStuckWatchdog();
    const disposeB = installLoginStuckWatchdog();
    disposeB();
    expect(harness.stateTap).not.toBeNull();
    disposeA();
  });
});

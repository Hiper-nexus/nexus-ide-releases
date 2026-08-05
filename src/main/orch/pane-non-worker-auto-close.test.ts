import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StatusTap = (entry: {
  status: string;
  sessionId: string;
  paneId: string;
}) => void;
type ExitTap = (sessionId: string) => void;

const statusTaps = new Set<StatusTap>();
const exitTaps = new Set<ExitTap>();

vi.mock('./agent-status', () => ({
  tapAgentSemanticStatus: (cb: StatusTap) => {
    statusTaps.add(cb);
    return () => statusTaps.delete(cb);
  },
  isSessionInjectableIdle: () => true,
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionExit: (cb: ExitTap) => {
    exitTaps.add(cb);
    return () => exitTaps.delete(cb);
  },
}));

import {
  initNonWorkerAutoClose,
  shutdownNonWorkerAutoClose,
  NON_WORKER_AUTO_CLOSE_TTL_MS,
  type NonWorkerAutoCloseDeps,
  type NonWorkerPaneRef,
} from './pane-non-worker-auto-close';

function refFor(
  sessionId: string,
  overrides: Partial<NonWorkerPaneRef> = {},
): NonWorkerPaneRef {
  return {
    paneId: `pane-${sessionId}`,
    sessionId,
    role: undefined,
    ...overrides,
  };
}

function emitStatus(
  sessionId: string,
  status: string,
  paneId = `pane-${sessionId}`,
): void {
  for (const tap of [...statusTaps]) {
    tap({ status, sessionId, paneId });
  }
}

function emitExit(sessionId: string): void {
  for (const tap of [...exitTaps]) tap(sessionId);
}

interface Harness {
  deps: NonWorkerAutoCloseDeps;
  closed: string[];
  state: {
    enabled: boolean;
    idle: boolean;
    ref: NonWorkerPaneRef | null;
  };
}

function harness(overrides: Partial<Harness['state']> = {}): Harness {
  const state: Harness['state'] = {
    enabled: true,
    idle: true,
    ref: refFor('pty-u1'),
    ...overrides,
  };
  const closed: string[] = [];
  const deps: NonWorkerAutoCloseDeps = {
    isEnabled: () => state.enabled,
    getPaneRef: (sessionId) =>
      state.ref?.sessionId === sessionId ? state.ref : null,
    isIdle: () => state.idle,
    closePane: (paneId) => {
      closed.push(paneId);
      return true;
    },
    ttlMs: NON_WORKER_AUTO_CLOSE_TTL_MS,
    log: () => {},
  };
  return { deps, closed, state };
}

describe('pane-non-worker-auto-close (P1-4: auto-fechar panes não-worker idle)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownNonWorkerAutoClose();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  // (a) pane não-worker idle além do limite auto-fecha
  it('encerra pane não-worker idle após o TTL configurável', () => {
    const h = harness();
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');

    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS - 1);
    expect(h.closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]).toBe('pane-pty-u1');
  });

  // (b) pane não-worker ATIVO não é fechado
  it('cancela o encerramento quando o pane volta a trabalhar', () => {
    const h = harness();
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS / 2);

    emitStatus('pty-u1', 'working');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  // (b) re-avalia no disparo: pane ativo entre arm e fire não é fechado
  it('re-avalia no disparo: busy entre armar e disparar não fecha', () => {
    const h = harness();
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');

    h.state.idle = false;
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS + 1);
    expect(h.closed).toHaveLength(0);
  });

  // (c) limite é configurável
  it('respeita TTL customizado', () => {
    const state = { enabled: true, idle: true, ref: refFor('pty-u1') };
    const closed: string[] = [];
    const customTtl = 10_000;
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => state.enabled,
      getPaneRef: (sid) => (state.ref?.sessionId === sid ? state.ref : null),
      isIdle: () => state.idle,
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: customTtl,
      log: () => {},
    };
    initNonWorkerAutoClose(deps);
    emitStatus('pty-u1', 'idle');

    vi.advanceTimersByTime(customTtl - 1);
    expect(closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(closed).toHaveLength(1);
  });

  it('não encerra quando a flag está desligada', () => {
    const h = harness({ enabled: false });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('nunca encerra pane com role=worker', () => {
    const h = harness({
      ref: refFor('pty-u1', { role: 'worker' }),
    });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('nunca encerra pane com role=orchestrator', () => {
    const h = harness({
      ref: refFor('pty-u1', { role: 'orchestrator' }),
    });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('exit da sessão cancela o timer', () => {
    const h = harness();
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');
    emitExit('pty-u1');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('shutdown limpa timers pendentes', () => {
    const h = harness();
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-u1', 'idle');
    shutdownNonWorkerAutoClose();
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('múltiplos panes não-worker encerrados independentemente', () => {
    const sessions = ['pty-u1', 'pty-u2', 'pty-u3'] as const;
    const refs = new Map<string, NonWorkerPaneRef>(
      sessions.map((sid) => [sid, refFor(sid)]),
    );
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refs.get(sid) ?? null,
      isIdle: () => true,
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: NON_WORKER_AUTO_CLOSE_TTL_MS,
      log: () => {},
    };
    initNonWorkerAutoClose(deps);

    for (const sid of sessions) emitStatus(sid, 'idle');

    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS - 1);
    expect(closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(closed).toHaveLength(sessions.length);
    expect(closed.sort()).toEqual(sessions.map((s) => `pane-${s}`).sort());
  });
});

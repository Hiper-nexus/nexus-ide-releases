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
    // F-572: o default é um helper aberto pela mão do operador; um pane
    // aberto pelo humano (sem pai) é testado à parte e nunca fecha.
    operatorParentSessionId: 'pty-operator',
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

  // F-572: worker COM missão continua intocável (a missão governa o ciclo de
  // vida); worker SEM missão é a classe órfã e passou a ser elegível — ver o
  // describe "pane guardian" abaixo.
  it('nunca encerra pane com role=worker de uma missão', () => {
    const h = harness({
      ref: refFor('pty-u1', { role: 'worker', missionId: 'mission-1' }),
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

// ---------------------------------------------------------------------------
// F-572 — pane guardian: worker órfão (sem missão) e varredura periódica.
// Incidente 16/09: 33 spawns / 6 closes; ~25 workers sem missão ficaram
// parados após handoff recusado; 22 panes × ~1 GB esgotaram a RAM do Mac.
// ---------------------------------------------------------------------------
describe('pane guardian (F-572): worker órfão + varredura periódica', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownNonWorkerAutoClose();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  it('encerra worker SEM missão idle após o TTL (classe órfã do F-565)', () => {
    const h = harness({
      ref: refFor('pty-w1', { role: 'worker', missionId: undefined }),
    });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS + 1);
    expect(h.closed).toEqual(['pane-pty-w1']);
  });

  it('nunca encerra worker COM missão (a missão governa o ciclo de vida)', () => {
    const h = harness({
      ref: refFor('pty-w2', { role: 'worker', missionId: 'mission-1' }),
    });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-w2', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('varredura encerra pane idle no PTY mesmo sem nenhum status semântico (CLI sem hooks)', () => {
    const idle = new Set<string>(['pty-s1']);
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
    };
    initNonWorkerAutoClose(deps);
    // Nenhum emitStatus: só a varredura enxerga o pane.
    vi.advanceTimersByTime(9_999);
    expect(closed).toHaveLength(0);
    vi.advanceTimersByTime(1_001);
    expect(closed).toEqual(['pane-pty-s1']);
  });

  it('varredura conta o idle a partir da PRIMEIRA observação, nunca fecha na hora', () => {
    const idle = new Set<string>(['pty-s2']);
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(1_000);
    expect(closed).toHaveLength(0);
  });

  it('varredura zera o relógio quando o pane volta a ficar busy', () => {
    const idle = new Set<string>(['pty-s3']);
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(6_000);
    idle.delete('pty-s3'); // busy
    vi.advanceTimersByTime(2_000);
    idle.add('pty-s3'); // idle de novo — relógio recomeça
    vi.advanceTimersByTime(9_000);
    expect(closed).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(closed).toEqual(['pane-pty-s3']);
  });

  it('varredura respeita o veto de idle (awaiting-input) e os papéis protegidos', () => {
    const listed = ['pty-a1', 'pty-o1', 'pty-m1'];
    const refs = new Map<string, NonWorkerPaneRef>([
      ['pty-a1', refFor('pty-a1')],
      ['pty-o1', refFor('pty-o1', { role: 'orchestrator' })],
      ['pty-m1', refFor('pty-m1', { role: 'worker', missionId: 'mission-9' })],
    ]);
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refs.get(sid) ?? null,
      // pty-a1 está idle no PTY mas com diálogo aberto → veto.
      isIdle: (sid) => sid !== 'pty-a1',
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => listed,
      sweepIntervalMs: 1_000,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(30_000);
    expect(closed).toHaveLength(0);
  });

  it('shutdown para a varredura', () => {
    const idle = new Set<string>(['pty-s4']);
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(5_000);
    shutdownNonWorkerAutoClose();
    vi.advanceTimersByTime(60_000);
    expect(closed).toHaveLength(0);
  });
});

describe('pane guardian (F-572): quem NUNCA é fechado', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownNonWorkerAutoClose();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  it('pane aberto pelo humano no renderer (sem pai, sem papel) fica aberto mesmo ocioso', () => {
    const h = harness({
      ref: refFor('pty-h1', { role: undefined, operatorParentSessionId: undefined }),
    });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-h1', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS * 3);
    expect(h.closed).toHaveLength(0);
  });

  it('helper aberto pela mão do operador (com pai) fecha após o TTL', () => {
    const h = harness({
      ref: refFor('pty-h2', { role: undefined, operatorParentSessionId: 'pty-op' }),
    });
    initNonWorkerAutoClose(h.deps);
    emitStatus('pty-h2', 'idle');
    vi.advanceTimersByTime(NON_WORKER_AUTO_CLOSE_TTL_MS + 1);
    expect(h.closed).toEqual(['pane-pty-h2']);
  });

  it('pane com contrato de entrega armado (expect) não fecha enquanto não entregar', () => {
    const closed: string[] = [];
    let armed = true;
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: () => true,
      hasPendingDelivery: () => armed,
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => ['pty-d1'],
      sweepIntervalMs: 1_000,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(30_000);
    expect(closed).toHaveLength(0);
    armed = false;
    vi.advanceTimersByTime(2_000);
    expect(closed).toEqual(['pane-pty-d1']);
  });
});

describe('pane guardian (0.76.44): reaper de emergência sob pressão de memória', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownNonWorkerAutoClose();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  function pressureHarness(pressure: { on: boolean }, idle: Set<string>) {
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      // Fechar = a sessão sai (exit); no harness, some do conjunto idle.
      closePane: (paneId) => { closed.push(paneId); idle.delete(paneId.replace('pane-', '')); return true; },
      ttlMs: 30 * 60_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
      isUnderMemoryPressure: () => pressure.on,
    };
    return { deps, closed };
  }

  it('sob pressão, fecha na hora o pane ocioso elegível mais antigo, sem esperar o TTL', () => {
    const pressure = { on: false };
    const idle = new Set<string>(['pty-e1', 'pty-e2']);
    const h = pressureHarness(pressure, idle);
    initNonWorkerAutoClose(h.deps);
    vi.advanceTimersByTime(1_000); // e1 e e2 vistos idle
    idle.add('pty-e3');
    vi.advanceTimersByTime(1_000); // e3 visto depois
    expect(h.closed).toHaveLength(0);
    pressure.on = true;
    vi.advanceTimersByTime(1_000);
    // Um por tick, o mais parado primeiro: e1 (ou e2, mesma idade) antes de e3.
    expect(h.closed).toHaveLength(1);
    expect(['pane-pty-e1', 'pane-pty-e2']).toContain(h.closed[0]);
    vi.advanceTimersByTime(1_000);
    expect(h.closed).toHaveLength(2);
    expect(h.closed).not.toContain('pane-pty-e3');
  });

  it('sem pressão, o TTL normal continua valendo', () => {
    const pressure = { on: false };
    const idle = new Set<string>(['pty-e4']);
    const h = pressureHarness(pressure, idle);
    initNonWorkerAutoClose(h.deps);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.closed).toHaveLength(0);
  });

  it('sob pressão continua respeitando os vetos: orquestrador e pane do humano ficam', () => {
    const pressure = { on: true };
    const idle = new Set<string>(['pty-o', 'pty-h']);
    const refs = new Map<string, NonWorkerPaneRef>([
      ['pty-o', refFor('pty-o', { role: 'orchestrator' })],
      ['pty-h', refFor('pty-h', { role: undefined, operatorParentSessionId: undefined })],
    ]);
    const closed: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refs.get(sid) ?? null,
      isIdle: (sid) => idle.has(sid),
      closePane: (paneId) => { closed.push(paneId); return true; },
      ttlMs: 30 * 60_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
      isUnderMemoryPressure: () => pressure.on,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(5_000);
    expect(closed).toHaveLength(0);
  });
});

describe('pane guardian (0.76.45): estacionar em vez de fechar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownNonWorkerAutoClose();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  it('com parkPane presente, estaciona (closePane nunca é chamado) e passa o motivo', () => {
    const parked: Array<{ paneId: string; reason: string }> = [];
    const closed: string[] = [];
    const idle = new Set<string>(['pty-p1']);
    const pressure = { on: false };
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      closePane: (paneId) => { closed.push(paneId); return true; },
      parkPane: (paneId, reason) => { parked.push({ paneId, reason }); idle.delete(paneId.replace('pane-', '')); return 'parked'; },
      ttlMs: 10_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
      isUnderMemoryPressure: () => pressure.on,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(11_000);
    expect(closed).toHaveLength(0);
    expect(parked).toEqual([{ paneId: 'pane-pty-p1', reason: 'idle' }]);

    idle.add('pty-p2');
    vi.advanceTimersByTime(1_000);
    pressure.on = true;
    vi.advanceTimersByTime(1_000);
    expect(parked[1]).toEqual({ paneId: 'pane-pty-p2', reason: 'memory-pressure' });
    expect(closed).toHaveLength(0);
  });
});


describe('pane guardian (0.76.45): carência pós-acordar e gate cego', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownNonWorkerAutoClose();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  it('sob pressão, um pane que acabou de acordar não é estacionado de novo dentro da carência', () => {
    const idle = new Set<string>(['pty-w1', 'pty-w2']);
    const parked: string[] = [];
    const wokeAgo = new Map<string, number>([['pty-w1', 30_000]]); // acordou há 30 s
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: (sid) => idle.has(sid),
      closePane: () => true,
      parkPane: (paneId) => { parked.push(paneId); idle.delete(paneId.replace('pane-', '')); return 'parked'; },
      ttlMs: 30 * 60_000,
      log: () => {},
      listIdleSessions: () => [...idle],
      sweepIntervalMs: 1_000,
      isUnderMemoryPressure: () => true,
      wokeAgoMs: (sid) => wokeAgo.get(sid) ?? null,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(1_000); // ambos vistos idle
    vi.advanceTimersByTime(1_000); // pressão: w1 tem carência, w2 é estacionado
    expect(parked).toEqual(['pane-pty-w2']);
  });

  it('avisa uma vez quando a amostra de memória some por 3 varreduras seguidas', () => {
    const logs: string[] = [];
    const deps: NonWorkerAutoCloseDeps = {
      isEnabled: () => true,
      getPaneRef: (sid) => refFor(sid),
      isIdle: () => false,
      closePane: () => true,
      ttlMs: 30 * 60_000,
      log: (m) => logs.push(m),
      listIdleSessions: () => [],
      sweepIntervalMs: 1_000,
      isMemorySampleMissing: () => true,
    };
    initNonWorkerAutoClose(deps);
    vi.advanceTimersByTime(5_000);
    expect(logs.filter((m) => m.includes('gate de pressão está cego'))).toHaveLength(1);
  });
});

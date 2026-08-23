import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, PaneSnapshot } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  MissionPaneCloseRequest,
  PaneRuntimeAuthority,
} from './pane-registry';

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
  initMissionDoneTeardown,
  shutdownMissionDoneTeardown,
  WORKER_POST_DONE_TTL_MS,
  type MissionDoneTeardownDeps,
} from './mission-done-teardown';

const scope: ProjectExecutionScope = {
  installationId: 'inst-1',
  projectId: 'proj-1',
  checkoutId: 'chk-1',
  rootRealPath: '/tmp/proj-1',
} as ProjectExecutionScope;
const scopeKey = JSON.stringify(scope);

function missionFor(status: string, id = 'mission-1'): Mission {
  return { id, status, title: 'Missão' } as unknown as Mission;
}

function paneFor(
  paneId: string,
  role: 'orchestrator' | 'worker',
  sessionId: string | null,
): PaneSnapshot {
  return {
    paneId,
    sessionId,
    missionId: 'mission-1',
    role,
    scope,
    workerIncarnationId: role === 'worker' ? `inc-${paneId}` : undefined,
  } as unknown as PaneSnapshot;
}

function authorityFor(
  sessionId: string,
  overrides: Partial<PaneRuntimeAuthority> = {},
): PaneRuntimeAuthority {
  return {
    owner: null,
    paneId: `pane-${sessionId}`,
    sessionId,
    missionId: 'mission-1',
    role: 'worker',
    workerIncarnationId: 'inc-1',
    scope,
    ...overrides,
  } as unknown as PaneRuntimeAuthority;
}

function emitStatus(sessionId: string, status: string): void {
  for (const tap of [...statusTaps]) {
    tap({ status, sessionId, paneId: `pane-${sessionId}` });
  }
}

function emitExit(sessionId: string): void {
  for (const tap of [...exitTaps]) tap(sessionId);
}

interface Harness {
  deps: MissionDoneTeardownDeps;
  closed: MissionPaneCloseRequest[];
  emitMissions: (missions: Mission[]) => void;
  state: {
    enabled: boolean;
    idle: boolean;
    status: string;
    panes: PaneSnapshot[];
    authority: PaneRuntimeAuthority | null;
  };
}

function harness(overrides: Partial<Harness['state']> = {}): Harness {
  const state: Harness['state'] = {
    enabled: true,
    idle: true,
    status: 'done',
    panes: [],
    authority: authorityFor('pty-w1'),
    ...overrides,
  };
  const closed: MissionPaneCloseRequest[] = [];
  const missionTaps = new Set<
    (scopeKey: string, missions: readonly Mission[]) => void
  >();
  const deps: MissionDoneTeardownDeps = {
    isEnabled: () => state.enabled,
    tapMissions: (cb) => {
      missionTaps.add(cb);
      return () => missionTaps.delete(cb);
    },
    parseScope: (key) => JSON.parse(key) as ProjectExecutionScope,
    listMissionPanes: () => state.panes,
    getAuthority: () => state.authority,
    missionStatus: () => state.status,
    isIdle: () => state.idle,
    closePane: (request) => {
      closed.push(request);
      return true;
    },
    ttlMs: WORKER_POST_DONE_TTL_MS,
    retryDelayMs: 100,
    log: () => {},
  };
  return {
    deps,
    closed,
    state,
    emitMissions: (missions) => {
      for (const tap of [...missionTaps]) tap(scopeKey, missions);
    },
  };
}

function transitionToDone(h: Harness): void {
  h.emitMissions([missionFor('running')]);
  h.emitMissions([missionFor('done')]);
}

describe('mission-done-teardown (F-106: orquestrador permanece, worker idle 30s — reversão 23/08)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownMissionDoneTeardown();
    statusTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  it('orquestrador PERMANECE no done (superfície de ajuste pós-entrega)', () => {
    const h = harness({
      panes: [paneFor('pane-maestro', 'orchestrator', 'pty-maestro')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);

    expect(h.closed).toHaveLength(0);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('worker idle no done é encerrado após o TTL', () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);

    expect(h.closed).toHaveLength(0);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS - 1);
    expect(h.closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]).toMatchObject({
      paneId: 'pane-pty-w1',
      role: 'worker',
      workerIncarnationId: 'inc-1',
    });
  });

  it('trabalho novo do worker cancela o encerramento; idle rearma', () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS / 2);

    emitStatus('pty-w1', 'working');
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);

    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS + 1);
    expect(h.closed).toHaveLength(1);
  });

  it('re-avalia no disparo: busy entre armar e disparar não fecha', () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);

    h.state.idle = false; // operador mandou algo sem transição observada
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS + 1);
    expect(h.closed).toHaveLength(0);
  });

  it('missão que reabre (done → running) não fecha worker no disparo', () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);

    h.state.status = 'running'; // missão reaberta antes do TTL
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS + 1);
    expect(h.closed).toHaveLength(0);
  });

  it('seed/replay de missão antiga já done nunca dispara teardown', () => {
    const h = harness({
      panes: [
        paneFor('pane-maestro', 'orchestrator', 'pty-maestro'),
        paneFor('pane-w1', 'worker', 'pty-w1'),
      ],
    });
    initMissionDoneTeardown(h.deps);

    // Primeira visão da missão já done (sem transição observada).
    h.emitMissions([missionFor('done')]);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('não age com a flag desligada (opt-out explícito — default ON)', () => {
    const h = harness({
      enabled: false,
      panes: [
        paneFor('pane-maestro', 'orchestrator', 'pty-maestro'),
        paneFor('pane-w1', 'worker', 'pty-w1'),
      ],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('transição para failed não dispara teardown (escopo: só done)', () => {
    const h = harness({
      status: 'failed',
      panes: [
        paneFor('pane-maestro', 'orchestrator', 'pty-maestro'),
        paneFor('pane-w1', 'worker', 'pty-w1'),
      ],
    });
    initMissionDoneTeardown(h.deps);
    h.emitMissions([missionFor('running')]);
    h.emitMissions([missionFor('failed')]);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('nunca encerra pane sem role de missão (shell do usuário)', () => {
    const userShell = {
      paneId: 'pane-shell',
      sessionId: 'pty-shell',
      scope,
    } as unknown as PaneSnapshot;
    const h = harness({ panes: [userShell] });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('worker que fica idle DEPOIS do done arma o TTL pelo tap de status', () => {
    const h = harness({
      panes: [], // worker ainda busy no momento do done
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);
    expect(h.closed).toHaveLength(0);

    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS + 1);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]!.role).toBe('worker');
  });

  it('exit da sessão cancela o timer', () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);
    emitExit('pty-w1');
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('shutdown limpa timers pendentes', () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);
    shutdownMissionDoneTeardown();
    vi.advanceTimersByTime(WORKER_POST_DONE_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('re-tenta o close quando a autoridade recusa de forma transitória', async () => {
    // Voo real 23/08: o exit dispara re-sync do renderer que troca o objeto
    // do registro no meio do close ("alvo-mudou-durante-termino"). A recusa
    // é conservadora e transitória — a chamada selada é idempotente.
    // Agora o retry vale só para workers (orquestrador permanece).
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    let attempts = 0;
    (h.deps as unknown as Record<string, unknown>).closePane = (
      request: MissionPaneCloseRequest,
    ) => {
      attempts += 1;
      if (attempts === 1) return false; // corrida do re-sync
      h.closed.push(request);
      return true;
    };
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);

    expect(attempts).toBe(0);
    expect(h.closed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(WORKER_POST_DONE_TTL_MS + 300);
    expect(attempts).toBe(2);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]!.paneId).toBe('pane-pty-w1');
  });

  it('desiste após 3 recusas seguidas (fail-closed, sem loop)', async () => {
    const h = harness({
      panes: [paneFor('pane-w1', 'worker', 'pty-w1')],
    });
    let attempts = 0;
    (h.deps as unknown as Record<string, unknown>).closePane = () => {
      attempts += 1;
      return false;
    };
    initMissionDoneTeardown(h.deps);
    transitionToDone(h);

    await vi.advanceTimersByTimeAsync(WORKER_POST_DONE_TTL_MS + 1_000);
    expect(attempts).toBe(3);
    expect(h.closed).toHaveLength(0);

    // Sem nova tentativa depois de esgotar o orçamento.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(3);
  });
});

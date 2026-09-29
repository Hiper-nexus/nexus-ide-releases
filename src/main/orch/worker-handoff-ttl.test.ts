import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { PaneRuntimeAuthority } from './pane-registry';

type StatusTap = (entry: {
  status: string;
  sessionId: string;
  paneId: string;
}) => void;
type ExitTap = (sessionId: string) => void;

type TurnStartTap = (entry: {
  sessionId: string;
  paneId: string;
  sequence: number;
  observedAt: number;
}) => void;

const statusTaps = new Set<StatusTap>();
const turnStartTaps = new Set<TurnStartTap>();
const exitTaps = new Set<ExitTap>();

vi.mock('./agent-status', () => ({
  tapAgentSemanticStatus: (cb: StatusTap) => {
    statusTaps.add(cb);
    return () => statusTaps.delete(cb);
  },
  tapAgentTurnStart: (cb: TurnStartTap) => {
    turnStartTaps.add(cb);
    return () => turnStartTaps.delete(cb);
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
  initWorkerHandoffTtl,
  shutdownWorkerHandoffTtl,
  WORKER_POST_HANDOFF_TTL_MS,
  type WorkerHandoffTtlDeps,
} from './worker-handoff-ttl';

const scope: ProjectExecutionScope = {
  installationId: 'inst-1',
  projectId: 'proj-1',
  checkoutId: 'chk-1',
  rootRealPath: '/tmp/proj-1',
} as ProjectExecutionScope;

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

function handoffFor(
  sessionId: string,
  deliveryState: Handoff['deliveryState'],
): Handoff {
  return {
    id: `hoff-${sessionId}-${deliveryState}`,
    missionId: 'mission-1',
    sessionId,
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'ok',
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState,
    createdAt: Date.now(),
  } as Handoff;
}

function emitStatus(sessionId: string, status: string): void {
  for (const tap of [...statusTaps]) {
    tap({ status, sessionId, paneId: `pane-${sessionId}` });
  }
}

function emitTurnStart(sessionId: string): void {
  for (const tap of [...turnStartTaps]) {
    tap({ sessionId, paneId: `pane-${sessionId}`, sequence: 1, observedAt: Date.now() });
  }
}

function emitExit(sessionId: string): void {
  for (const tap of [...exitTaps]) tap(sessionId);
}

interface Harness {
  deps: WorkerHandoffTtlDeps;
  closed: PaneRuntimeAuthority[];
  state: {
    enabled: boolean;
    idle: boolean;
    status: string | null;
    handoffs: Handoff[];
    authority: PaneRuntimeAuthority | null;
  };
}

function harness(overrides: Partial<Harness['state']> = {}): Harness {
  const state: Harness['state'] = {
    enabled: true,
    idle: true,
    status: 'running',
    handoffs: [handoffFor('pty-w1', 'consumed')],
    authority: authorityFor('pty-w1'),
    ...overrides,
  };
  const closed: PaneRuntimeAuthority[] = [];
  const deps: WorkerHandoffTtlDeps = {
    isEnabled: () => state.enabled,
    getAuthority: () => state.authority,
    listHandoffs: () => state.handoffs,
    missionStatus: () => state.status,
    isIdle: () => state.idle,
    closePane: (authority) => {
      closed.push(authority);
      return true;
    },
    ttlMs: WORKER_POST_HANDOFF_TTL_MS,
    log: () => {},
  };
  return { deps, closed, state };
}

describe('worker-handoff-ttl (paridade Overclock: worker fecha ~30s pós-handoff limpo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownWorkerHandoffTtl();
    statusTaps.clear();
    turnStartTaps.clear();
    exitTaps.clear();
    vi.useRealTimers();
  });

  it('encerra worker idle com todos os handoffs consumidos após o TTL', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');

    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS - 1);
    expect(h.closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]!.sessionId).toBe('pty-w1');
  });

  it('cancela o encerramento quando o worker volta a trabalhar', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS / 2);

    emitStatus('pty-w1', 'working');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('F-690: helper reaproveitado depois do consumo não fecha na pausa do trabalho novo', () => {
    // 29/09: consumido 16:04:22, Maestro escreveu 16:04:27, TTL matou 16:06:42.
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    vi.advanceTimersByTime(5_000);
    emitStatus('pty-w1', 'working');
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 4);
    expect(h.closed).toHaveLength(0);
  });

  it('F-690: submissão nova sem transição de status também conta como trabalho', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    vi.advanceTimersByTime(5_000);
    emitTurnStart('pty-w1');
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 4);
    expect(h.closed).toHaveLength(0);
  });

  it('F-690: reaproveitado fecha de novo depois de entregar e ter o handoff novo consumido', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    vi.advanceTimersByTime(5_000);
    emitStatus('pty-w1', 'working');
    vi.advanceTimersByTime(60_000);
    h.state.handoffs = [
      handoffFor('pty-w1', 'consumed'),
      { ...handoffFor('pty-w1', 'consumed'), id: 'hoff-second', createdAt: Date.now() },
    ];
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS);
    expect(h.closed).toHaveLength(1);
  });

  it('re-avalia no disparo: busy entre armar e disparar não fecha', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');

    h.state.idle = false; // recebeu trabalho sem transição semântica observada
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS + 1);
    expect(h.closed).toHaveLength(0);
  });

  it('não arma com a flag desligada (opt-out explícito — default ON)', () => {
    const h = harness({ enabled: false });
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('arma com a flag no estado default (ON por padrão)', () => {
    const h = harness({ enabled: true });
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS + 1);
    expect(h.closed).toHaveLength(1);
  });

  it('não arma enquanto houver handoff não consumido', () => {
    const h = harness({
      handoffs: [
        handoffFor('pty-w1', 'consumed'),
        handoffFor('pty-w1', 'queued'),
      ],
    });
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('não arma sem nenhum handoff do worker', () => {
    const h = harness({ handoffs: [] });
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('nunca encerra orchestrator', () => {
    const h = harness({
      authority: authorityFor('pty-w1', { role: 'orchestrator' }),
    });
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('missão fora de running pertence à máquina de encerramento da missão', () => {
    for (const status of ['done', 'failed', 'blocked', 'pending']) {
      const h = harness({ status });
      initWorkerHandoffTtl(h.deps);
      emitStatus('pty-w1', 'idle');
      vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
      expect(h.closed).toHaveLength(0);
      shutdownWorkerHandoffTtl();
    }
  });

  it('exit da sessão cancela o timer', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    emitExit('pty-w1');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('shutdown limpa timers pendentes', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    shutdownWorkerHandoffTtl();
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
  });

  it('reaping é provider-agnostic: claude, codex e gemini são encerrados com o mesmo TTL', () => {
    // Roster heterogêneo: cada sessionId representa um provider diferente.
    // O caminho de reaping não inspeciona nenhum campo de provider — verifica
    // apenas role='worker', missionId, scope e deliveryState dos handoffs.
    const sessions = ['claude-worker-s1', 'codex-worker-s2', 'gemini-worker-s3'] as const;

    const authorities = new Map<string, PaneRuntimeAuthority>(
      sessions.map((sid) => [sid, authorityFor(sid)]),
    );
    // Cada worker tem um handoff próprio (filtrado por sessionId em workerHandoffs).
    const allHandoffs = sessions.map((sid) => handoffFor(sid, 'consumed'));
    const closed: PaneRuntimeAuthority[] = [];

    const deps: WorkerHandoffTtlDeps = {
      isEnabled: () => true,
      getAuthority: (sid) => authorities.get(sid) ?? null,
      // listHandoffs devolve todos; workerHandoffs filtra por authority.sessionId.
      listHandoffs: () => allHandoffs,
      missionStatus: () => 'running',
      isIdle: () => true,
      closePane: (authority) => {
        closed.push(authority);
        return true;
      },
      ttlMs: WORKER_POST_HANDOFF_TTL_MS,
      log: () => {},
    };

    initWorkerHandoffTtl(deps);

    for (const sid of sessions) emitStatus(sid, 'idle');

    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS - 1);
    expect(closed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(closed).toHaveLength(sessions.length);
    expect(closed.map((a) => a.sessionId).sort()).toEqual(
      [...sessions].sort(),
    );
  });
});

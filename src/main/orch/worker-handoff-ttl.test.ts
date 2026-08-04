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

  it('re-avalia no disparo: busy entre armar e disparar não fecha', () => {
    const h = harness();
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');

    h.state.idle = false; // recebeu trabalho sem transição semântica observada
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS + 1);
    expect(h.closed).toHaveLength(0);
  });

  it('não arma com a flag desligada (opt-in, default OFF)', () => {
    const h = harness({ enabled: false });
    initWorkerHandoffTtl(h.deps);
    emitStatus('pty-w1', 'idle');
    vi.advanceTimersByTime(WORKER_POST_HANDOFF_TTL_MS * 2);
    expect(h.closed).toHaveLength(0);
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
});

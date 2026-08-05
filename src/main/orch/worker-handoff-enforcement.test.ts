import { readFileSync } from 'node:fs';
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
  orchWriteSession: vi.fn(() => true),
}));

import {
  decideQuietWorker,
  initWorkerHandoffEnforcement,
  shutdownWorkerHandoffEnforcement,
  WORKER_ENFORCE_GRACE_MS,
  WORKER_HANDOFF_REQUIRED_MARKER,
  WORKER_QUIET_GRACE_MS,
  type QuietWorkerState,
  type WorkerHandoffEnforcementDeps,
} from './worker-handoff-enforcement';

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
  overrides: Partial<Handoff> = {},
): Handoff {
  return {
    id: `hoff-${sessionId}`,
    missionId: 'mission-1',
    sessionId,
    status: 'success',
    summary: 'entreguei',
    artifacts: [],
    evidenceIds: [],
    delivered: false,
    deliveryState: 'queued',
    createdAt: Date.now(),
    ...overrides,
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

function baseState(overrides: Partial<QuietWorkerState> = {}): QuietWorkerState {
  return {
    role: 'worker',
    hasHandoff: false,
    nudged: false,
    enforced: false,
    exited: false,
    ...overrides,
  };
}

interface Harness {
  deps: WorkerHandoffEnforcementDeps;
  readonly nudges: Array<{ sessionId: string; text: string }>;
  readonly submitted: Array<{
    sessionId: string;
    status: string;
    summary: string;
  }>;
  handoffs: Handoff[];
  missionStatus: string;
  nudgeResult: boolean;
}

function makeHarness(
  overrides: Partial<WorkerHandoffEnforcementDeps> = {},
): Harness {
  const nudges: Harness['nudges'] = [];
  const submitted: Harness['submitted'] = [];
  const harness: Harness = {
    nudges,
    submitted,
    handoffs: [],
    missionStatus: 'running',
    nudgeResult: true,
    deps: undefined as unknown as WorkerHandoffEnforcementDeps,
  };
  const deps: WorkerHandoffEnforcementDeps = {
    getAuthority: (sessionId: string) => authorityFor(sessionId),
    listHandoffs: () => harness.handoffs,
    missionStatus: () => harness.missionStatus,
    isIdle: () => true,
    nudge: (authority, text) => {
      nudges.push({ sessionId: authority.sessionId!, text });
      return harness.nudgeResult;
    },
    submitSynthetic: (authority, input) => {
      submitted.push({
        sessionId: authority.sessionId!,
        status: input.status,
        summary: input.summary,
      });
    },
    readTail: () => 'ultima linha do worker',
    quietGraceMs: WORKER_QUIET_GRACE_MS,
    enforceGraceMs: WORKER_ENFORCE_GRACE_MS,
    log: () => {},
    ...overrides,
  };
  harness.deps = deps;
  return harness;
}

describe('decideQuietWorker', () => {
  it('ignora quem não é worker', () => {
    expect(decideQuietWorker(baseState({ role: 'orchestrator' }))).toBe('ignore');
  });

  it('ignora worker que já entregou handoff', () => {
    expect(decideQuietWorker(baseState({ hasHandoff: true }))).toBe('ignore');
  });

  it('o estado da missão NUNCA silencia a cobrança (losslessness)', () => {
    // Missão que se auto-encerra enquanto o worker ainda codifica é o caso
    // originador do hotfix: silenciar aqui perderia o relatório justamente
    // quando ele explica por que a missão morreu.
    expect(decideQuietWorker(baseState({ exited: true }))).toBe('enforce');
    expect(decideQuietWorker(baseState({ nudged: true }))).toBe('enforce');
  });

  it('é idempotente após já ter forçado a entrega', () => {
    expect(decideQuietWorker(baseState({ enforced: true, nudged: true }))).toBe(
      'ignore',
    );
  });

  it('cutuca o worker mudo na primeira vez', () => {
    expect(decideQuietWorker(baseState())).toBe('nudge');
  });

  it('força a entrega quando a cutucada já foi feita', () => {
    expect(decideQuietWorker(baseState({ nudged: true }))).toBe('enforce');
  });

  it('força a entrega direto quando a sessão já morreu (não dá para cutucar)', () => {
    expect(decideQuietWorker(baseState({ exited: true }))).toBe('enforce');
  });
});

describe('worker-handoff-enforcement runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdownWorkerHandoffEnforcement();
    vi.useRealTimers();
    statusTaps.clear();
    exitTaps.clear();
  });

  it('cutuca o worker que ficou idle sem entregar handoff', () => {
    const harness = makeHarness();
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    expect(harness.nudges).toHaveLength(0);

    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS);
    expect(harness.nudges).toHaveLength(1);
    expect(harness.nudges[0]!.text).toContain(WORKER_HANDOFF_REQUIRED_MARKER);
    expect(harness.submitted).toHaveLength(0);
  });

  it('não cutuca worker que entregou handoff', () => {
    const harness = makeHarness();
    harness.handoffs = [handoffFor('s1')];
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS + WORKER_ENFORCE_GRACE_MS);
    expect(harness.nudges).toHaveLength(0);
    expect(harness.submitted).toHaveLength(0);
  });

  it('ignora handoff sintético de watchdog ao julgar o contrato do worker', () => {
    const harness = makeHarness();
    harness.handoffs = [
      handoffFor('s1', { fromAgent: 'nexus-watchdog', status: 'stalled' }),
    ];
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS);
    expect(harness.nudges).toHaveLength(1);
  });

  it('submete handoff blocked quando a cutucada não produz entrega', () => {
    const harness = makeHarness();
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS);
    expect(harness.nudges).toHaveLength(1);

    vi.advanceTimersByTime(WORKER_ENFORCE_GRACE_MS);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.status).toBe('blocked');
    expect(harness.submitted[0]!.summary).toContain('sem entregar um handoff');
    expect(harness.submitted[0]!.summary).toContain('ultima linha do worker');
  });

  it('cancela a cobrança quando o worker volta a trabalhar', () => {
    const harness = makeHarness();
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS / 2);
    emitStatus('s1', 'working');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS + WORKER_ENFORCE_GRACE_MS);
    expect(harness.nudges).toHaveLength(0);
    expect(harness.submitted).toHaveLength(0);
  });

  it('não cobra duas vezes o mesmo worker', () => {
    const harness = makeHarness();
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS + WORKER_ENFORCE_GRACE_MS);
    expect(harness.submitted).toHaveLength(1);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS + WORKER_ENFORCE_GRACE_MS);
    expect(harness.submitted).toHaveLength(1);
  });

  it('submete handoff failed quando a sessão morre sem handoff', () => {
    const harness = makeHarness();
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    emitExit('s1');
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.status).toBe('failed');
    expect(harness.submitted[0]!.summary).toContain('sem entregar um handoff');
  });

  it('cobra o handoff MESMO com a missão já encerrada (cenário originador)', () => {
    // A missão se auto-encerrou enquanto o worker ainda trabalhava: o
    // relatório dele é a evidência do porquê e não pode sumir.
    const harness = makeHarness();
    harness.missionStatus = 'done';
    initWorkerHandoffEnforcement(harness.deps);

    emitExit('s1');
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.status).toBe('failed');
    expect(harness.submitted[0]!.summary).toContain('sem entregar um handoff');
    expect(harness.submitted[0]!.summary).toContain('"done"');
  });

  it('cobra o worker ocioso mesmo com a missão parando', () => {
    const harness = makeHarness();
    harness.missionStatus = 'stopping';
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS + WORKER_ENFORCE_GRACE_MS);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.status).toBe('blocked');
  });

  it('não cobra pane que não é worker', () => {
    const harness = makeHarness({
      getAuthority: (sessionId) =>
        authorityFor(sessionId, { role: 'orchestrator' }),
    });
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS + WORKER_ENFORCE_GRACE_MS);
    expect(harness.nudges).toHaveLength(0);
    expect(harness.submitted).toHaveLength(0);
  });

  it('está fiado no ciclo de vida real da orquestração (não é código morto)', () => {
    const source = readFileSync(
      new URL('./orch-ipc.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('initWorkerHandoffEnforcement();');
    expect(source).toContain('shutdownWorkerHandoffEnforcement();');
    expect(source).toContain("from \"./worker-handoff-enforcement\"");
  });

  it('força a entrega imediatamente quando a cutucada não pôde ser escrita', () => {
    const harness = makeHarness();
    harness.nudgeResult = false;
    initWorkerHandoffEnforcement(harness.deps);

    emitStatus('s1', 'idle');
    vi.advanceTimersByTime(WORKER_QUIET_GRACE_MS);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.status).toBe('blocked');
  });
});

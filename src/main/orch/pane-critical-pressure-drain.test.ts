/**
 * Freio de emergência do guardião: drenar panes OCUPADOS na pressão crítica.
 *
 * Incidente 19/10 (cliente, iMac M5 16 GB): abriu ~2 panes, depois vários
 * mais, com terminais próprios fora do Nexus; o macOS travou inteiro. Medido
 * neste worktree: num Mac de 16 GB o teto é 4 panes e `hardBlocks` é false, e
 * o reaper de pressão só enxerga `listIdleSessions()`. Com 8 panes OCUPADOS e
 * pressão crítica por 10 varreduras, o guardião recuperava ZERO — a memória
 * está justamente nos panes que trabalham, e eles eram invisíveis para ele.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StatusTap = (e: { status: string; sessionId: string; paneId: string }) => void;
const statusTaps = new Set<StatusTap>();

vi.mock('./agent-status', () => ({
  tapAgentSemanticStatus: (cb: StatusTap) => {
    statusTaps.add(cb);
    return () => statusTaps.delete(cb);
  },
  isSessionIdleForCleanup: () => false,
}));
vi.mock('../pty/pty-manager', () => ({ tapSessionExit: () => () => {} }));

import {
  CRITICAL_BUSY_DRAIN_PARKS_PER_TICK,
  criticalDrainOrder,
  initNonWorkerAutoClose,
  PANE_GUARDIAN_SWEEP_INTERVAL_MS,
  paneIsSalvageableUnderCriticalPressure,
  PRESSURE_FAST_SWEEP_INTERVAL_MS,
  shutdownNonWorkerAutoClose,
  type NonWorkerAutoCloseDeps,
  type NonWorkerPaneRef,
} from './pane-non-worker-auto-close';

interface Pane {
  readonly sessionId: string;
  readonly role?: NonWorkerPaneRef['role'];
  readonly missionId?: string;
  /** undefined = pane aberto pelo humano no renderer ("+ Pane"). */
  readonly operatorParentSessionId?: string;
  readonly footprintMB?: number | null;
  readonly pendingDelivery?: boolean;
  readonly awaitingOperator?: boolean;
  readonly wokeAgoMs?: number | null;
}

function drainHarness(
  panes: readonly Pane[],
  pressure: { on: boolean; severe: boolean; critical: boolean },
) {
  const byId = new Map(panes.map((p) => [p.sessionId, p]));
  const live = new Set(panes.map((p) => p.sessionId));
  const parked: string[] = [];
  const deps: NonWorkerAutoCloseDeps = {
    isEnabled: () => true,
    getPaneRef: (sid) => {
      const pane = byId.get(sid);
      if (!pane || !live.has(sid)) return null;
      return {
        paneId: `pane-${sid}`,
        sessionId: sid,
        role: pane.role,
        missionId: pane.missionId,
        operatorParentSessionId: pane.operatorParentSessionId,
      };
    },
    // Todos trabalhando: é o estado que consome a RAM.
    isIdle: () => false,
    hasPendingDelivery: (sid) => byId.get(sid)?.pendingDelivery === true,
    closePane: (paneId) => {
      parked.push(paneId);
      live.delete(paneId.replace('pane-', ''));
      return true;
    },
    parkPane: (paneId) => {
      parked.push(paneId);
      live.delete(paneId.replace('pane-', ''));
      return 'parked';
    },
    wokeAgoMs: (sid) => byId.get(sid)?.wokeAgoMs ?? null,
    paneFootprintMB: (sid) => byId.get(sid)?.footprintMB ?? null,
    isAwaitingOperator: (sid) => byId.get(sid)?.awaitingOperator === true,
    listAgentSessions: () => [...live],
    listIdleSessions: () => [],
    ttlMs: 30 * 60_000,
    sweepIntervalMs: 1_000,
    log: () => {},
    isUnderMemoryPressure: () => pressure.on,
    isSevereMemoryPressure: () => pressure.severe,
    isCriticalMemoryPressure: () => pressure.critical,
  };
  return { deps, parked, live };
}

const CRITICAL = { on: true, severe: true, critical: true };

describe('guardião: drenar panes ocupados na pressão crítica (iMac M5 16 GB)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await shutdownNonWorkerAutoClose();
    statusTaps.clear();
    vi.useRealTimers();
  });

  it('com todos os panes OCUPADOS e pressão crítica, recupera o de maior footprint primeiro', async () => {
    const h = drainHarness(
      [
        { sessionId: 's1', operatorParentSessionId: 'op', footprintMB: 900 },
        { sessionId: 's2', operatorParentSessionId: 'op', footprintMB: 3100 },
        { sessionId: 's3', operatorParentSessionId: 'op', footprintMB: 1500 },
      ],
      { ...CRITICAL },
    );
    initNonWorkerAutoClose(h.deps);
    await vi.advanceTimersByTimeAsync(1_000);
    // O maior primeiro: s2 (3,1 GB) antes de s3 e s1.
    expect(h.parked[0]).toBe('pane-s2');
    expect(h.parked).toHaveLength(CRITICAL_BUSY_DRAIN_PARKS_PER_TICK);
    expect(h.parked[1]).toBe('pane-s3');
  });

  it('para assim que a pressão passa — não drena a máquina inteira', async () => {
    const pressure = { ...CRITICAL };
    const h = drainHarness(
      [
        { sessionId: 'a', operatorParentSessionId: 'op', footprintMB: 2000 },
        { sessionId: 'b', operatorParentSessionId: 'op', footprintMB: 1000 },
        { sessionId: 'c', operatorParentSessionId: 'op', footprintMB: 900 },
      ],
      pressure,
    );
    const deps: NonWorkerAutoCloseDeps = {
      ...h.deps,
      parkPane: (paneId) => {
        const out = h.deps.parkPane?.(paneId, 'memory-pressure');
        pressure.on = false; // o primeiro park já devolveu folga
        pressure.severe = false;
        pressure.critical = false;
        return out ?? false;
      },
    };
    initNonWorkerAutoClose(deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.parked).toEqual(['pane-a']);
  });

  it('NUNCA toca o orquestrador, a entrega armada ou quem espera o operador', async () => {
    const h = drainHarness(
      [
        { sessionId: 'orch', role: 'orchestrator', footprintMB: 4000 },
        { sessionId: 'armed', operatorParentSessionId: 'op', footprintMB: 3500, pendingDelivery: true },
        { sessionId: 'asking', operatorParentSessionId: 'op', footprintMB: 3000, awaitingOperator: true },
        { sessionId: 'ok', operatorParentSessionId: 'op', footprintMB: 800 },
      ],
      { ...CRITICAL },
    );
    initNonWorkerAutoClose(h.deps);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.parked).toEqual(['pane-ok']);
  });

  it('prefere worker/helper ao pane que o humano abriu no "+ Pane"', async () => {
    const h = drainHarness(
      [
        // Pane do humano, o MAIOR — mas último na fila.
        { sessionId: 'human', footprintMB: 3000 },
        { sessionId: 'worker', role: 'worker', missionId: 'm1', footprintMB: 1200 },
      ],
      { ...CRITICAL },
    );
    initNonWorkerAutoClose(h.deps);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.parked[0]).toBe('pane-worker');
  });

  it('respeita a carência de quem acabou de acordar', async () => {
    const h = drainHarness(
      [{ sessionId: 'fresh', operatorParentSessionId: 'op', footprintMB: 3000, wokeAgoMs: 1_000 }],
      { ...CRITICAL },
    );
    initNonWorkerAutoClose(h.deps);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.parked).toEqual([]);
  });

  it('doutrina "menos travas": na pressão MODERADA e SEVERA não toca pane ocupado', async () => {
    for (const pressure of [
      { on: true, severe: false, critical: false },
      { on: true, severe: true, critical: false },
    ]) {
      const h = drainHarness(
        [{ sessionId: 'busy', operatorParentSessionId: 'op', footprintMB: 3000 }],
        pressure,
      );
      initNonWorkerAutoClose(h.deps);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.parked).toEqual([]);
      await shutdownNonWorkerAutoClose();
      statusTaps.clear();
    }
  });

  it('sob pressão a varredura roda em 5 s, não espera os 60 s', async () => {
    const h = drainHarness(
      [
        { sessionId: 'p1', operatorParentSessionId: 'op', footprintMB: 3000 },
        { sessionId: 'p2', operatorParentSessionId: 'op', footprintMB: 2000 },
      ],
      { ...CRITICAL },
    );
    initNonWorkerAutoClose({
      ...h.deps,
      sweepIntervalMs: PANE_GUARDIAN_SWEEP_INTERVAL_MS,
      pressureSweepIntervalMs: PRESSURE_FAST_SWEEP_INTERVAL_MS,
    });
    await vi.advanceTimersByTimeAsync(PRESSURE_FAST_SWEEP_INTERVAL_MS);
    expect(h.parked.length).toBeGreaterThan(0);
  });

  it('sem pressão a cadência curta não dispara varredura nenhuma', async () => {
    const h = drainHarness(
      [{ sessionId: 'calm', operatorParentSessionId: 'op', footprintMB: 3000 }],
      { on: false, severe: false, critical: false },
    );
    initNonWorkerAutoClose({
      ...h.deps,
      sweepIntervalMs: PANE_GUARDIAN_SWEEP_INTERVAL_MS,
      pressureSweepIntervalMs: PRESSURE_FAST_SWEEP_INTERVAL_MS,
    });
    await vi.advanceTimersByTimeAsync(PRESSURE_FAST_SWEEP_INTERVAL_MS * 5);
    expect(h.parked).toEqual([]);
  });

  it('criticalDrainOrder: tier do pane primeiro, footprint desc depois; sem footprint vai ao fim', () => {
    const h = drainHarness(
      [
        { sessionId: 'human-big', footprintMB: 5000 },
        { sessionId: 'helper-small', operatorParentSessionId: 'op', footprintMB: 100 },
        { sessionId: 'helper-big', operatorParentSessionId: 'op', footprintMB: 2000 },
        { sessionId: 'helper-unknown', operatorParentSessionId: 'op', footprintMB: null },
      ],
      { ...CRITICAL },
    );
    expect(
      criticalDrainOrder(h.deps, ['human-big', 'helper-small', 'helper-big', 'helper-unknown']),
    ).toEqual(['helper-big', 'helper-small', 'helper-unknown', 'human-big']);
  });

  it('paneIsSalvageableUnderCriticalPressure aceita pane ocupado (o reaper de idle não)', () => {
    const h = drainHarness([{ sessionId: 'busy', operatorParentSessionId: 'op' }], { ...CRITICAL });
    expect(paneIsSalvageableUnderCriticalPressure(h.deps, 'busy')?.paneId).toBe('pane-busy');
  });
});

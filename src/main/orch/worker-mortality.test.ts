import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_MORTALITY_CIRCUIT_BREAK,
  recordWorkerDeathWithoutDelivery,
  recordAdapterProofOfLife,
  resetMissionWorkerMortality,
  shouldTripWorkerMortalityBreaker,
  workerMortalityCount,
  workerMortalityBreakerMessage,
  workerPaneHasDelivery,
} from './worker-mortality';
import { writerCircuitBreakers } from './writer-circuit-break';
import {
  resetWriterCircuitForTests,
  writerCircuitBroken,
} from './writer-circuit-breaker';

/**
 * Campanha 0.50 (A1/A2, Orca PR #13927): worker que morre sem entregar é
 * MORTALIDADE. Sem contagem, o Maestro respawna o mesmo adapter para sempre
 * (missão real: 13/20 panes mortos sem um turno, pane respawnado 6×).
 */
describe('shouldTripWorkerMortalityBreaker', () => {
  it('abaixo do limite não corta', () => {
    expect(shouldTripWorkerMortalityBreaker(0)).toBe(false);
    expect(shouldTripWorkerMortalityBreaker(2)).toBe(false);
  });

  it('no limite corta', () => {
    expect(shouldTripWorkerMortalityBreaker(WORKER_MORTALITY_CIRCUIT_BREAK)).toBe(true);
    expect(shouldTripWorkerMortalityBreaker(6)).toBe(true);
  });
});

describe('estado de mortalidade por (missão, adapter)', () => {
  beforeEach(() => {
    resetMissionWorkerMortality('mission-1');
    resetMissionWorkerMortality('mission-2');
    writerCircuitBreakers.reset();
    resetWriterCircuitForTests();
  });

  it('conta mortes por adapter dentro da missão e não vaza entre missões', () => {
    recordWorkerDeathWithoutDelivery('mission-1', 'glm');
    recordWorkerDeathWithoutDelivery('mission-1', 'glm');
    recordWorkerDeathWithoutDelivery('mission-1', 'kimi');
    expect(workerMortalityCount('mission-1', 'glm')).toBe(2);
    expect(workerMortalityCount('mission-1', 'kimi')).toBe(1);
    expect(workerMortalityCount('mission-2', 'glm')).toBe(0);
  });

  it('entrega do adapter é prova de vida: zera a contagem', () => {
    recordWorkerDeathWithoutDelivery('mission-1', 'codex');
    recordWorkerDeathWithoutDelivery('mission-1', 'codex');
    recordAdapterProofOfLife('mission-1', 'codex');
    expect(workerMortalityCount('mission-1', 'codex')).toBe(0);
  });

  it('mensagem do breaker é acionável e nomeia o adapter', () => {
    const message = workerMortalityBreakerMessage('glm', 3);
    expect(message).toContain('glm');
    expect(message).toMatch(/3/);
    expect(message).toMatch(/writer_circuit_break/);
    expect(message).toMatch(/outro agente|roster/i);
  });

  it('mortalidade 3 loga writer_circuit_break e recusa remint do CLI', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordWorkerDeathWithoutDelivery('mission-1', 'kimi');
    recordWorkerDeathWithoutDelivery('mission-1', 'kimi');
    expect(
      writerCircuitBroken({
        missionId: 'mission-1',
        adapterId: 'kimi',
        role: 'worker',
      }),
    ).toBe(false);
    recordWorkerDeathWithoutDelivery('mission-1', 'kimi');
    expect(workerMortalityCount('mission-1', 'kimi')).toBe(3);
    expect(
      writerCircuitBreakers.canSeat({
        adapterId: 'kimi',
        role: 'worker',
        missionId: 'mission-1',
      }),
    ).toBe(false);
    expect(
      writerCircuitBroken({
        missionId: 'mission-1',
        adapterId: 'kimi',
        role: 'worker',
      }),
    ).toBe(true);
    expect(
      warn.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes('writer_circuit_break')),
      ),
    ).toBe(true);
    warn.mockRestore();
  });
});


describe('workerPaneHasDelivery — exit pós-handoff não é mortalidade', () => {
  const frontendHandoff = {
    sessionId: 'pty-mszdgawi-14',
    fromAgent: 'Frontend',
  };

  it('casa por sessionId mesmo sem nome', () => {
    expect(
      workerPaneHasDelivery(
        { sessionId: 'pty-mszdgawi-14' },
        [frontendHandoff],
      ),
    ).toBe(true);
  });

  it('AGY one-shot: sessionId some depois do exit, agentName ainda casa', () => {
    expect(
      workerPaneHasDelivery(
        { sessionId: null, agentName: 'Frontend', title: 'Frontend' },
        [frontendHandoff],
      ),
    ).toBe(true);
  });

  it('Reviewer one-shot: title/agentName casam com fromAgent', () => {
    expect(
      workerPaneHasDelivery(
        { sessionId: undefined, agentName: 'Reviewer', title: 'Reviewer' },
        [{ sessionId: 'pty-review', fromAgent: 'Reviewer' }],
      ),
    ).toBe(true);
  });

  it('QA morto sem handoff próprio continua sem entrega', () => {
    expect(
      workerPaneHasDelivery(
        { sessionId: null, agentName: 'QA', title: 'QA' },
        [frontendHandoff, { fromAgent: 'nexus-delegation-supervisor' }],
      ),
    ).toBe(false);
  });

  it('handoff sintético nexus-* nunca é prova de vida', () => {
    expect(
      workerPaneHasDelivery(
        { sessionId: 'pty-dead', agentName: 'Frontend' },
        [{ sessionId: 'pty-dead', fromAgent: 'nexus-handoff-enforcement' }],
      ),
    ).toBe(false);
  });
});

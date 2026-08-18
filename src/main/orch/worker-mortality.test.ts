import { beforeEach, describe, expect, it } from 'vitest';
import {
  WORKER_MORTALITY_CIRCUIT_BREAK,
  recordWorkerDeathWithoutDelivery,
  recordAdapterProofOfLife,
  resetMissionWorkerMortality,
  shouldTripWorkerMortalityBreaker,
  workerMortalityCount,
  workerMortalityBreakerMessage,
} from './worker-mortality';

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
    expect(message).toMatch(/outro agente|roster/i);
  });
});

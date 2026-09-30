import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_MORTALITY_CIRCUIT_BREAK,
  recordAdapterProofOfLife,
  recordWorkerDeathWithoutDelivery,
  resetMissionWorkerMortality,
  workerMortalityCount,
} from './worker-mortality';

/**
 * Campanha 0.50 (A1/A2): integração do circuit breaker de mortalidade.
 * O watcher conta worker morto-sem-entrega; a N, o spawn de worker daquele
 * adapter é recusado com motivo acionável — fim do loop de respawn do
 * missão real (pane 6× morto, 13/20 workers sem um turno).
 */

const pty = vi.hoisted(() => ({
  live: new Set<string>(),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock('../pty/pty-manager', () => ({
  getSessionState: vi.fn((sessionId: string) =>
    pty.live.has(sessionId) ? 'idle' : null,
  ),
  isSessionOwnedBy: vi.fn(() => false),
  getAgentSessionInfo: vi.fn(() => null),
  getOwnedAgentSessionInfo: vi.fn(() => null),
  listAgentSessionsForPane: vi.fn(() => []),
  orchKillSession: vi.fn(() => true),
  orchTerminateSession: vi.fn(async () => true),
  orchWriteSession: vi.fn(() => true),
  detachOwnedMissionAgentSession: vi.fn(() => true),
  spawnMainOwnedAgentSession: vi.fn(),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

import { requestPaneSpawn } from './pane-registry';

function spawnRequest(overrides: Record<string, unknown> = {}) {
  const request: Record<string, unknown> = {
    missionId: 'mission-breaker',
    role: 'worker',
    adapterId: 'glm',
    agentName: 'Implementar motor',
    ...overrides,
  };
  return requestPaneSpawn(
    request as unknown as Parameters<typeof requestPaneSpawn>[0],
  );
}

beforeEach(() => {
  resetMissionWorkerMortality('mission-breaker');
});

describe('circuit breaker de mortalidade no spawn de worker', () => {
  it('abaixo de N mortes o spawn segue o caminho normal', async () => {
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK - 1; i += 1) {
      recordWorkerDeathWithoutDelivery('mission-breaker', 'glm');
    }
    const result = await spawnRequest();
    expect(result.error).not.toMatch(/circuit breaker/);
  });

  it('com N mortes sem entrega o spawn é recusado com motivo acionável', async () => {
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK; i += 1) {
      recordWorkerDeathWithoutDelivery('mission-breaker', 'glm');
    }
    const result = await spawnRequest();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/circuit breaker de mortalidade/);
    expect(result.error).toMatch(/glm/);
    expect(result.error).toMatch(/outro agente/);
  });

  it('orquestrador nunca é recusado pelo breaker', async () => {
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK; i += 1) {
      recordWorkerDeathWithoutDelivery('mission-breaker', 'glm');
    }
    const result = await spawnRequest({ role: 'orchestrator' });
    expect(result.error).not.toMatch(/circuit breaker/);
  });

  it('prova de vida (entrega) reabre o circuito', async () => {
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK; i += 1) {
      recordWorkerDeathWithoutDelivery('mission-breaker', 'glm');
    }
    recordAdapterProofOfLife('mission-breaker', 'glm');
    expect(workerMortalityCount('mission-breaker', 'glm')).toBe(0);
    const result = await spawnRequest();
    expect(result.error).not.toMatch(/circuit breaker/);
  });

  it('outra missão não herda o breaker', async () => {
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK; i += 1) {
      recordWorkerDeathWithoutDelivery('mission-breaker', 'glm');
    }
    const result = await spawnRequest({ missionId: 'mission-vizinha' });
    expect(result.error).not.toMatch(/circuit breaker/);
  });
});

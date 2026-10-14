import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_MORTALITY_CIRCUIT_BREAK,
  isSpontaneousWorkerDeath,
  recordAdapterProofOfLife,
  recordWorkerDeathWithoutDelivery,
  resetMissionWorkerMortality,
  workerMortalityCount,
} from './worker-mortality';
import {
  __resetDeliberatelyClosedPanesForTests,
  markPaneDeliberatelyClosed,
  paneSessionExitObservedAt,
  recordPaneSessionExit,
  wasPaneDeliberatelyClosed,
  wasPaneSessionExitObserved,
} from './pane-session-output';

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

  /**
   * F-1480: a régua do watcher (mission-fast-lane) sobre a saída de cada pane
   * — a mesma entrada de `isSpontaneousWorkerDeath` que ele monta.
   */
  function watcherCountsDeath(paneId: string, sessionId: string): boolean {
    recordPaneSessionExit(sessionId);
    const dead = isSpontaneousWorkerDeath({
      state: 'exited',
      exitObserved: wasPaneSessionExitObserved(sessionId),
      deliberatelyClosed: wasPaneDeliberatelyClosed(paneId, paneSessionExitObservedAt(sessionId)),
    });
    if (dead) recordWorkerDeathWithoutDelivery('mission-breaker', 'glm');
    return dead;
  }

  it('F-1480: N trocas de conta seguidas não alimentam o breaker', async () => {
    __resetDeliberatelyClosedPanesForTests();
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK + 1; i += 1) {
      // O respawn marca o pane exausto ANTES de pedir a terminação.
      markPaneDeliberatelyClosed(`f1480-old-${i}`);
      expect(watcherCountsDeath(`f1480-old-${i}`, `f1480-session-${i}`)).toBe(false);
    }
    expect(workerMortalityCount('mission-breaker', 'glm')).toBe(0);
    const result = await spawnRequest();
    expect(result.error ?? '').not.toMatch(/circuit breaker/);
  });

  it('F-1480 (controle): sem a marca do respawn, as mesmas saídas abrem o breaker', async () => {
    __resetDeliberatelyClosedPanesForTests();
    for (let i = 0; i < WORKER_MORTALITY_CIRCUIT_BREAK; i += 1) {
      expect(watcherCountsDeath(`f1480-crash-${i}`, `f1480-crash-session-${i}`)).toBe(true);
    }
    const result = await spawnRequest();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/circuit breaker de mortalidade/);
  });
});

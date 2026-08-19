import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * First-wave: after 3 failures to become connected+writable, Kimi must not
 * get a 4th worker seat. Spawn refuses at the pane-registry boundary.
 */

const pty = vi.hoisted(() => ({
  live: new Set<string>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: vi.fn((sessionId: string) =>
    pty.live.has(sessionId) ? 'idle' : null,
  ),
  isSessionStdinWritable: vi.fn((sessionId: string) => pty.live.has(sessionId)),
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
import { writerCircuitBreakers } from './writer-circuit-break';
import {
  recordWorkerDeathWithoutDelivery,
  resetMissionWorkerMortality,
} from './worker-mortality';
import { resetWriterCircuitForTests } from './writer-circuit-breaker';

const kimiWorker = {
  adapterId: 'kimi',
  role: 'worker',
  missionId: 'mission-kimi-circuit',
} as const;

function spawnKimi(overrides: Record<string, unknown> = {}) {
  return requestPaneSpawn({
    missionId: kimiWorker.missionId,
    role: 'worker',
    adapterId: 'kimi',
    agentName: 'Kimi',
    ...overrides,
  } as unknown as Parameters<typeof requestPaneSpawn>[0]);
}

beforeEach(() => {
  writerCircuitBreakers.reset();
  resetWriterCircuitForTests();
  resetMissionWorkerMortality(kimiWorker.missionId);
});

afterEach(() => {
  writerCircuitBreakers.reset();
});

describe('circuit-break 3 — Kimi não é re-sentada', () => {
  it('abaixo de 3 falhas o spawn de worker segue', async () => {
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    const result = await spawnKimi();
    expect(result.error).not.toMatch(/writer_circuit_break/);
  });

  it('na 3ª morte recusa o 4º assento com writer_circuit_break', async () => {
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    const fourth = await spawnKimi();
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toMatch(/writer_circuit_break/);
    expect(fourth.error).toMatch(/kimi/);
    const again = await spawnKimi();
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/writer_circuit_break/);
  });

  it('orquestrador nunca é recusado por este breaker', async () => {
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    const result = await spawnKimi({ role: 'orchestrator' });
    expect(result.error).not.toMatch(/writer_circuit_break/);
  });

  it('mortalidade 3 recusa o 4º assento Kimi com writer_circuit_break', async () => {
    recordWorkerDeathWithoutDelivery(kimiWorker.missionId, 'kimi');
    recordWorkerDeathWithoutDelivery(kimiWorker.missionId, 'kimi');
    recordWorkerDeathWithoutDelivery(kimiWorker.missionId, 'kimi');
    const fourth = await spawnKimi();
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toMatch(/writer_circuit_break/);
    expect(fourth.error).toMatch(/kimi/);
  });

  it('outro adapter autenticado ainda pode sentar', async () => {
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    const result = await spawnKimi({ adapterId: 'codex', agentName: 'Codex' });
    expect(result.error).not.toMatch(/writer_circuit_break/);
  });
});

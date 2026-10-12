import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';

/**
 * Guardian × status semântico REAIS (agent-status não é dublê aqui): só o PTY
 * (estado da sessão) é ambiente. Regressão da rodada 6 — o fechamento de
 * diálogo abandonado valia para qualquer pane, inclusive no reaper de pressão.
 */
const pty = vi.hoisted(() => ({ state: 'idle' as string | null }));
vi.mock('../pty/pty-manager', () => ({
  publishSessionActivityState: () => true,
  getAgentSessionInfo: () => null,
  getSessionState: () => pty.state,
  isOneShotSessionRunning: () => false,
  tapSessionExit: () => () => {},
}));

import { __resetAgentStatusForTests, applyCanonicalHookEvent, isSessionIdleForCleanup, isSessionInAbandonedDialog } from './agent-status';
import {
  initNonWorkerAutoClose,
  shutdownNonWorkerAutoClose,
  sweepIdlePanes,
  type NonWorkerAutoCloseDeps,
  type NonWorkerPaneRef,
} from './pane-non-worker-auto-close';

const permission: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'permission_prompt',
  message: 'Claude needs your permission to run Bash',
};

const REFS: Record<string, NonWorkerPaneRef> = {
  humano: { paneId: 'pane-humano', sessionId: 'humano', role: undefined },
  missao: { paneId: 'pane-missao', sessionId: 'missao', role: 'worker', missionId: 'mission-1' },
  helper: { paneId: 'pane-helper', sessionId: 'helper', role: undefined, operatorParentSessionId: 'humano' },
};

function deps(input: { pressure: boolean; delivered: Set<string>; parked: string[] }): NonWorkerAutoCloseDeps {
  return {
    isEnabled: () => true,
    getPaneRef: (sessionId) => REFS[sessionId] ?? null,
    isIdle: isSessionIdleForCleanup,
    isAbandonedDialog: isSessionInAbandonedDialog,
    hasDeliveredSuccess: (sessionId) => input.delivered.has(sessionId),
    closePane: (paneId) => {
      input.parked.push(paneId);
      return true;
    },
    parkPane: (paneId) => {
      input.parked.push(paneId);
      return 'parked';
    },
    ttlMs: 30 * 60_000,
    log: () => {},
    listIdleSessions: () => Object.keys(REFS),
    isUnderMemoryPressure: () => input.pressure,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetAgentStatusForTests();
  pty.state = 'idle';
  for (const sessionId of Object.keys(REFS)) {
    applyCanonicalHookEvent({ sessionId, event: permission });
  }
});
afterEach(async () => {
  await shutdownNonWorkerAutoClose();
  vi.useRealTimers();
});

describe('pane guardian — diálogo abandonado', () => {
  it('sob pressão de memória não estaciona pane humano nem worker de missão parados num diálogo há 11 min', async () => {
    const parked: string[] = [];
    const guardian = deps({ pressure: true, delivered: new Set(), parked });
    initNonWorkerAutoClose(guardian);
    await sweepIdlePanes(guardian);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await sweepIdlePanes(guardian);
    await sweepIdlePanes(guardian);
    await sweepIdlePanes(guardian);

    expect(parked).toEqual([]);
  });

  it('pelo TTL, fecha só o helper que já entregou com sucesso', async () => {
    const parked: string[] = [];
    const delivered = new Set<string>();
    const guardian = deps({ pressure: false, delivered, parked });
    initNonWorkerAutoClose(guardian);
    await sweepIdlePanes(guardian);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await sweepIdlePanes(guardian);
    expect(parked).toEqual([]);

    delivered.add('helper');
    delivered.add('humano');
    delivered.add('missao');
    await sweepIdlePanes(guardian);
    expect(parked).toEqual(['pane-helper']);
  });
});

/**
 * Onda 1 (leitores sem efeito) da religação da liderança única: os leitores
 * puros de `mission-fast-lane.ts` (`liveOrchestratorSessionId`,
 * `resolveFastLaneOrchestratorPaneSummary`) passam a consumir
 * `resolveMissionLeader` em vez de reimplementar liveness/role por conta
 * própria. `source:'live'` isolado nunca é tratado como prova; split-brain
 * nunca é engolido (docs/analysis/2026-09-16-plano-religacao-lideranca.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionLeader } from './mission-leadership';

const harness = vi.hoisted(() => ({
  snapshots: [] as Array<{
    missionId: string;
    paneId?: string;
    sessionId: string;
    role?: 'orchestrator' | 'worker';
    agentName?: string;
    adapterId?: string;
    title?: string;
    scope?: ProjectExecutionScope;
  }>,
  sessionStates: new Map<string, string | null>(),
  resolveMissionLeader: vi.fn<(scope: ProjectExecutionScope, missionId: string) => MissionLeader | null>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) => harness.sessionStates.get(sessionId) ?? null,
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => harness.snapshots,
}));

vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => ({ resolveMissionLeader: harness.resolveMissionLeader }),
}));

import { MissionLeadershipError } from './mission-leadership';
import {
  fastLaneOrchestratorPaneSummary,
  liveOrchestratorSessionId,
  resolveFastLaneOrchestratorPaneSummary,
} from './mission-fast-lane';

const scope = testProjectScope();
const missionId = 'mission-1';

beforeEach(() => {
  harness.snapshots = [];
  harness.sessionStates = new Map();
  harness.resolveMissionLeader.mockReset();
});

describe('liveOrchestratorSessionId', () => {
  it('devolve o sessionId provado quando A e C concordam (com scope no snapshot)', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-old', paneId: 'pane-1', role: 'orchestrator', scope },
    ];
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'durable', proven: true,
    });
    expect(liveOrchestratorSessionId(missionId)).toBe('session-1');
    expect(harness.resolveMissionLeader).toHaveBeenCalledWith(scope, missionId);
  });

  it('devolve null quando o líder não está provado (A morto)', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-old', paneId: 'pane-1', role: 'orchestrator', scope },
    ];
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'live', proven: false,
    });
    expect(liveOrchestratorSessionId(missionId)).toBeNull();
  });

  it('devolve null quando não há líder nenhum', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-old', paneId: 'pane-1', role: 'orchestrator', scope },
    ];
    harness.resolveMissionLeader.mockReturnValue(null);
    expect(liveOrchestratorSessionId(missionId)).toBeNull();
  });

  it('nunca engole split-brain: propaga o erro tipado', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-old', paneId: 'pane-1', role: 'orchestrator', scope },
    ];
    harness.resolveMissionLeader.mockImplementation(() => {
      throw new MissionLeadershipError('split_brain', { missionId, sessionIds: ['session-1', 'session-2'] });
    });
    expect(() => liveOrchestratorSessionId(missionId)).toThrow(MissionLeadershipError);
    expect(() => liveOrchestratorSessionId(missionId)).toThrow(/split_brain/);
  });

  it('sem scope no snapshot (fixture legado), cai no heurístico físico sem consultar o resolver', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-legacy', paneId: 'pane-1', role: 'orchestrator' },
    ];
    harness.sessionStates.set('session-legacy', 'idle');
    expect(liveOrchestratorSessionId(missionId)).toBe('session-legacy');
    expect(harness.resolveMissionLeader).not.toHaveBeenCalled();
  });
});

describe('fastLaneOrchestratorPaneSummary (acessor cru de B)', () => {
  it('nunca chama o resolver — só projeta o snapshot local', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-1', paneId: 'pane-1', role: 'orchestrator', agentName: 'Maestro', adapterId: 'claude' },
    ];
    const summary = fastLaneOrchestratorPaneSummary(scope, missionId);
    expect(summary).toMatchObject({ paneId: 'pane-1', sessionId: 'session-1' });
    expect(harness.resolveMissionLeader).not.toHaveBeenCalled();
  });
});

describe('resolveFastLaneOrchestratorPaneSummary (leitor público)', () => {
  it('projeta metadados do par provado quando A e C concordam', () => {
    harness.snapshots = [
      { missionId, sessionId: 'session-1', paneId: 'pane-1', role: 'orchestrator', agentName: 'Maestro', adapterId: 'claude' },
    ];
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'durable', proven: true,
    });
    expect(resolveFastLaneOrchestratorPaneSummary(scope, missionId)).toMatchObject({
      sessionId: 'session-1', paneId: 'pane-1', role: 'orchestrator', agentName: 'Maestro',
    });
  });

  it('devolve null quando o líder não está provado (A morto)', () => {
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'live', proven: false,
    });
    expect(resolveFastLaneOrchestratorPaneSummary(scope, missionId)).toBeNull();
  });

  it('devolve null quando não há líder', () => {
    harness.resolveMissionLeader.mockReturnValue(null);
    expect(resolveFastLaneOrchestratorPaneSummary(scope, missionId)).toBeNull();
  });

  it('nunca engole split-brain: devolve o code em errorCode, não escolhe por ordem de array', () => {
    harness.resolveMissionLeader.mockImplementation(() => {
      throw new MissionLeadershipError('split_brain', { missionId, sessionIds: ['session-1', 'session-2'] });
    });
    expect(resolveFastLaneOrchestratorPaneSummary(scope, missionId)).toEqual({ errorCode: 'split_brain' });
  });
});

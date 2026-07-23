import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { PaneSessionState, ProjectExecutionScope } from '../../shared/types';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';

const runtime = vi.hoisted(() => ({
  state: 'idle' as PaneSessionState | null,
  writes: [] as string[],
  stateTaps: [] as Array<(sessionId: string, state: PaneSessionState) => void>,
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  mission: null as Mission | null,
  receipt: null as null | {
    missionId: string;
    intentVersion: number;
    orchestratorSessionId: string;
    promptHash: string;
  },
  receiptWrites: 0,
  scope: null as ProjectExecutionScope | null,
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: vi.fn((sessionId: string) => ({
    sessionId,
    role: 'orchestrator',
    missionId: runtime.mission?.id,
    scope: runtime.scope,
  })),
  getSessionState: vi.fn(() => runtime.state),
  orchWriteSession: vi.fn((sessionId: string, data: string) => {
    runtime.writes.push(data);
    if (data === '\r') {
      for (const tap of runtime.dataTaps) tap(sessionId, 'CLI iniciou a missão');
      runtime.state = 'busy';
      for (const tap of runtime.stateTaps) tap(sessionId, 'busy');
    }
    return true;
  }),
  tapSessionState: vi.fn(
    (tap: (sessionId: string, state: PaneSessionState) => void) => {
      runtime.stateTaps.push(tap);
      return () => {
        const index = runtime.stateTaps.indexOf(tap);
        if (index >= 0) runtime.stateTaps.splice(index, 1);
      };
    },
  ),
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    runtime.dataTaps.push(tap);
    return () => {
      const index = runtime.dataTaps.indexOf(tap);
      if (index >= 0) runtime.dataTaps.splice(index, 1);
    };
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    runtime.exitTaps.push(tap);
    return () => {
      const index = runtime.exitTaps.indexOf(tap);
      if (index >= 0) runtime.exitTaps.splice(index, 1);
    };
  }),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    missions: {
      get: (missionId: string) =>
        runtime.mission?.id === missionId ? runtime.mission : null,
      update: vi.fn(),
      hasExactCurrentKickoffAcceptance: (input: typeof runtime.receipt) =>
        runtime.receipt !== null && input !== null &&
        runtime.receipt.missionId === input.missionId &&
        runtime.receipt.intentVersion === input.intentVersion &&
        runtime.receipt.orchestratorSessionId === input.orchestratorSessionId &&
        runtime.receipt.promptHash === input.promptHash,
      hasCurrentKickoffAcceptance: (missionId: string) =>
        runtime.receipt?.missionId === missionId &&
        runtime.receipt.intentVersion === runtime.mission?.intentVersion &&
        runtime.receipt.orchestratorSessionId ===
          runtime.mission?.orchestratorSessionId,
      recordKickoffAcceptance: (input: NonNullable<typeof runtime.receipt>) => {
        runtime.receiptWrites += 1;
        runtime.receipt = { ...input };
        return input;
      },
    },
  })),
}));

vi.mock('./gate', () => ({
  getContextBySession: vi.fn((sessionId: string) => ({
    token: 'gate-token',
    label: 'orchestrator',
    role: 'orchestrator',
    sessionId,
    missionId: runtime.mission?.id,
    scope: runtime.scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  })),
}));

vi.mock('./pane-registry', () => ({
  getPaneRuntimeAuthorityBySession: vi.fn((sessionId: string) => ({
    paneId: 'pane-orchestrator',
    sessionId,
    kind: 'cli-agent',
    owner: null,
    role: 'orchestrator',
    missionId: runtime.mission?.id,
    scope: runtime.scope,
  })),
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireRendererWorkspaceScope: vi.fn(),
}));

vi.mock('./squad-store', () => ({
  getSquad: vi.fn(),
}));

import { submitMissionKickoffFromMain } from './mission-kickoff';

describe('durable kickoff replay boundary', () => {
  beforeEach(() => {
    runtime.scope = testProjectScope({ checkoutId: 'kickoff-replay' });
    const contract = compileIntentContract({
      goal: 'Executar uma missão real exatamente uma vez',
      acceptanceCriteria: ['Kickoff aceito com prova durável'],
      intentVersion: 1,
    });
    runtime.mission = {
      id: 'mission-kickoff-replay',
      title: 'Kickoff replay',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: {
        ...contract,
        approvedAt: 1,
        dispatchedAt: 2,
      },
      orchestratorSessionId: 'session-kickoff-replay',
      createdAt: 1,
      updatedAt: 2,
    };
    runtime.state = 'idle';
    runtime.writes.length = 0;
    runtime.stateTaps.length = 0;
    runtime.dataTaps.length = 0;
    runtime.exitTaps.length = 0;
    runtime.receipt = null;
    runtime.receiptWrites = 0;
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('replays an exact accepted request without a second paste or Enter', async () => {
    const request = {
      missionId: 'mission-kickoff-replay',
      sessionId: 'session-kickoff-replay',
      prompt: 'Execute somente a missão aprovada.',
    };

    const first = submitMissionKickoffFromMain(runtime.scope!, request);
    await vi.advanceTimersByTimeAsync(250);
    await expect(first).resolves.toEqual({ accepted: true });

    await expect(
      submitMissionKickoffFromMain(runtime.scope!, request),
    ).resolves.toEqual({ accepted: true });

    expect(runtime.writes).toEqual([
      expect.stringContaining(request.prompt),
      '\r',
    ]);
    expect(runtime.receiptWrites).toBe(1);
  });
});

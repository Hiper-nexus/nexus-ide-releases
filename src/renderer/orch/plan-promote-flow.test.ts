import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mission } from '../../shared/orch-types';

const mocks = vi.hoisted(() => ({
  askConfirm: vi.fn(async () => true),
  promotePlanLane: vi.fn(),
  ensure: vi.fn(async () => 'injected' as const),
  bump: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: mocks.askConfirm,
}));
vi.mock('../state/plan-lane-metrics-store', () => ({
  bumpPlanLaneMetric: mocks.bump,
  usePlanLaneMetricsStore: {
    getState: () => ({
      notePlanPromoted: mocks.bump,
    }),
  },
}));
vi.mock('../state/toast-store', () => ({
  useToastStore: {
    getState: () => ({ push: mocks.push }),
  },
}));
vi.mock('./plan-promote-notify', () => ({
  ensureOrchestratorAfterPlanPromote: mocks.ensure,
}));

import { promotePlanMissionToExecution } from './plan-promote-flow';

function planMission(): Mission {
  return {
    id: 'm-plan',
    title: 'Auth plan',
    description: 'Desenhar auth',
    status: 'running',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'Desenhar auth',
      acceptanceCriteria: ['plan.md'],
      risk: 'normal',
      executionMode: 'autopilot',
      lane: 'plan',
      intentVersion: 1,
      budgets: {
        planningTokens: 8000,
        executionTokens: 6000,
        maxWorkers: 0,
        maxSteps: 64,
      },
    },
  };
}

describe('promotePlanMissionToExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.askConfirm.mockResolvedValue(true);
    mocks.promotePlanLane.mockResolvedValue({
      ...planMission(),
      intentContract: {
        ...planMission().intentContract!,
        lane: 'standard',
      },
    });
    // @ts-expect-error test stub
    globalThis.window = {
      nexus: {
        orch: { promotePlanLane: mocks.promotePlanLane },
      },
    };
  });

  it('skips confirm when skipConfirm is true', async () => {
    const result = await promotePlanMissionToExecution(planMission(), {
      skipConfirm: true,
    });
    expect(mocks.askConfirm).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(mocks.bump).toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith(
      'success',
      'Plano → código',
      expect.stringContaining('PREVC'),
    );
  });

  it('rejects concurrent promote of the same mission', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mocks.promotePlanLane.mockImplementation(async () => {
      await gate;
      return {
        ...planMission(),
        intentContract: { ...planMission().intentContract!, lane: 'standard' },
      };
    });
    const m = planMission();
    const a = promotePlanMissionToExecution(m, { skipConfirm: true });
    const b = await promotePlanMissionToExecution(m, { skipConfirm: true });
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/em curso/i);
    release();
    await a;
  });

  it('returns cancelled when operator declines confirm', async () => {
    mocks.askConfirm.mockResolvedValue(false);
    const result = await promotePlanMissionToExecution(planMission());
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(mocks.promotePlanLane).not.toHaveBeenCalled();
  });

  it('rejects non-plan missions', async () => {
    const m = planMission();
    const result = await promotePlanMissionToExecution({
      ...m,
      intentContract: { ...m.intentContract!, lane: 'standard' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lane plan/i);
  });
});

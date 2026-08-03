import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mission } from '../../shared/orch-types';

const mocks = vi.hoisted(() => ({
  promotePlanLane: vi.fn(),
  bump: vi.fn(),
  push: vi.fn(),
  askMode: vi.fn(),
  handoffs: [] as Array<{ missionId: string; status: string; summary: string }>,
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
vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      missions: [],
      handoffs: mocks.handoffs,
    }),
  },
}));
vi.mock('../state/orchestration-mode-store', () => ({
  askPromoteOrchestrationMode: (...args: unknown[]) => mocks.askMode(...args),
}));
import { promotePlanMissionToExecution } from './plan-promote-flow';

function planMission(): Mission {
  return {
    id: 'm-plan',
    title: 'Auth plan',
    description: 'Desenhar auth',
    status: 'pending',
    intentState: 'ready_to_start',
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
      contextPolicy: 'on-demand',
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
    mocks.handoffs.length = 0;
    mocks.askMode.mockResolvedValue({ mode: 'pack', wavePackTemplateId: 'landing' });
    mocks.promotePlanLane.mockResolvedValue({
      ...planMission(),
      status: 'running',
      intentContract: {
        ...planMission().intentContract!,
        lane: 'standard',
      },
    });
    globalThis.window = {
      nexus: {
        orch: { promotePlanLane: mocks.promotePlanLane },
      },
    } as unknown as Window & typeof globalThis;
  });

  it('asks Pack vs Guiado even without BMAD stories (Wave 2 templates)', async () => {
    const result = await promotePlanMissionToExecution(planMission());
    expect(result.ok).toBe(true);
    expect(mocks.askMode).toHaveBeenCalledOnce();
    expect(mocks.promotePlanLane).toHaveBeenCalledWith({
      missionId: 'm-plan',
      orchestrationMode: 'pack',
      wavePackTemplateId: 'landing',
    });
    expect(mocks.bump).toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith(
      'success',
      'Plano → código',
      expect.stringContaining('nova sessão'),
    );
  });

  it('asks Pack vs Guiado when the plan has ≥2 stories', async () => {
    mocks.handoffs.push({
      missionId: 'm-plan',
      status: 'success',
      summary: '### Story 1.1: A\n\n### Story 1.2: B\n',
    });
    mocks.askMode.mockResolvedValueOnce({ mode: 'guided' });
    const result = await promotePlanMissionToExecution(planMission());
    expect(result.ok).toBe(true);
    expect(mocks.askMode).toHaveBeenCalledOnce();
    expect(mocks.promotePlanLane).toHaveBeenCalledWith({
      missionId: 'm-plan',
      orchestrationMode: 'guided',
    });
  });

  it('cancels when the operator dismisses the mode picker', async () => {
    mocks.handoffs.push({
      missionId: 'm-plan',
      status: 'success',
      summary: '### Story 1.1: A\n\n### Story 1.2: B\n',
    });
    mocks.askMode.mockResolvedValueOnce(null);
    const result = await promotePlanMissionToExecution(planMission());
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(mocks.promotePlanLane).not.toHaveBeenCalled();
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
    const a = promotePlanMissionToExecution(m);
    const b = await promotePlanMissionToExecution(m);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/em curso/i);
    release();
    await a;
  });

  it('promotes an already-dispatched plan through the main-owned runtime restart', async () => {
    mocks.askMode.mockResolvedValueOnce({ mode: 'guided' });
    const mission = {
      ...planMission(),
      status: 'running' as const,
      intentState: 'executing' as const,
      orchestratorSessionId: 'pty-plan-v1',
      intentContract: {
        ...planMission().intentContract!,
        approvedAt: 100,
        dispatchedAt: 101,
      },
    };

    const result = await promotePlanMissionToExecution(mission);

    expect(result.ok).toBe(true);
    expect(mocks.promotePlanLane).toHaveBeenCalledWith({
      missionId: mission.id,
      orchestrationMode: 'guided',
    });
    expect(mocks.push).toHaveBeenCalledWith(
      'success',
      'Plano → código',
      expect.stringContaining('nova sessão'),
    );
  });

  it('surfaces denial from the single native authority boundary', async () => {
    mocks.askMode.mockResolvedValueOnce({ mode: 'guided' });
    mocks.promotePlanLane.mockRejectedValueOnce(new Error('user_denied'));
    const result = await promotePlanMissionToExecution(planMission());
    expect(result).toEqual({ ok: false, error: 'user_denied' });
    expect(mocks.promotePlanLane).toHaveBeenCalledTimes(1);
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

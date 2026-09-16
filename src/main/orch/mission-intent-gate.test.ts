// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { PREPARE_PROJECT_PLACEHOLDER_GOAL } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionLeaderGateResult } from './mission-leader-gate';

const requireMissionLeaderSession = vi.fn<
  (scope: unknown, missionId: string, ctx: { sessionId?: string | null }) => MissionLeaderGateResult
>();
vi.mock('./mission-leader-gate', () => ({
  requireMissionLeaderSession,
}));

const { assertMissionIntentAllowsTool } = await import('./mission-intent-gate');

const awaitingGoal: Mission = {
  id: 'm1',
  title: 'NavalhaGO',
  description: '',
  status: 'pending',
  squadId: 'navalha',
  milestones: [],
  learnings: '',
  intentState: 'awaiting_goal',
  intentVersion: 0,
  createdAt: 1,
  updatedAt: 1,
};

const dispatched: Mission = {
  ...awaitingGoal,
  status: 'running',
  description: 'Corrigir bug do formulário',
  intentState: 'dispatched',
  intentVersion: 1,
  intentContract: {
    version: 1,
    source: 'typed',
    goal: 'Corrigir bug do formulário',
    acceptanceCriteria: ['Form salva'],
    risk: 'normal',
    executionMode: 'assisted',
    contextPolicy: 'on-demand',
    intentVersion: 1,
    approvedAt: 100,
    budgets: {
      planningTokens: 1200,
      executionTokens: 8000,
      maxWorkers: 2,
      maxSteps: 200,
    },
  },
};

describe('mission intent gate', () => {
  it('allows an idempotent done request only from the proven current mission leader', () => {
    const scope = testProjectScope();
    requireMissionLeaderSession.mockImplementation((_scope, _missionId, ctx: { sessionId?: string | null }) =>
      ctx.sessionId === 'current-session'
        ? { ok: true, leader: { sessionId: 'current-session', paneId: 'pane-1', source: 'durable', proven: true } }
        : { ok: false, code: 'stale-session', hint: 'reabra a missão' },
    );
    const done: Mission = { ...dispatched, status: 'done', intentState: 'done', orchestratorSessionId: 'current-session' };
    const current = { mission: done, role: 'orchestrator', sessionId: 'current-session', scope };

    expect(assertMissionIntentAllowsTool('nexus_mission_set_status', current, { status: 'done', push: {} }).ok).toBe(true);
    for (const rejected of [
      { ...current, role: 'worker' },
      { ...current, sessionId: 'old-session' },
      { ...current, sessionId: undefined },
      { ...current, mission: { ...done, orchestratorSessionId: undefined } },
      { ...current, scope: undefined },
    ]) {
      expect(assertMissionIntentAllowsTool('nexus_mission_set_status', rejected, { status: 'done' }).ok).toBe(false);
    }
    expect(assertMissionIntentAllowsTool('nexus_mission_set_status', current, { status: 'running' }).ok).toBe(false);
    expect(assertMissionIntentAllowsTool('nexus_pane_spawn', current).ok).toBe(false);
    expect(assertMissionIntentAllowsTool('nexus_terminal_run', current).ok).toBe(false);
  });

  it('denies context_doctor before a goal exists', () => {
    const result = assertMissionIntentAllowsTool('nexus_context_doctor', {
      mission: awaitingGoal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('intent_required');
    }
  });

  it('denies pane_spawn before dispatch', () => {
    const result = assertMissionIntentAllowsTool('nexus_pane_spawn', {
      mission: awaitingGoal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('dispatch_required');
    }
  });

  it('allows bootstrap and delegation after dispatch', () => {
    expect(
      assertMissionIntentAllowsTool('nexus_context_doctor', {
        mission: dispatched,
      }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', {
        mission: dispatched,
      }).ok,
    ).toBe(true);
  });

  it('allows mission_set_status to transition pending mission to running when intent is dispatched', () => {
    const pendingDispatched: Mission = {
      ...dispatched,
      status: 'pending',
    };
    expect(
      assertMissionIntentAllowsTool(
        'nexus_mission_set_status',
        { mission: pendingDispatched },
        { status: 'running' },
      ).ok,
    ).toBe(true);
  });

  it('consult lane allows reads, diagnostics and spawn; only explicit contract denies block', () => {
    const consult: Mission = {
      ...dispatched,
      description: 'Ler logs da Vercel',
      intentContract: {
        ...dispatched.intentContract!,
        goal: 'Ler logs da Vercel',
        lane: 'consult',
        budgets: {
          planningTokens: 2000,
          executionTokens: 4000,
          maxWorkers: 0,
          maxSteps: 32,
        },
      },
    };

    expect(
      assertMissionIntentAllowsTool('nexus_file_read', { mission: consult }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_git_status', { mission: consult }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_get', { mission: consult }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_set_status', {
        mission: consult,
      }).ok,
    ).toBe(true);
    // Basic mission tools must work in any lane once the mission is running.
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission: consult }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_context_doctor', { mission: consult }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_terminal_run', { mission: consult }).ok,
    ).toBe(true);

    // Explicitly denied tools or tools without a running mission still fail.
    const denied: Mission = {
      ...consult,
      intentContract: {
        ...consult.intentContract!,
        deniedTools: ['nexus_file_write'],
      },
    };
    expect(
      assertMissionIntentAllowsTool('nexus_file_write', { mission: denied }).ok,
    ).toBe(false);
  });

  it('plan lane allows all basic mission tools once running', () => {
    const plan: Mission = {
      ...awaitingGoal,
      status: 'running',
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: {
        version: 1,
        source: 'typed',
        goal: 'Desenhar a abordagem de auth',
        acceptanceCriteria: ['plan.md com riscos e verificação'],
        risk: 'normal',
        executionMode: 'autopilot',
        lane: 'plan',
        contextPolicy: 'on-demand',
        intentVersion: 1,
        approvedAt: 1,
        dispatchedAt: 1,
        budgets: {
          planningTokens: 8000,
          executionTokens: 6000,
          maxWorkers: 0,
          maxSteps: 64,
        },
      },
    };

    expect(
      assertMissionIntentAllowsTool('nexus_file_read', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_plan_write', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_plan_read', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_file_write', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_terminal_run', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_memory_retain', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_set_status', {
        mission: plan,
      }).ok,
    ).toBe(true);

    // Explicit contract denies still apply.
    const denied: Mission = {
      ...plan,
      intentContract: {
        ...plan.intentContract!,
        deniedTools: ['nexus_git_commit'],
      },
    };
    expect(
      assertMissionIntentAllowsTool('nexus_git_commit', { mission: denied }).ok,
    ).toBe(false);
  });

  it('ops lane allows all basic mission tools once running', () => {
    const ops: Mission = {
      ...dispatched,
      description: 'Fazer backup na VPS e subir a landing page',
      intentContract: {
        ...dispatched.intentContract!,
        goal: 'Fazer backup na VPS e subir a landing page',
        lane: 'ops',
        budgets: {
          planningTokens: 1200,
          executionTokens: 8000,
          maxWorkers: 0,
          maxSteps: 200,
        },
      },
    };

    expect(
      assertMissionIntentAllowsTool('nexus_git_status', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_file_read', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_terminal_run', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_terminal_run', {
        mission: ops,
        role: 'orchestrator',
      }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_bg_run', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_browser_navigate', { mission: ops })
        .ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_image_generate', { mission: ops })
        .ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_memory_retain', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_set_status', {
        mission: ops,
      }).ok,
    ).toBe(true);

    // Explicit contract denies still apply.
    const denied: Mission = {
      ...ops,
      intentContract: {
        ...ops.intentContract!,
        deniedTools: ['nexus_git_commit'],
      },
    };
    expect(
      assertMissionIntentAllowsTool('nexus_git_commit', { mission: denied }).ok,
    ).toBe(false);
  });

  it('Maestro may run terminal commands in any lane once the mission is running', () => {
    const result = assertMissionIntentAllowsTool('nexus_terminal_run', {
      mission: dispatched,
      role: 'orchestrator',
    });

    expect(result.ok).toBe(true);
  });

  it('running mission is enough authority for execution effects', () => {
    const unapprovedOps: Mission = {
      ...dispatched,
      intentContract: {
        ...dispatched.intentContract!,
        lane: 'ops',
        approvedAt: undefined,
        budgets: {
          ...dispatched.intentContract!.budgets,
          maxWorkers: 0,
        },
      },
    };

    const result = assertMissionIntentAllowsTool('nexus_terminal_run', {
      mission: unapprovedOps,
    });
    expect(result.ok).toBe(true);
    // Read-only still passes without explicit approval.
    expect(
      assertMissionIntentAllowsTool('nexus_git_status', {
        mission: unapprovedOps,
      }).ok,
    ).toBe(true);
  });

  it('allows prepare-project warm tools only while awaiting goal', () => {
    const prepare: Mission = {
      ...awaitingGoal,
      // Must match contract.intentVersion for current-contract checks.
      intentVersion: 1,
      intentContract: {
        version: 1,
        source: 'typed',
        goal: PREPARE_PROJECT_PLACEHOLDER_GOAL,
        acceptanceCriteria: ['map warm'],
        risk: 'normal',
        executionMode: 'manual',
        contextPolicy: 'prepare-project',
        intentVersion: 1,
        budgets: {
          planningTokens: 1200,
          executionTokens: 0,
          maxWorkers: 0,
          maxSteps: 10,
        },
      },
    };
    expect(
      assertMissionIntentAllowsTool('nexus_context_doctor', {
        mission: prepare,
      }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_code_map_refresh', {
        mission: prepare,
      }).ok,
    ).toBe(true);
    // Still must not spawn workers or freeze contract before dispatch.
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', {
        mission: prepare,
      }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_freeze_contract', {
        mission: prepare,
      }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_context_draft_apply', {
        mission: prepare,
      }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool(
        'nexus_mission_set_status',
        { mission: prepare },
        { status: 'running' },
      ).ok,
    ).toBe(false);
    // Fail-safe demotion remains allowed without inventing work.
    expect(
      assertMissionIntentAllowsTool(
        'nexus_mission_set_status',
        { mission: prepare },
        { status: 'blocked' },
      ).ok,
    ).toBe(true);
  });

  it('denies effectful tools when mission is missing (fail-closed)', () => {
    const result = assertMissionIntentAllowsTool(
      'nexus_context_doctor',
      {
        mission: awaitingGoal,
        missionMissing: true,
      },
    );
    expect(result.ok).toBe(false);
  });

  it('opens execution for legacy description-only shells once running', () => {
    const legacy: Mission = {
      ...awaitingGoal,
      status: 'running',
      description: 'old free text',
      intentState: 'legacy',
    };
    expect(
      assertMissionIntentAllowsTool('nexus_file_write', { mission: legacy }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission: legacy }).ok,
    ).toBe(true);
  });

  it('requires handoff origin (role + session)', () => {
    expect(
      assertMissionIntentAllowsTool('nexus_handoff_submit', {
        mission: dispatched,
        role: 'worker',
        sessionId: 's1',
      }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_handoff_submit', {
        mission: dispatched,
        role: 'user',
        sessionId: 's1',
      }).ok,
    ).toBe(false);
  });

  it('keeps terminal handoff replay closed until the physical dispatcher proves it', () => {
    const blocked: Mission = {
      ...dispatched,
      status: 'blocked',
    };
    const done: Mission = {
      ...dispatched,
      status: 'done',
    };
    expect(
      assertMissionIntentAllowsTool('nexus_handoff_submit', {
        mission: blocked,
        role: 'worker',
        sessionId: 'worker-session',
      }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_handoff_submit', {
        mission: done,
        role: 'worker',
        sessionId: 'worker-session',
      }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_handoff_submit', {
        mission: blocked,
        role: 'user',
        sessionId: 'worker-session',
      }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_handoff_submit', {
        mission: {
          ...blocked,
          intentContract: {
            ...blocked.intentContract!,
            approvedAt: undefined,
          },
        },
        role: 'worker',
        sessionId: 'worker-session',
      }).ok,
    ).toBe(false);
  });

  it('ledger esgotado não bloqueia tools — steps/tokens são telemetria', () => {
    // Caso de campo 17/07: o teto sintético travava missão real no bootstrap.
    const exhausted: Mission = {
      ...dispatched,
      intentContract: {
        ...dispatched.intentContract!,
        spentSteps: 200,
        spentTokens: 999_999,
        budgets: {
          ...dispatched.intentContract!.budgets,
          maxSteps: 200,
        },
      },
    };
    const result = assertMissionIntentAllowsTool('nexus_file_write', {
      mission: exhausted,
    });
    expect(result.ok).toBe(true);
  });

  it('running mission is enough authority even without an approved contract', () => {
    const unapproved: Mission = {
      ...dispatched,
      intentContract: {
        ...dispatched.intentContract!,
        approvedAt: undefined,
      },
    };

    for (const tool of [
      'nexus_context_doctor',
      'nexus_pane_spawn',
      'nexus_file_write',
    ]) {
      expect(
        assertMissionIntentAllowsTool(tool, { mission: unapproved }).ok,
      ).toBe(true);
    }
  });

  it('a running mission with a stale contract still executes', () => {
    const stale: Mission = {
      ...dispatched,
      intentVersion: 2,
      intentContract: {
        ...dispatched.intentContract!,
        intentVersion: 1,
      },
    };

    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission: stale }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_file_write', { mission: stale }).ok,
    ).toBe(true);
  });

  describe('handoff_ack', () => {
    const scope = testProjectScope();
    const ctx = { mission: dispatched, role: 'orchestrator', sessionId: 'leader-session', scope };

    it('allows ack only for the proven current mission leader', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: true,
        leader: { sessionId: 'leader-session', paneId: 'pane-1', source: 'durable', proven: true },
      });
      expect(assertMissionIntentAllowsTool('nexus_handoff_ack', ctx).ok).toBe(true);
    });

    it('denies ack from a stale orchestrator token with a named code', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: false, code: 'stale-session', hint: 'outra sessão assumiu a missão',
      });
      const result = assertMissionIntentAllowsTool('nexus_handoff_ack', ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('handoff_origin');
    });

    it('denies ack on split-brain instead of picking a winner', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: false, code: 'split-brain', hint: 'duas sessões vivas',
      });
      const result = assertMissionIntentAllowsTool('nexus_handoff_ack', ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('handoff_origin');
    });

    it('worker continua worker: a worker token never reaches the leader resolver for ack', () => {
      requireMissionLeaderSession.mockClear();
      const result = assertMissionIntentAllowsTool('nexus_handoff_ack', { ...ctx, role: 'worker' });
      expect(result.ok).toBe(false);
      expect(requireMissionLeaderSession).not.toHaveBeenCalled();
    });
  });
});

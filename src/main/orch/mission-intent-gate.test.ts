// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { PREPARE_PROJECT_PLACEHOLDER_GOAL } from '../../shared/mission-intent';

const e2eFlag = vi.hoisted(() => ({ value: false }));
vi.mock('../../shared/real-mission-e2e', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../shared/real-mission-e2e')>();
  return {
    ...actual,
    isCurrentProcessRealMissionE2E: () => e2eFlag.value,
  };
});

import { assertMissionIntentAllowsTool } from './mission-intent-gate';

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

  it('consult lane allows reads and set_status but rejects mutable tools', () => {
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

    for (const tool of [
      'nexus_pane_spawn',
      'nexus_worktree_create',
      'nexus_merge_task',
      'nexus_context_doctor',
      'nexus_mission_freeze_contract',
      'nexus_file_write',
    ] as const) {
      const result = assertMissionIntentAllowsTool(tool, { mission: consult });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('tool_denied');
        expect(result.error).toMatch(/consult lane is read-only/i);
      }
    }
  });

  it('plan lane allows plan writes and denies shell/worktree/code', () => {
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
    ).toBe(true); // path enforced in handler
    expect(
      assertMissionIntentAllowsTool('nexus_memory_retain', { mission: plan }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_set_status', {
        mission: plan,
      }).ok,
    ).toBe(true);

    for (const tool of [
      'nexus_terminal_run',
      'nexus_bg_run',
      'nexus_worktree_create',
      'nexus_pane_spawn',
      'nexus_merge_task',
      'nexus_git_commit',
    ] as const) {
      const result = assertMissionIntentAllowsTool(tool, { mission: plan });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('tool_denied');
        expect(result.error).toMatch(/plan lane/i);
      }
    }
  });

  it('ops lane allows shell/browser effects but denies repo code mutations', () => {
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

    // Read-only / mission-control pass as in any lane.
    expect(
      assertMissionIntentAllowsTool('nexus_git_status', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_file_read', { mission: ops }).ok,
    ).toBe(true);

    // Execution effects allowed once dispatch authority exists.
    expect(
      assertMissionIntentAllowsTool('nexus_terminal_run', { mission: ops }).ok,
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
      assertMissionIntentAllowsTool('nexus_memory_retain', { mission: ops }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_mission_set_status', {
        mission: ops,
      }).ok,
    ).toBe(true);

    // Repo code mutations / delegation denied with a clear message.
    for (const tool of [
      'nexus_editor_apply_patch',
      'nexus_file_write',
      'nexus_plan_write',
      'nexus_git_add',
      'nexus_git_commit',
      'nexus_git_branch_create',
      'nexus_worktree_create',
      'nexus_merge_task',
      'nexus_pane_spawn',
      'nexus_mission_freeze_contract',
    ] as const) {
      const result = assertMissionIntentAllowsTool(tool, { mission: ops });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('tool_denied');
        expect(result.error).toMatch(/lane ops não altera código do repo/i);
      }
    }
  });

  it('ops lane still requires dispatch authority for execution effects', () => {
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
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('dispatch_required');
    }
    // Read-only still passes without dispatch authority.
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

    e2eFlag.value = true;
    try {
      const denied = assertMissionIntentAllowsTool(
        'nexus_mission_set_status',
        { mission: prepare },
        { status: 'blocked' },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe('tool_denied');
        expect(denied.error).toMatch(/real-mission E2E forbids/i);
      }
      expect(
        assertMissionIntentAllowsTool(
          'nexus_mission_set_status',
          { mission: prepare },
          { status: 'failed' },
        ).ok,
      ).toBe(false);
    } finally {
      e2eFlag.value = false;
    }
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

  it('does not open execution for legacy description-only shells', () => {
    const legacy: Mission = {
      ...awaitingGoal,
      status: 'running',
      description: 'old free text',
      intentState: 'legacy',
    };
    expect(
      assertMissionIntentAllowsTool('nexus_file_write', { mission: legacy }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission: legacy }).ok,
    ).toBe(false);
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

  it('denies execution when dispatched state has no approval', () => {
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
      ).toBe(false);
    }
  });

  it('denies a stale approved contract from an older intent version', () => {
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
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_file_write', { mission: stale }).ok,
    ).toBe(false);
  });
});

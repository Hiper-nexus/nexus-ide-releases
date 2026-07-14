// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyEffectfulSpend,
  applyWorkerSpawnPolicy,
  assertStepAndTokenBudget,
  assertWorkerBudget,
  canDispatchWorkers,
  canRunBootstrapEffects,
  canSubmitMissionHandoff,
  childRespectsParentDenials,
  classifyGoalRisk,
  compileIntentContract,
  estimateEffectfulToolTokens,
  isConsultLane,
  canCompleteConsultLane,
  hasApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  isHumanWaitIntentState,
  isRecoveryEligibleIntentState,
  resolveDispatchAuthorizedAt,
  resolveEffectiveIntentState,
  reserveEffectfulSpend,
  synthesizeImmediateDispatchContract,
  transitionIntentState,
  type MissionIntentContract,
} from './mission-intent';
import type { Mission } from './orch-types';

const baseMission = (over: Partial<Mission> = {}): Mission => ({
  id: 'm1',
  title: 'NavalhaGO',
  description: '',
  status: 'pending',
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('mission intent transitions', () => {
  it('walks the happy path select → goal → compile → start', () => {
    expect(transitionIntentState({ from: 'draft', event: 'select_squad' })).toEqual({
      ok: true,
      to: 'awaiting_goal',
    });
    expect(
      transitionIntentState({ from: 'awaiting_goal', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
    expect(
      transitionIntentState({ from: 'intent_compiling', event: 'compile_ok' }),
    ).toEqual({ ok: true, to: 'ready_to_start' });
    expect(
      transitionIntentState({ from: 'ready_to_start', event: 'start' }),
    ).toEqual({ ok: true, to: 'dispatched' });
  });

  it('routes sensitive work through awaiting_approval', () => {
    expect(
      transitionIntentState({ from: 'intent_compiling', event: 'needs_approval' }),
    ).toEqual({ ok: true, to: 'awaiting_approval' });
    expect(
      transitionIntentState({ from: 'awaiting_approval', event: 'approve' }),
    ).toEqual({ ok: true, to: 'ready_to_start' });
  });

  it('rejects invalid transitions', () => {
    expect(
      transitionIntentState({ from: 'awaiting_goal', event: 'start' }).ok,
    ).toBe(false);
    expect(
      transitionIntentState({ from: 'done', event: 'submit_goal' }).ok,
    ).toBe(false);
  });

  it('lets a new user message preempt a plan but not a frozen active workflow', () => {
    expect(
      transitionIntentState({ from: 'ready_to_start', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
    expect(
      transitionIntentState({ from: 'dispatched', event: 'submit_goal' }).ok,
    ).toBe(false);
    expect(
      transitionIntentState({ from: 'executing', event: 'submit_goal' }).ok,
    ).toBe(false);
  });
});

describe('mission dispatch authority', () => {
  it('requires both a current approval and a dispatch-capable state', () => {
    const contract = {
      ...compileIntentContract({ goal: 'Ship safely', intentVersion: 2 }),
      approvedAt: 100,
      dispatchedAt: 100,
    };
    expect(
      hasCurrentDispatchAuthority(
        baseMission({
          intentState: 'ready_to_start',
          intentVersion: 2,
          intentContract: contract,
        }),
      ),
    ).toBe(false);
    expect(
      hasCurrentDispatchAuthority(
        baseMission({
          status: 'running',
          intentState: 'dispatched',
          intentVersion: 2,
          intentContract: contract,
        }),
      ),
    ).toBe(true);
    expect(
      hasCurrentDispatchAuthority(
        baseMission({
          status: 'running',
          intentState: 'dispatched',
          intentVersion: 3,
          intentContract: contract,
        }),
      ),
    ).toBe(false);
  });
});

describe('supervisor eligibility', () => {
  it('does not supervise human-wait states', () => {
    for (const state of [
      'awaiting_goal',
      'intent_compiling',
      'ready_to_start',
      'awaiting_approval',
      'blocked_user',
    ] as const) {
      expect(isHumanWaitIntentState(state)).toBe(true);
      expect(isRecoveryEligibleIntentState(state)).toBe(false);
    }
  });

  it('allows recovery only after dispatch', () => {
    for (const state of ['dispatched', 'executing', 'validating'] as const) {
      expect(isRecoveryEligibleIntentState(state)).toBe(true);
      expect(canDispatchWorkers(state)).toBe(true);
    }
  });
});

describe('resolveEffectiveIntentState (legacy inference)', () => {
  it('treats empty squad selection as awaiting_goal — never a stall', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({ status: 'pending' }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('awaiting_goal');

    expect(
      resolveEffectiveIntentState({
        mission: baseMission({ status: 'running' }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('awaiting_goal');
  });

  it('does NOT treat bare description as a real goal (NavalhaGO / legacy)', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({
          status: 'running',
          description: 'NavalhaGO squad notes only',
          intentState: 'legacy',
        }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('awaiting_goal');
  });

  it('keeps active work as executing when tasks or workers exist', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({ status: 'running' }),
        taskCount: 1,
        workerPaneCount: 0,
      }),
    ).toBe('executing');
  });

  it('honors persisted intentState over inference', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({
          status: 'pending',
          intentState: 'ready_to_start',
        }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('ready_to_start');
  });
});

describe('compileIntentContract', () => {
  it('builds a validated contract and classifies risk', () => {
    const normal = compileIntentContract({
      goal: 'Corrigir o botão de salvar no formulário',
      intentVersion: 1,
    });
    expect(normal.risk).toBe('normal');
    expect(normal.goal).toContain('botão');
    expect(normal.budgets.planningTokens).toBe(1_200);
    expect(normal.executionMode).toBe('autopilot');

    expect(classifyGoalRisk('implementar pagamento com PIX')).toBe('sensitive');
    expect(classifyGoalRisk('apagar a tabela users em produção')).toBe(
      'destructive',
    );
  });

  it('rejects empty goals', () => {
    expect(() =>
      compileIntentContract({ goal: '   ', intentVersion: 1 }),
    ).toThrow(/intent_required/);
  });

  it('builds a consult-lane contract with zero workers and explicit lane', () => {
    const consult = compileIntentContract({
      goal: 'Ler logs da Vercel e resumir erros',
      intentVersion: 1,
      lane: 'consult',
    });
    expect(consult.lane).toBe('consult');
    expect(consult.budgets.maxWorkers).toBe(0);
    expect(isConsultLane({ intentContract: consult })).toBe(true);
    expect(isConsultLane({ intentContract: undefined })).toBe(false);
    expect(canCompleteConsultLane({ note: 'curto' })).toBe(false);
    expect(
      canCompleteConsultLane({
        note: 'Resumo: 3 deploys falharam por timeout no build step de TypeScript.',
      }),
    ).toBe(true);
  });
});

describe('bootstrap gate', () => {
  const prepareContract = {
    version: 1 as const,
    source: 'typed' as const,
    goal: 'Preparar contexto do projeto',
    acceptanceCriteria: ['map'],
    risk: 'normal' as const,
    executionMode: 'manual' as const,
    contextPolicy: 'prepare-project' as const,
    intentVersion: 1,
    budgets: {
      planningTokens: 1,
      executionTokens: 1,
      maxWorkers: 1,
      maxSteps: 10,
    },
  };

  it('denies context_doctor before dispatch unless prepare-project', () => {
    expect(canRunBootstrapEffects('awaiting_goal', null)).toBe(false);
    expect(canRunBootstrapEffects('awaiting_goal', prepareContract)).toBe(true);
    expect(canRunBootstrapEffects('dispatched', null)).toBe(true);
  });

  it('restricts prepare-project to warm tools only', () => {
    expect(
      canRunBootstrapEffects('awaiting_goal', prepareContract, 'nexus_context_doctor'),
    ).toBe(true);
    expect(
      canRunBootstrapEffects('awaiting_goal', prepareContract, 'nexus_mission_freeze_contract'),
    ).toBe(false);
    expect(
      canRunBootstrapEffects('awaiting_goal', prepareContract, 'nexus_context_draft_apply'),
    ).toBe(false);
  });
});

describe('dispatch SLA anchor', () => {
  it('uses approvedAt/dispatchedAt and never invents arm time', () => {
    expect(
      resolveDispatchAuthorizedAt({
        intentContract: undefined,
      }),
    ).toBeNull();
    expect(
      resolveDispatchAuthorizedAt({
        intentContract: compileIntentContract({
          goal: 'x',
          intentVersion: 1,
        }),
      }),
    ).toBeNull();
    const withApprove = compileIntentContract({ goal: 'ship fix', intentVersion: 1 });
    const approved = {
      ...withApprove,
      approvedAt: 1_000,
      dispatchedAt: 1_100,
    };
    expect(resolveDispatchAuthorizedAt({ intentContract: approved })).toBe(1_100);
  });
});

describe('budget and parent/child ceilings', () => {
  it('denies workers beyond maxWorkers', () => {
    const contract = compileIntentContract({
      goal: 'small task',
      intentVersion: 1,
    });
    // default maxWorkers for normal is 3
    expect(assertWorkerBudget(contract, 2).ok).toBe(true);
    expect(assertWorkerBudget(contract, 3).ok).toBe(false);
    // No contract = no ceiling (legacy mid-migration).
    expect(assertWorkerBudget(null, 99).ok).toBe(true);
  });

  it('synthesizes an approved contract for immediate legacy/pet shells', () => {
    const c = synthesizeImmediateDispatchContract({ title: 'Pet hatch' });
    expect(hasApprovedDispatchContract(c)).toBe(true);
    expect(c.budgets.maxWorkers).toBeGreaterThan(0);
    expect(c.dispatchedAt).toBeDefined();
  });

  it('denies when maxSteps spent', () => {
    const base = compileIntentContract({ goal: 'x', intentVersion: 1 });
    const spent = {
      ...base,
      spentSteps: base.budgets.maxSteps,
    };
    expect(assertStepAndTokenBudget(spent).ok).toBe(false);
  });

  it('tracks spentTokens and denies when executionTokens ceiling hit', () => {
    const base = compileIntentContract({ goal: 'x', intentVersion: 1 });
    expect(estimateEffectfulToolTokens('nexus_file_write')).toBeGreaterThan(0);
    const contract = applyEffectfulSpend(
      {
        ...base,
        budgets: { ...base.budgets, executionTokens: 150 },
        spentTokens: 0,
        spentSteps: 0,
      } satisfies MissionIntentContract,
      'nexus_file_write',
    );
    expect(contract.spentSteps).toBe(1);
    expect(contract.spentTokens).toBeGreaterThan(0);
    // Force near ceiling then next spend should fail budget check.
    const nearCap = {
      ...contract,
      spentTokens: 150,
    };
    expect(assertStepAndTokenBudget(nearCap).ok).toBe(false);
  });

  it('refuses a reservation that would cross the step or token ceiling', () => {
    const base = compileIntentContract({ goal: 'x', intentVersion: 1 });
    const atLastStep = {
      ...base,
      budgets: { ...base.budgets, maxSteps: 1 },
      spentSteps: 1,
    };
    expect(reserveEffectfulSpend(atLastStep, 'nexus_file_write')).toMatchObject({
      ok: false,
      code: 'budget_exhausted',
    });

    const nearTokenCap = {
      ...base,
      budgets: { ...base.budgets, executionTokens: 150 },
      spentTokens: 100,
    };
    expect(
      reserveEffectfulSpend(nearTokenCap, 'nexus_file_write'),
    ).toMatchObject({ ok: false, code: 'budget_exhausted' });
  });

  it('denies second worker at maxWorkers and strips denied tools on spawn policy', () => {
    const contract = compileIntentContract({ goal: 'x', intentVersion: 1 });
    const capped = {
      ...contract,
      budgets: { ...contract.budgets, maxWorkers: 1 },
      deniedTools: ['terminal_run', 'file_write'],
    };
    expect(
      applyWorkerSpawnPolicy({
        contract: capped,
        currentWorkerCount: 1,
        allowedTools: ['file_read', 'terminal_run', 'grep'],
      }).ok,
    ).toBe(false);
    const ok = applyWorkerSpawnPolicy({
      contract: capped,
      currentWorkerCount: 0,
      allowedTools: ['file_read', 'terminal_run', 'grep'],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.allowedTools) {
      expect(ok.allowedTools).toContain('file_read');
      expect(ok.allowedTools).not.toContain('terminal_run');
    }
  });

  it('requires child denials to respect parent', () => {
    expect(childRespectsParentDenials(['terminal_run'], ['terminal_run', 'file_write'])).toBe(
      true,
    );
    expect(childRespectsParentDenials(['terminal_run'], ['file_write'])).toBe(false);
  });

  it('requires handoff origin binding', () => {
    expect(
      canSubmitMissionHandoff({
        role: 'worker',
        missionId: 'm1',
        sessionId: 's1',
        intentState: 'dispatched',
      }).ok,
    ).toBe(true);
    expect(
      canSubmitMissionHandoff({
        role: 'user',
        missionId: 'm1',
        sessionId: 's1',
        intentState: 'dispatched',
      }).ok,
    ).toBe(false);
    expect(
      canSubmitMissionHandoff({
        role: 'worker',
        missionId: 'm1',
        sessionId: 's1',
        intentState: 'awaiting_goal',
      }).ok,
    ).toBe(false);
  });
});

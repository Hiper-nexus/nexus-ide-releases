// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  canDispatchWorkers,
  canRunBootstrapEffects,
  classifyGoalRisk,
  compileIntentContract,
  isHumanWaitIntentState,
  isRecoveryEligibleIntentState,
  resolveEffectiveIntentState,
  transitionIntentState,
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
    ).toEqual({ ok: true, to: 'dispatched' });
  });

  it('rejects invalid transitions', () => {
    expect(
      transitionIntentState({ from: 'awaiting_goal', event: 'start' }).ok,
    ).toBe(false);
    expect(
      transitionIntentState({ from: 'done', event: 'submit_goal' }).ok,
    ).toBe(false);
  });

  it('lets a new user message preempt plan/dispatch', () => {
    expect(
      transitionIntentState({ from: 'ready_to_start', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
    expect(
      transitionIntentState({ from: 'dispatched', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
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
    budgets: { planningTokens: 1, executionTokens: 1, maxWorkers: 1 },
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

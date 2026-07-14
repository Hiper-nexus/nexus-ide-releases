// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
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
    budgets: { planningTokens: 1200, executionTokens: 8000, maxWorkers: 2 },
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

  it('allows prepare-project bootstrap while awaiting goal', () => {
    const prepare: Mission = {
      ...awaitingGoal,
      intentContract: {
        version: 1,
        source: 'typed',
        goal: 'prepare',
        acceptanceCriteria: ['map warm'],
        risk: 'normal',
        executionMode: 'assisted',
        contextPolicy: 'prepare-project',
        intentVersion: 1,
        budgets: { planningTokens: 1200, executionTokens: 0, maxWorkers: 0 },
      },
    };
    // Explicit UX "Preparar projeto" stamps contextPolicy on the contract.
    expect(
      assertMissionIntentAllowsTool('nexus_context_doctor', {
        mission: prepare,
      }).ok,
    ).toBe(true);
    // Still must not spawn workers before dispatch.
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', {
        mission: prepare,
      }).ok,
    ).toBe(false);
  });
});

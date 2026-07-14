// @vitest-environment node
/**
 * forceLegacy / pet-studio: create path must authorize delegation with an
 * approved contract (not dispatched-without-contract).
 */
import { describe, expect, it } from 'vitest';
import {
  assertWorkerBudget,
  hasApprovedDispatchContract,
  synthesizeImmediateDispatchContract,
} from '../../shared/mission-intent';
import { assertMissionIntentAllowsTool } from './mission-intent-gate';
import type { Mission } from '../../shared/orch-types';

describe('legacy immediate dispatch shell', () => {
  it('synthesized contract allows pane_spawn after createMission path', () => {
    const contract = synthesizeImmediateDispatchContract({
      title: 'Pet Studio hatch',
      now: 5_000,
    });
    expect(hasApprovedDispatchContract(contract)).toBe(true);
    expect(assertWorkerBudget(contract, 0).ok).toBe(true);

    const mission: Mission = {
      id: 'm-legacy',
      title: 'Pet Studio hatch',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 5_000,
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: contract,
    };

    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', {
        mission,
        taskCount: 0,
        workerPaneCount: 0,
      }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_context_doctor', {
        mission,
      }).ok,
    ).toBe(true);
  });

  it('dispatched without an approved current contract cannot delegate', () => {
    // Bare dispatched rows (no contract) are no longer authorized — production
    // createMission always synthesizes an approved contract.
    const mission: Mission = {
      id: 'm-mid',
      title: 'old',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 1,
      intentState: 'dispatched',
      intentVersion: 0,
    };
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission }).ok,
    ).toBe(false);
    // Worker budget still no-ops without a contract (spawn never reaches it).
    expect(assertWorkerBudget(null, 5).ok).toBe(true);
  });
});

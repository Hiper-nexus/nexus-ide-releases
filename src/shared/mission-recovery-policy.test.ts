import { describe, expect, it } from 'vitest';
import type { MissionIntentContract } from './mission-intent';
import {
  hasAutomaticTechnicalRecovery,
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
} from './mission-recovery-policy';

function approvedContract(): MissionIntentContract {
  return {
    goal: 'Corrigir o projeto',
    intentVersion: 3,
    approvedAt: 100,
  } as MissionIntentContract;
}

describe('hasAutomaticTechnicalRecovery', () => {
  it('accepts only a current approved technical block', () => {
    expect(
      hasAutomaticTechnicalRecovery({
        status: 'blocked',
        intentState: 'blocked_technical',
        description: 'Falha transitória.',
        intentVersion: 3,
        intentContract: approvedContract(),
      }),
    ).toBe(true);
    expect(
      hasAutomaticTechnicalRecovery({
        status: 'blocked',
        intentState: 'dispatched',
        description: 'Persistência legada desalinhada.',
        intentVersion: 3,
        intentContract: approvedContract(),
      }),
    ).toBe(true);
  });

  it('rejects terminal, stale and human blocks', () => {
    const base = {
      status: 'blocked',
      intentState: 'blocked_technical',
      description: 'Falha transitória.',
      intentVersion: 3,
      intentContract: approvedContract(),
    };

    expect(
      hasAutomaticTechnicalRecovery({
        ...base,
        description: `${TERMINAL_OPERATIONAL_FAILURE_MARKER} autoridade divergente`,
      }),
    ).toBe(false);
    expect(
      hasAutomaticTechnicalRecovery({ ...base, intentVersion: 4 }),
    ).toBe(false);
    expect(
      hasAutomaticTechnicalRecovery({
        ...base,
        intentState: 'blocked_user',
      }),
    ).toBe(false);
  });
});

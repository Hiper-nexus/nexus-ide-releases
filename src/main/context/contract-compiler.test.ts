import { describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  compileMissionContract,
  ContractCompilationError,
} from './contract-compiler';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
});

function proposal() {
  return {
    schemaVersion: 1 as const,
    scope,
    missionId: 'mission-a',
    baseCommit: 'a'.repeat(40),
    contextRevision: 'context-001',
    goal: 'Adicionar autenticação sem quebrar a sessão existente',
    nonGoals: ['Trocar o provedor de identidade'],
    acceptanceCriteria: [
      {
        id: 'ac-login',
        statement: 'Credenciais válidas criam uma sessão',
        requiredSensorIds: ['unit'],
      },
    ],
    businessInvariantRefs: ['inv-session'],
    impactedDomains: ['auth'],
    impactedSymbols: ['createSession'],
    requestedSensors: ['unit'],
    requiredArtifacts: [],
    riskHints: ['auth'],
  };
}

const context = {
  invariantRefs: new Set(['inv-session']),
  availableSensorIds: new Set(['unit', 'typecheck', 'design-system']),
  blockingConflictIds: [] as string[],
};

describe('compileMissionContract', () => {
  it('elevates risky business domains and emits one deterministic frozen hash', () => {
    const first = compileMissionContract(proposal(), context);
    const second = compileMissionContract(proposal(), context);

    expect(first.risk).toBe('high');
    expect(first.requiredSensors).toEqual(['unit']);
    expect(first.route).toEqual([
      'planning',
      'review-primary',
      'execution',
      'validation-primary',
      'confirmation',
    ]);
    expect(first.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contractHash).toBe(second.contractHash);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('makes ordering of set-like inputs irrelevant to the contract hash', () => {
    const left = proposal();
    left.impactedDomains = ['ipc', 'auth'];
    left.requestedSensors = ['typecheck', 'unit'];
    const right = proposal();
    right.impactedDomains = ['auth', 'ipc'];
    right.requestedSensors = ['unit', 'typecheck'];

    expect(compileMissionContract(left, context).contractHash).toBe(
      compileMissionContract(right, context).contractHash,
    );
  });

  it('fails closed for unresolved invariants, sensors or context conflicts', () => {
    expect(() =>
      compileMissionContract(proposal(), {
        ...context,
        invariantRefs: new Set(),
      }),
    ).toThrow(ContractCompilationError);
    expect(() =>
      compileMissionContract(proposal(), {
        ...context,
        availableSensorIds: new Set(),
      }),
    ).toThrow(/unknown sensor/i);
    expect(() =>
      compileMissionContract(proposal(), {
        ...context,
        blockingConflictIds: ['conflict-a'],
      }),
    ).toThrow(/blocking context conflict/i);
  });

  it('rejects caller-declared low risk when automatic signals require critical', () => {
    const input = proposal();
    input.riskHints = ['payment', 'tenant-isolation'];

    const contract = compileMissionContract(input, context);
    expect(contract.risk).toBe('critical');
    expect(contract.route).toContain('review-secondary');
    expect(contract.route).toContain('validation-secondary');
  });

  it('automatically makes design-system consistency executable for UI missions', () => {
    const input = proposal();
    input.goal = 'Criar uma landing page responsiva com identidade própria';
    input.impactedDomains = ['frontend'];

    const contract = compileMissionContract(input, context);

    expect(contract.requiredSensors).toContain('design-system');
    expect(() => compileMissionContract(input, {
      ...context,
      availableSensorIds: new Set(['unit', 'typecheck']),
    })).toThrow(/unknown sensor: design-system/);
  });
});

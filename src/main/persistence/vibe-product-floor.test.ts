import { describe, expect, it } from 'vitest';
import { DEFAULT_ORCH_SETTINGS } from '../../shared/settings-types';
import { applyVibeNoSandboxFloor } from './vibe-product-floor';

describe('applyVibeNoSandboxFloor', () => {
  it('forces Autopilot + no attestation crypto once for every install', () => {
    const result = applyVibeNoSandboxFloor({
      orch: {
        ...DEFAULT_ORCH_SETTINGS,
        squadCliPolicy: 'governed',
        agentAttestationGate: 'required',
      },
      productMigrations: {},
    });

    expect(result.changed).toBe(true);
    expect(result.orch.squadCliPolicy).toBe('operator-choice');
    expect(result.orch.agentAttestationGate).toBe('off');
    expect(result.productMigrations.vibeNoSandboxFloor20260803).toBe(true);
  });

  it('stamps even when already on Autopilot so re-opt-in is preserved later', () => {
    const result = applyVibeNoSandboxFloor({
      orch: {
        ...DEFAULT_ORCH_SETTINGS,
        squadCliPolicy: 'operator-choice',
        agentAttestationGate: 'off',
      },
      productMigrations: {},
    });

    expect(result.changed).toBe(true);
    expect(result.orch.squadCliPolicy).toBe('operator-choice');
    expect(result.productMigrations.vibeNoSandboxFloor20260803).toBe(true);
  });

  it('never rewrites Hardened after the operator re-enables it post-stamp', () => {
    const result = applyVibeNoSandboxFloor({
      orch: {
        ...DEFAULT_ORCH_SETTINGS,
        squadCliPolicy: 'governed',
        agentAttestationGate: 'required',
      },
      productMigrations: { vibeNoSandboxFloor20260803: true },
    });

    expect(result.changed).toBe(false);
    expect(result.orch.squadCliPolicy).toBe('governed');
    expect(result.orch.agentAttestationGate).toBe('required');
  });
});

/**
 * Product floor: Autopilot without process sandbox / handoff crypto for
 * everyone by default. Hardened (`governed` + attestation required) is only
 * active when the operator later opts in after this one-shot migration.
 */

import type { OrchSettings } from '../../shared/settings-types';

export type VibeProductMigrations = {
  /** One-shot: no OS sandbox + no handoff attestation by default. */
  readonly vibeNoSandboxFloor20260803?: boolean;
  /** Legacy stamp from the attestation-only migration; treated as partial. */
  readonly vibeAttestationOff20260803?: boolean;
};

export interface VibeFloorMigrationInput {
  readonly orch: OrchSettings;
  readonly productMigrations: VibeProductMigrations;
}

export interface VibeFloorMigrationResult {
  readonly orch: OrchSettings;
  readonly productMigrations: VibeProductMigrations;
  /** True when orch or stamp must be persisted. */
  readonly changed: boolean;
}

/**
 * Apply the Autopilot floor once per install. After the stamp is set, an
 * operator who explicitly chooses Hardened / attestation keeps that choice.
 */
export function applyVibeNoSandboxFloor(
  input: VibeFloorMigrationInput,
): VibeFloorMigrationResult {
  if (input.productMigrations.vibeNoSandboxFloor20260803 === true) {
    return {
      orch: input.orch,
      productMigrations: input.productMigrations,
      changed: false,
    };
  }

  const nextOrch: OrchSettings = {
    ...input.orch,
    // Always land on Autopilot once — process sandbox is opt-in only.
    squadCliPolicy: 'operator-choice',
    agentAttestationGate: 'off',
  };
  const productMigrations: VibeProductMigrations = {
    ...input.productMigrations,
    vibeNoSandboxFloor20260803: true,
    vibeAttestationOff20260803: true,
  };

  return {
    orch: nextOrch,
    productMigrations,
    // Always stamp + persist once even if already operator-choice/off.
    changed: true,
  };
}

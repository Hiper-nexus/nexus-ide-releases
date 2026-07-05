import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ONBOARDING,
  onboardingPatchSchema,
  onboardingStateSchema,
} from '../../shared/onboarding-types';

// A lógica de persistência do onboarding-store depende de electron (app.getPath)
// e é coberta pelo smoke do app; aqui travamos os contratos puros (schemas), que
// decidem o que é aceito nas bordas IPC.

describe('onboarding schemas', () => {
  it('default é não-concluído e não-pulado, sem vitórias', () => {
    expect(DEFAULT_ONBOARDING).toEqual({ completed: false, skipped: false, victories: {} });
  });

  it('estado válido hidrata; vitórias são um mapa parcial de timestamps', () => {
    const parsed = onboardingStateSchema.parse({
      completed: true,
      skipped: false,
      victories: { cliDetected: 1000, firstMission: 2000 },
    });
    expect(parsed.completed).toBe(true);
    expect(parsed.victories.cliDetected).toBe(1000);
  });

  it('arquivo vazio cai nos defaults (nunca bloqueia o boot)', () => {
    const parsed = onboardingStateSchema.parse({});
    expect(parsed).toEqual(DEFAULT_ONBOARDING);
  });

  it('patch aceita completed/skipped/victory e rejeita chave de vitória inválida', () => {
    expect(onboardingPatchSchema.safeParse({ completed: true }).success).toBe(true);
    expect(onboardingPatchSchema.safeParse({ victory: 'voiceEnabled' }).success).toBe(true);
    expect(onboardingPatchSchema.safeParse({ victory: 'inventada' }).success).toBe(false);
  });
});

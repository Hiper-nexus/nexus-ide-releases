import { z } from 'zod';

/**
 * Onboarding de primeira execução — estado persistido + "vitórias" (checklist
 * que ensina a interface). Sem telemetria: tudo local em
 * ~/.nexus/onboarding.json.
 */

export const ONBOARDING_CHANNELS = {
  get: 'onboarding:get',
  set: 'onboarding:set',
} as const;

/** Marcos que o usuário destrava usando o app — não são passos obrigatórios. */
export const VICTORY_KEYS = [
  'cliDetected',
  'firstMission',
  'firstHandoff',
  'voiceEnabled',
  'catalogInstalled',
] as const;
export type VictoryKey = (typeof VICTORY_KEYS)[number];

export const onboardingStateSchema = z.object({
  /** false até o usuário concluir ou pular o wizard. */
  completed: z.boolean().default(false),
  skipped: z.boolean().default(false),
  victories: z
    .partialRecord(z.enum(VICTORY_KEYS), z.number())
    .default(() => ({})),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const onboardingPatchSchema = z.object({
  completed: z.boolean().optional(),
  skipped: z.boolean().optional(),
  /** Marca uma vitória como alcançada agora (timestamp gravado no main). */
  victory: z.enum(VICTORY_KEYS).optional(),
});
export type OnboardingPatch = z.infer<typeof onboardingPatchSchema>;

export const DEFAULT_ONBOARDING: OnboardingState = {
  completed: false,
  skipped: false,
  victories: {},
};

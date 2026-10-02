import { z } from 'zod';

/**
 * Desempate de missão por voz (superfície Jev `missionPick`).
 *
 * Fronteira renderer → Main. O renderer só manda o que a pessoa disse e os
 * títulos das missões empatadas: SEM id real, caminho nem conteúdo de conversa
 * (o schema é estrito, então uma chave a mais é recusada). O Main devolve a
 * POSIÇÃO do candidato escolhido; quem tem o id real é o renderer.
 *
 * Dependência só de zod: o preload, o Main e o renderer importam este arquivo.
 */

export const MISSION_PICK_LIMITS = {
  spokenMax: 120,
  titleMax: 100,
  candidatesMin: 2,
  candidatesMax: 5,
} as const;

const LIMITS = MISSION_PICK_LIMITS;

/** Renderer → Main. Estrito: chave desconhecida é recusada. */
export const missionPickCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(LIMITS.titleMax),
    /** Estado do ciclo de vida (`running`, `completed`…), um rótulo simples. */
    state: z.string().regex(/^[a-z_]{1,40}$/),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const missionPickRequestSchema = z
  .object({
    spoken: z.string().trim().min(1).max(LIMITS.spokenMax),
    candidates: z
      .array(missionPickCandidateSchema)
      .min(LIMITS.candidatesMin)
      .max(LIMITS.candidatesMax),
  })
  .strict();

export type MissionPickCandidate = z.infer<typeof missionPickCandidateSchema>;
export type MissionPickRequest = z.infer<typeof missionPickRequestSchema>;

/** Por que não houve decisão — categórico, nunca o texto de um erro. */
export type MissionPickUndecidedReason =
  | 'invalid-request'
  | 'disabled'
  | 'unavailable'
  | 'rate-limited'
  | 'invalid-answer'
  | 'none'
  | 'low-confidence'
  | 'narrow-margin'
  | 'error';

/** Main → renderer. Sempre tipado, inclusive em erro. */
export type MissionPickResult =
  | {
      readonly decision: 'picked';
      /** Posição (base 0) do candidato escolhido na lista enviada. */
      readonly index: number;
      readonly confidence: number;
    }
  | {
      readonly decision: 'undecided';
      readonly reason: MissionPickUndecidedReason;
    };

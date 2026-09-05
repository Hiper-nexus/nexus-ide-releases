import { z } from 'zod';

/** Reviewed router vocabulary; these are recommendations, never grants. */
export const MISSION_ROUTING_SKILLS = [
  'impeccable',
  'dembrandt',
  'archify',
  'superpowers',
  'bridgesecurity',
  'bridgeward',
  'nexus-visual-media',
] as const;

const questionSchema = z.string().trim().min(1).max(4_096);
const rawRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct-answer'), question: questionSchema }).strict(),
  z.object({
    kind: z.literal('mission-question'),
    question: questionSchema,
    readOnlyWorkers: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal('mission-work'),
    skills: z.array(z.string().max(64)).max(64),
  }).strict(),
]);

export const missionRoutingAdviceSchema = z.union([
  z.object({
    source: z.literal('router'),
    kind: z.literal('direct-answer'),
    question: questionSchema,
  }).strict(),
  z.object({
    source: z.literal('router'),
    kind: z.literal('mission-question'),
    question: questionSchema,
    readOnlyWorkers: z.literal(true),
  }).strict(),
  z.object({
    source: z.literal('router'),
    kind: z.literal('mission-work'),
    skills: z.array(z.enum(MISSION_ROUTING_SKILLS)).max(MISSION_ROUTING_SKILLS.length),
  }).strict(),
  z.object({
    source: z.literal('deterministic-fallback'),
    kind: z.literal('mission-work'),
    reason: z.enum(['unavailable', 'invalid-result', 'router-error']),
  }).strict(),
]);
export type MissionRoutingAdvice = z.infer<typeof missionRoutingAdviceSchema>;

/** Preserve only typed advice within the already approved skill vocabulary. */
export function parseMissionRoutingAdvice(
  rawRoute: unknown,
  allowedSkills: readonly string[] | null,
): MissionRoutingAdvice {
  if (rawRoute === null) {
    return { source: 'deterministic-fallback', kind: 'mission-work', reason: 'unavailable' };
  }
  const parsed = rawRouteSchema.safeParse(rawRoute);
  if (!parsed.success) {
    return { source: 'deterministic-fallback', kind: 'mission-work', reason: 'invalid-result' };
  }
  const route = parsed.data;
  if (route.kind !== 'mission-work') return { source: 'router', ...route };
  const skills = MISSION_ROUTING_SKILLS.filter((skill) =>
    route.skills.includes(skill) && (allowedSkills === null || allowedSkills.includes(skill)),
  );
  return { source: 'router', kind: 'mission-work', skills };
}

/** Revalidate persisted advice; consumers may further narrow hints per seat. */
export function getMissionRoutingHints(
  contract: { readonly routingAdvice?: MissionRoutingAdvice } | null | undefined,
  allowedSkills?: readonly string[] | null,
): { paneQuestion: string | null; readOnlyWorkers: boolean; suggestedSkills: string[] } {
  const parsed = missionRoutingAdviceSchema.safeParse(contract?.routingAdvice);
  const advice = parsed.success ? parsed.data : undefined;
  return {
    paneQuestion: advice?.kind === 'mission-question' ? advice.question : null,
    readOnlyWorkers: advice?.kind === 'mission-question',
    suggestedSkills: advice?.source === 'router' && advice.kind === 'mission-work'
      ? advice.skills.filter((skill) => allowedSkills == null || allowedSkills.includes(skill))
      : [],
  };
}

export function missionRoutingReviewWarnings(advice: MissionRoutingAdvice | undefined): string[] {
  if (!advice) return [];
  if (advice.source === 'deterministic-fallback') {
    return ['A classificação automática não ficou disponível. A missão foi preparada pelas regras locais, com o objetivo e a equipe escolhidos.'];
  }
  if (advice.kind === 'mission-question') {
    return [`Entendido como pergunta à equipe, com consultas sem alterações: ${advice.question}`];
  }
  if (advice.kind === 'direct-answer') {
    return [`Entendido como pergunta geral; a missão continua com a equipe escolhida: ${advice.question}`];
  }
  return [
    'Entendido como pedido de entrega; o objetivo e os limites escolhidos orientam a execução.',
    ...(advice.skills.length > 0
      ? [`Recursos sugeridos entre os já permitidos à equipe: ${advice.skills.join(', ')}.`]
      : []),
  ];
}

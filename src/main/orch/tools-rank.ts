/**
 * `nexus_rank` — ranking tipado de entregas/candidatos via TypeSafe Jev.
 * O orquestrador manda 2–8 candidatos e 1–6 critérios com níveis; cada
 * candidato vira UMA chamada judge() com uma pergunta score por critério
 * (em paralelo). O composto é calculado em código com os pesos — o modelo
 * nunca decide o ranking sozinho. Read-only (egress à conta TypeSafe do
 * usuário, mesmo rate-limit de 30/min por sessão do nexus_judge).
 */
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { judge, type JevResult } from '../jev/jev-client';
import { aggregateDecisionUsage } from '../decision-models/decision-usage';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import { consumeJevRateSlots } from '../jev/jev-rate-limit';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';

const RANK_TIMEOUT_MS = 15_000;

const candidateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  text: z.string().min(1).max(12_000),
});

const criterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  instructions: z.string().min(1).max(1_000),
  levels: z.array(z.string().min(1).max(300)).min(2).max(7),
});

const uniqueIds = (rows: readonly { id: string }[]) =>
  new Set(rows.map((row) => row.id)).size === rows.length;

export const rankArgsSchema = z.object({
  candidates: z
    .array(candidateSchema)
    .min(2)
    .max(8)
    .refine(uniqueIds, { message: 'candidate ids must be unique' }),
  criteria: z
    .array(criterionSchema)
    .min(1)
    .max(6)
    .refine(uniqueIds, { message: 'criterion ids must be unique' }),
  weights: z
    .record(z.string(), z.number().min(0).max(10))
    // pesos todos zero → Σw = 0 e o compósito vira NaN; exige ≥ 1 positivo
    .refine(
      (w) => Object.values(w).some((v) => v > 0),
      { message: 'at least one criterion weight must be positive' },
    )
    .optional(),
});

function rateLimitKey(ctx: AgentGateContext): string {
  return ctx.sessionId ?? ctx.token;
}

interface RankedCandidate {
  id: string;
  composite: number;
  scores: Record<
    string,
    { score: number; normalized: number; confidence: number }
  >;
}

const rankTool: McpToolDef = {
  name: 'nexus_rank',
  description:
    'Rank 2-8 candidates (deliveries, patches, options) with the configured Nexus decision model: ' +
    'send `candidates` (id + text) and `criteria` (id, instructions, ordered ' +
    'levels) — each candidate gets one score question per criterion and a ' +
    'weighted composite is computed in code. Optional `weights` maps ' +
    'criterion id → weight 0-10 (default 1). Returns `ranking` sorted desc ' +
    'plus `lowConfidence` ids you should read yourself. Keep the final ' +
    'choice in your own logic; treat lowConfidence ids as needing your own ' +
    'reading. Never include secrets in candidate text — it leaves the ' +
    "machine to the user's configured decision provider.",
  // O toggle "Ranking de entregas" desliga a ferramenta (era fiação morta
  // desde 17/09: nada lia `jevSurfaces.rank`).
  available: () => isJevSurfaceEnabled('rank') && hasDecisionCredential('rankTool'),
  inputSchema: {
    type: 'object',
    properties: {
      candidates: { type: 'array' },
      criteria: { type: 'array' },
      weights: { type: 'object' },
    },
    required: ['candidates', 'criteria'],
  },
  handler: async (args, ctx, invocation) => {
    const parsed = rankArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `nexus_rank: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const { candidates, criteria, weights } = parsed.data;
    const criterionIds = new Set(criteria.map((c) => c.id));
    for (const key of Object.keys(weights ?? {})) {
      if (!criterionIds.has(key)) {
        throw new Error(
          `nexus_rank: peso para critério desconhecido '${key}'`,
        );
      }
    }
    if (!isJevSurfaceEnabled('rank')) {
      throw new Error(
        'nexus_rank desligado: ligue "Ranking de entregas" e o Piloto automático ' +
          'em Ajustes → Padrões de execução',
      );
    }
    if (!hasDecisionCredential('rankTool')) {
      throw new Error(
        'nexus_rank indisponível: configure Jev ou Clef em ' +
          'Ajustes → Chaves de API',
      );
    }
    // Um rank consome 1 chamada judge() por candidato: reserva o lote
    // inteiro da janela de 30/min, tudo ou nada.
    if (!consumeJevRateSlots(rateLimitKey(ctx), candidates.length)) {
      throw new Error('nexus_rank: limite de 30 chamadas/min por sessão');
    }

    const questions = Object.fromEntries(
      criteria.map((criterion) => [
        criterion.id,
        {
          type: 'score' as const,
          instructions: criterion.instructions,
          criteria: criterion.levels,
        },
      ]),
    );

    assertMcpInvocationCurrent(invocation);
    const judged = await Promise.all(
      candidates.map(async (candidate) => {
        const result: JevResult | null = await judge({
          state: { candidate: candidate.text },
          questions,
          timeoutMs: RANK_TIMEOUT_MS,
          signal: invocation?.signal,
          surface: 'rankTool',
        });
        return { candidate, result };
      }),
    );
    const successful = judged.flatMap(({ result }) => result ? [result] : []);
    if (successful.length) recordJevDecision({
      ...aggregateDecisionUsage(successful, successful.length !== judged.length || invocation?.signal?.aborted),
      kind: successful.length === judged.length ? 'decision' : 'no-answer',
      surface: 'rankTool', sessionId: ctx.sessionId, missionId: ctx.missionId,
      model: successful[0].model, questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(successful[0].answers), confidence: jevAnswerConfidences(successful[0].answers),
      decision: successful.length === judged.length ? 'rank' : 'rank-incomplete',
    });
    // Billing evidence survives revocation; an obsolete ranking never returns.
    assertMcpInvocationCurrent(invocation);
    if (judged.some(({ result }) => result === null)) {
      throw new Error(
        'nexus_rank: modelo de decisão selecionado indisponível agora; siga sem o ' +
          'ranking',
      );
    }

    const weightOf = (id: string) => weights?.[id] ?? 1;
    const weightTotal = criteria.reduce(
      (sum, criterion) => sum + weightOf(criterion.id),
      0,
    );

    const ranking: RankedCandidate[] = judged.map(({ candidate, result }) => {
      const scores: RankedCandidate['scores'] = {};
      let composite = 0;
      for (const criterion of criteria) {
        const answer = result!.answers[criterion.id];
        const maxLevel = criterion.levels.length - 1;
        const score = answer?.type === 'score' ? answer.score : 0;
        const normalized = maxLevel > 0 ? score / maxLevel : 0;
        const confidence =
          answer?.type === 'score' ? answer.confidence : 0;
        scores[criterion.id] = { score, normalized, confidence };
        composite += weightOf(criterion.id) * normalized;
      }
      return {
        id: candidate.id,
        composite: weightTotal > 0 ? composite / weightTotal : 0,
        scores,
      };
    });
    ranking.sort((a, b) => b.composite - a.composite);

    const lowConfidence = judged
      .filter(({ candidate }) =>
        criteria.some(
          (criterion) =>
            (ranking.find((r) => r.id === candidate.id)?.scores[criterion.id]
              ?.confidence ?? 0) < 0.4,
        ),
      )
      .map(({ candidate }) => candidate.id);

    const model = judged[0]!.result!.model;

    return { model, ranking, lowConfidence };
  },
};

export function buildRankTools(): McpToolDef[] {
  return [rankTool];
}

import { decisionResultUsage } from '../decision-models/decision-usage';
/**
 * `nexus_judge` — julgamento tipado do TypeSafe Jev como tool MCP para os
 * agentes. Read-only (egress à conta TypeSafe do usuário, rate-limit por
 * sessão); a resposta ou erro vai direto para quem chamou.
 */
import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { judge } from '../jev/jev-client';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  consumeJevRateSlot,
  resetJevRateLimitsForTesting,
} from '../jev/jev-rate-limit';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';

const MAX_STATE_JSON_CHARS = 32_768;
const JUDGE_TIMEOUT_MS = 15_000;

const questionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const questionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: z.string().min(1).max(2_000),
    criteria: z
      .object({
        true: z.string().min(1).max(500),
        false: z.string().min(1).max(500),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: z.string().min(1).max(2_000),
    criteria: z
      .record(z.string().min(1).max(64), z.string().max(500).nullable())
      .refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 32, {
        message: 'choice criteria needs 2-32 options',
      }),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string().min(1).max(2_000),
    criteria: z.array(z.string().min(1).max(500)).min(2).max(16),
  }),
]);

export const judgeArgsSchema = z.object({
  state: z
    .unknown()
    .refine(
      (s) => {
        try {
          return JSON.stringify(s).length <= MAX_STATE_JSON_CHARS;
        } catch {
          return false;
        }
      },
      { message: `state exceeds ${MAX_STATE_JSON_CHARS} chars when serialized` },
    ),
  questions: z
    .record(questionIdSchema, questionSchema)
    .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 16, {
      message: 'questions needs 1-16 entries',
    }),
  model: z.string().min(1).max(64).optional(),
});

export function resetJudgeRateLimitsForTesting(): void {
  resetJevRateLimitsForTesting();
}

function rateLimitKey(ctx: AgentGateContext): string {
  return ctx.sessionId ?? ctx.token;
}

const judgeTool: McpToolDef = {
  name: 'nexus_judge',
  description:
    "Typed judgment from the configured Nexus decision model: send a `state` (text or " +
    'JSON) plus a map of questions and get calibrated answers your logic can ' +
    'branch on — no text generation. Types: noul {type:"noul", instructions} ' +
    '→ probability of yes; choice {type:"choice", instructions, ' +
    'criteria:{option: description|null}} → chosen option + probabilities + ' +
    'confidence; score {type:"score", instructions, ' +
    'criteria:[level0, level1, ...]} → weighted level + confidence. Ask ' +
    'several independent questions in ONE call (they run in parallel). Use it ' +
    'to route, classify, rank, verify or gate with fixed answer sets; keep ' +
    'thresholds and rules in your own logic; ask small atomic questions. ' +
    "Never include secrets, tokens or customer data in state — it leaves the " +
    "machine to the user's configured decision provider.",
  available: () => hasDecisionCredential('judgeTool'),
  inputSchema: {
    type: 'object',
    properties: {
      state: {},
      questions: { type: 'object' },
      model: { type: 'string' },
    },
    required: ['state', 'questions'],
  },
  handler: async (args, ctx, invocation) => {
    const parsed = judgeArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `nexus_judge: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    if (!hasDecisionCredential('judgeTool')) {
      throw new Error(
        'nexus_judge indisponível: configure Jev ou Clef em ' +
          'Ajustes → Chaves de API',
      );
    }
    if (!consumeJevRateSlot(rateLimitKey(ctx))) {
      throw new Error(
        'nexus_judge: limite de 30 chamadas/min por sessão',
      );
    }
    assertMcpInvocationCurrent(invocation);
    const result = await judge({
      state: parsed.data.state,
      questions: parsed.data.questions,
      model: parsed.data.model,
      timeoutMs: JUDGE_TIMEOUT_MS,
      signal: invocation?.signal,
      surface: 'judgeTool',
    });
    // Revogação durante a chamada: aborta antes de registrar/retornar.
    assertMcpInvocationCurrent(invocation);
    if (!result) {
      throw new Error(
        'nexus_judge: modelo de decisão selecionado indisponível agora (timeout/erro). ' +
          'Siga sem o julgamento ou tente de novo.',
      );
    }
    recordJevDecision({
      surface: 'judgeTool',
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
      model: result.model,
      questions: Object.keys(parsed.data.questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: 'judge',
      ...decisionResultUsage(result),
    });
    return {
      model: result.model,
      answers: result.answers,
      usage: result.usage,
    };
  },
};

export function buildJudgeTools(): McpToolDef[] {
  return [judgeTool];
}

// Derived from can1357/oh-my-pi@03c48d073 review pipeline (MIT)
import { z } from 'zod';

/**
 * Schema tipado do veredito do squad builtin "Review P0–P3".
 *
 * Espelha o output schema do agente `reviewer` do oh-my-pi
 * (packages/coding-agent/src/prompts/agents/reviewer.md) em camelCase e com a
 * prioridade como enum textual 'P0'..'P3' (no omp é um número 0-3).
 *
 * Contrato do squad: o handoff FINAL do orquestrador (e o de cada reviewer)
 * DEVE incluir esse objeto como JSON — dentro de um bloco ```json no
 * `summary` e/ou como item do campo estruturado `artifacts` do handoff.
 * `parseReviewFindings` aceita qualquer uma dessas formas (inclusive o
 * ScopedHandoff inteiro) e é tolerante a variações comuns de saída de LLM:
 * chaves snake_case do schema original do omp, prioridade numérica 0-3,
 * confidence fora de [0,1] (clampada) e título acima de 80 chars (truncado).
 */

/** Confiança 0-1; valores finitos fora do intervalo são clampados (tolerância). */
const confidenceSchema = z
  .number()
  .transform((value) => Math.min(1, Math.max(0, value)));

/**
 * Prioridade P0-P3. Aceita o número 0-3 do schema original do omp e strings
 * em caixa baixa; qualquer valor fora do enum é rejeitado (ex.: 'P4', 4).
 */
const prioritySchema = z.preprocess((raw) => {
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 3
  ) {
    return `P${raw}`;
  }
  if (typeof raw === 'string') return raw.trim().toUpperCase();
  return raw;
}, z.enum(['P0', 'P1', 'P2', 'P3']));

/** Renomeia chaves de objetos sem perder as demais (tolerância a aliases). */
function withKeyAliases(
  aliases: Readonly<Record<string, string>>,
): (raw: unknown) => unknown {
  return (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      out[aliases[key] ?? key] = value;
    }
    return out;
  };
}

export const reviewFindingSchema = z.preprocess(
  // O agente reviewer original emite file_path/line_start/line_end.
  withKeyAliases({
    file_path: 'file',
    filePath: 'file',
    line_start: 'lineStart',
    line_end: 'lineEnd',
  }),
  z
    .object({
      /** Imperativo; o excedente além de 80 chars é truncado (tolerância). */
      title: z
        .string()
        .min(1)
        .transform((value) => value.slice(0, 80)),
      /** Um parágrafo: bug, condição de disparo, impacto. */
      body: z.string().min(1),
      priority: prioritySchema,
      /** Confiança de que é bug real (0-1). */
      confidence: confidenceSchema,
      /** Caminho do arquivo afetado. */
      file: z.string().min(1),
      /** Intervalo 1-indexado (≤10 linhas, sobrepondo o diff — regra de prompt). */
      lineStart: z.number().int().min(1),
      lineEnd: z.number().int().min(1),
    })
    .refine((finding) => finding.lineEnd >= finding.lineStart, {
      message: 'lineEnd deve ser maior ou igual a lineStart',
      path: ['lineEnd'],
    }),
);
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewFindingsSchema = z.preprocess(
  // O agente reviewer original chama o veredito de overall_correctness.
  withKeyAliases({
    overall_correctness: 'verdict',
    overallCorrectness: 'verdict',
  }),
  z.object({
    verdict: z.preprocess(
      (raw) => (typeof raw === 'string' ? raw.trim().toLowerCase() : raw),
      z.enum(['correct', 'incorrect']),
    ),
    /** Resumo do veredito em 1-3 frases. */
    explanation: z.string().min(1),
    /** Confiança do veredito (0-1). */
    confidence: confidenceSchema,
    findings: z.array(reviewFindingSchema).default([]),
  }),
);
export type ReviewFindings = z.infer<typeof reviewFindingsSchema>;

export class ReviewFindingsParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReviewFindingsParseError';
  }
}

const JSON_FENCE_PATTERN = /```(?:json)?\s*\n([\s\S]*?)```/gi;

/** Extrai candidatos a JSON de um texto: fences ```json, texto inteiro, ou o
 * maior trecho `{...}` (fallback para JSON inline sem fence). */
function candidatesFromText(text: string): unknown[] {
  const found: unknown[] = [];
  for (const match of text.matchAll(JSON_FENCE_PATTERN)) {
    try {
      found.push(JSON.parse(match[1]));
    } catch {
      // Fence sem JSON válido — segue para os demais candidatos.
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      found.push(JSON.parse(trimmed));
    } catch {
      // Não era o documento inteiro — tenta o recorte { ... } abaixo.
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      found.push(JSON.parse(text.slice(first, last + 1)));
    } catch {
      // Sem JSON embutido reconhecível.
    }
  }
  return found;
}

const MAX_CANDIDATE_DEPTH = 2;

/**
 * Coleta candidatos a ReviewFindings a partir de qualquer entrada razoável:
 * o próprio objeto, uma string com JSON embutido, um array de artifacts, ou
 * um handoff completo ({summary, artifacts, ...}).
 */
function collectCandidates(raw: unknown, depth = 0): unknown[] {
  if (raw == null || depth > MAX_CANDIDATE_DEPTH) return [];
  if (typeof raw === 'string') return candidatesFromText(raw);
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => collectCandidates(item, depth + 1));
  }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const out: unknown[] = [record];
    if (Array.isArray(record.artifacts)) {
      out.push(
        ...record.artifacts.flatMap((item) =>
          collectCandidates(item, depth + 1),
        ),
      );
    }
    if (typeof record.summary === 'string') {
      out.push(...candidatesFromText(record.summary));
    }
    return out;
  }
  return [];
}

/** Heurística: o candidato TENTOU ser um ReviewFindings? Se sim, um erro de
 * schema nele vira erro claro em vez do genérico "nada encontrado". */
function looksLikeReviewFindings(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    'verdict' in record ||
    'overall_correctness' in record ||
    'overallCorrectness' in record ||
    'findings' in record
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}

/**
 * Parse tolerante do veredito de review.
 *
 * Aceita: o objeto ReviewFindings direto; uma string (summary) contendo o
 * JSON em bloco ```json ou inline; o array `artifacts` do handoff; ou o
 * handoff inteiro. Lança `ReviewFindingsParseError` com o defeito de schema
 * quando um candidato claramente tentou ser um ReviewFindings e falhou
 * (ex.: priority fora de P0-P3), ou com uma mensagem de "não encontrado"
 * quando nenhum JSON reconhecível existe na entrada.
 */
export function parseReviewFindings(raw: unknown): ReviewFindings {
  let firstSchemaError: z.ZodError | null = null;
  for (const candidate of collectCandidates(raw)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const parsed = reviewFindingsSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    if (!firstSchemaError && looksLikeReviewFindings(candidate)) {
      firstSchemaError = parsed.error;
    }
  }
  if (firstSchemaError) {
    throw new ReviewFindingsParseError(
      `ReviewFindings inválido: ${formatIssues(firstSchemaError)}`,
      { cause: firstSchemaError },
    );
  }
  throw new ReviewFindingsParseError(
    'nenhum objeto ReviewFindings encontrado — esperado JSON com ' +
      '{verdict, explanation, confidence, findings[]} em bloco ```json no ' +
      'summary do handoff ou como item de artifacts',
  );
}

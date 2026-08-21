/**
 * Onda 3 — Router de intenção (o "cérebro barato" antes do motor).
 *
 * Regra de ouro (dossiê Overclock 21/08): inteligência decide O QUÊ,
 * mecânica garante QUE termina. Este módulo só CLASSIFICA e propõe rota;
 * fechamento/settlement/watchdogs continuam main-owned. Fail-open total:
 * sem key, timeout ou JSON inválido devolve null e o fluxo atual segue.
 */
import { loadLauncherProviderKey } from '../adapters/launcher-provider-manager';
import { hasRuntimeKey } from '../persistence/provider-config-store';

export type IntentRoute =
  | { readonly kind: 'direct-answer'; readonly question: string }
  | {
      readonly kind: 'mission-question';
      readonly question: string;
      readonly readOnlyWorkers: boolean;
    }
  | { readonly kind: 'mission-work'; readonly skills: readonly string[] };

const QUESTION_VERBS =
  /\b(crie|criar|construa|construir|implemente|implementar|escreva|escrever|desenvolva|refatore|migre|adicione|corrija|corrigir|integre|deploy|configure)\b/iu;

/** Tier 0 determinístico: pergunta pura curta nem vira missão. */
export function looksLikePureQuestion(objective: string): boolean {
  const text = objective.trim();
  if (!text || text.length > 160) return false;
  if (QUESTION_VERBS.test(text)) return false;
  return (
    text.includes('?') ||
    /^(quanto|qual|quais|quem|quando|onde|quantos|quantas)\b/iu.test(text)
  );
}

/** Extrai a PERGUNTA limpa de um objetivo meta-de-pane ("pergunte aos panes X"). */
export function extractQuestion(objective: string): string | null {
  const match = objective.match(
    /(?:pergunte|perguntar|ask)\b.*?\b(quanto|qual|quais|quem|quando|quantos|quantas|onde|como)\b([^\n]+)/iu,
  );
  const extracted = match ? `${match[1]}${match[2]}`.trim() : '';
  if (!extracted) return null;
  return (
    extracted
      .replace(/\s*[,.]?\s*(?:e\s+)?(?:aguarde|consolide|responda).*$/iu, '')
      .replace(/[,\s]+$/u, '')
      .trim() || null
  );
}

export type DeepSeekDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly apiKey?: string | null;
  readonly model?: string;
  readonly timeoutMs?: number;
};

const ROUTER_SYSTEM_PROMPT = [
  'Você é um classificador de intenção. Responda SOMENTE JSON.',
  'Formato: {"kind":"direct-answer","question":string} |',
  '{"kind":"mission-question","question":string,"readOnlyWorkers":true} |',
  '{"kind":"mission-work","skills":string[]}.',
  'direct-answer: pergunta trivial respondível sem arquivos/panes.',
  'mission-question: missão cujo trabalho é perguntar aos panes e consolidar.',
  'mission-work: tarefa real de código/design/produto; skills do catálogo Nexus',
  '(ex.: oc-design-dna, oc-site-premium, oc-game-build). Sem inventar skills.',
].join('\n');

/** Tier 1: classifica com LLM barata; qualquer falha ⇒ null (fail-open). */
export async function routeWithDeepSeek(
  objective: string,
  deps: DeepSeekDeps = {},
): Promise<IntentRoute | null> {
  const apiKey = deps.apiKey ?? null;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 6_000);
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: deps.model ?? 'deepseek-chat',
          messages: [
            { role: 'system', content: ROUTER_SYSTEM_PROMPT },
            { role: 'user', content: objective },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 220,
          temperature: 0,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    return parseRouteJson(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Valida o JSON da LLM contra as rotas conhecidas (não confia em nada). */
export function parseRouteJson(raw: string): IntentRoute | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const route = parsed as Record<string, unknown>;
  if (route.kind === 'direct-answer') {
    const question =
      typeof route.question === 'string' ? route.question.trim() : '';
    if (!question) return null;
    return { kind: 'direct-answer', question };
  }
  if (route.kind === 'mission-question') {
    const question =
      typeof route.question === 'string' ? route.question.trim() : '';
    if (!question) return null;
    return { kind: 'mission-question', question, readOnlyWorkers: true };
  }
  if (route.kind === 'mission-work') {
    const skills = Array.isArray(route.skills)
      ? route.skills.filter(
          (skill): skill is string =>
            typeof skill === 'string' && /^[a-z0-9-]{1,64}$/iu.test(skill),
        )
      : [];
    return { kind: 'mission-work', skills };
  }
  return null;
}

/**
 * Ponto único de decisão: Tier 0 determinístico primeiro (0ms), Tier 1
 * DeepSeek para o que heurística não resolve. Sem key → só Tier 0.
 */
export async function routeIntent(
  objective: string,
  deps: DeepSeekDeps & { readonly hasKey?: boolean } = {},
): Promise<IntentRoute | null> {
  if (looksLikePureQuestion(objective)) {
    return { kind: 'direct-answer', question: extractQuestion(objective) ?? objective };
  }
  const hasKey = deps.hasKey ?? hasRuntimeKey('deepseek');
  if (!hasKey) return null;
  const apiKey = deps.apiKey ?? loadLauncherProviderKey('deepseek');
  return routeWithDeepSeek(objective, { ...deps, apiKey });
}

/**
 * Onda 3 — Router de intenção (o "cérebro barato" antes do motor).
 *
 * Regra de ouro (dossiê Overclock 21/08): inteligência decide O QUÊ,
 * mecânica garante QUE termina. Este módulo CLASSIFICA, propõe rota e
 * RESPONDE perguntas triviais; fechamento/settlement/watchdogs continuam
 * main-owned. Dois tiers: Tier 0 determinístico (0ms) e Tier 1 na cadeia de
 * provedores baratos já configurados (deepseek → glm → qwen). Fail-open
 * total: sem key, timeout ou JSON inválido devolve null e o fluxo atual
 * segue — o router nunca pode derrubar o caminho de missão que já existia.
 */
import {
  hasRuntimeKey,
  isProviderEnabled,
  resolveRuntimeApiKey,
} from '../persistence/provider-config-store';
import { isPaneMetaTask, extractMetaPaneQuestion } from '../../shared/pane-meta-task';
import { routeWithJev } from './intent-router-jev';

export type IntentRoute =
  | { readonly kind: 'direct-answer'; readonly question: string }
  | {
      readonly kind: 'mission-question';
      readonly question: string;
      readonly readOnlyWorkers: boolean;
    }
  | { readonly kind: 'mission-work'; readonly skills: readonly string[] };

const QUESTION_VERBS =
  /\b(crie|criar|crio|construa|construir|implemente|implementar|escreva|escrever|desenvolva|refatore|migre|adicione|corrija|corrigir|integre|deploy|configure|monte|montar)\b/iu;

/**
 * Pedidos de CONHECIMENTO sem '?' nem começo interrogativo canônico — a
 * forma mais comum de pergunta de operador leigo ("me explique o que é git",
 * "como faço para trocar um pneu"). Sem estes anchors eles viravam missão
 * completa com squad por falta de '?' (matriz 23/08: 3 buracos).
 */
const KNOWLEDGE_REQUEST_RE =
  /^(?:me\s+)?(?:pode\s+|poderia\s+|consegue\s+)?(?:expli(?:ca|que)|diga|descreva|resum[ae]|cont[ae])\b/iu;
const KNOWLEDGE_QUESTION_RE =
  /^(?:o\s+que\s+(?:é|e|são|sao|significa)|quem\s+(?:foi|é|e|são|sao)|por\s*que|porque|porquê|qual\s+a\s+diferen|como\s+(?:faç[oa]|faco|posso|funciona|surge|nasceu|foi|era))/iu;

/**
 * Aberturas de pergunta que o leigo usa e que não começam por pronome
 * interrogativo nem por verbo de explicação (matriz 23/08: 8 de 12 perguntas
 * reais viravam missão com squad por não casarem em nenhum anchor).
 *
 * Todas ANCORADAS no início: "para que serve" no meio de uma frase é
 * descrição de trabalho ("quero uma página que explique para que serve o
 * produto"), não pergunta.
 */
const KNOWLEDGE_OPENER_RE =
  /^(?:tem\s+como|d[áa]\s+p(?:ra|ara)|[ée]\s+poss[íi]vel|vale\s+a\s+pena|p(?:ra|ara)\s+que\s+serve|n[ãa]o\s+entendi|me\s+ajuda\s+a\s+entender|preciso\s+saber|queria\s+saber|gostaria\s+de\s+saber|qual\s+a\s+diferen)/iu;

/** Toda abertura canônica de pergunta/conhecimento, num lugar só. */
function hasQuestionOpener(text: string): boolean {
  return (
    /^(quanto|qual|quais|quem|quando|onde|quantos|quantas)\b/iu.test(text) ||
    KNOWLEDGE_REQUEST_RE.test(text) ||
    KNOWLEDGE_QUESTION_RE.test(text) ||
    KNOWLEDGE_OPENER_RE.test(text)
  );
}

/** Verbo de trabalho logo na abertura = ordem imperativa, nunca pergunta. */
const IMPERATIVE_OPENER_RE =
  /^(?:me\s+|pode\s+|poderia\s+|por\s+favor\s+)*(?:crie|criar|crio|construa|construir|implemente|implementar|escreva|escrever|desenvolva|refatore|migre|adicione|corrija|corrigir|integre|deploy|configure|monte|montar)\b/iu;

/**
 * Tier 0 determinístico: pergunta pura nem vira missão.
 *
 * O veto por verbo de trabalho NÃO se aplica quando a frase abre com uma
 * pergunta canônica: "o que é preciso para criar um site?" tem '?', abre em
 * "o que é" e ainda assim virava missão porque continha "criar". O veto
 * agora só vale para o verbo NA ABERTURA (ordem imperativa) ou para frases
 * sem abertura de pergunta.
 */
export function looksLikePureQuestion(objective: string): boolean {
  const text = objective.trim();
  if (!text) return false;
  const opener = hasQuestionOpener(text);
  // Pergunta canônica pode ser longa (o leigo explica o contexto antes de
  // perguntar); sem abertura, o teto curto continua valendo.
  if (text.length > (opener ? 400 : 160)) return false;
  if (IMPERATIVE_OPENER_RE.test(text)) return false;
  if (!opener && QUESTION_VERBS.test(text)) return false;
  // Uma pergunta pura TERMINA no ponto de interrogação. Texto substancial
  // depois dele é pedido de trabalho embrulhado em cortesia — "tem como você
  // fazer isso? quero um ecommerce com carrinho e painel" — e continua sendo
  // missão.
  const mark = text.indexOf('?');
  if (mark >= 0 && text.slice(mark + 1).trim().length > 12) return false;
  return mark >= 0 || opener;
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

/** Dependências de rede/key do router — injetáveis para teste. */
export type RouterDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly apiKey?: string | null;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Entire classification chain, independent of each attempt timeout. */
  readonly totalTimeoutMs?: number;
  /** Jev intake triage — injectable; default calls the real Jev router. */
  readonly routeWithJev?: typeof routeWithJev;
};

const DEFAULT_ROUTER_TIMEOUT_MS = 6_000;

const ROUTER_SYSTEM_PROMPT = [
  'Você é um classificador de intenção. Responda SOMENTE JSON.',
  'Formato: {"kind":"direct-answer","question":string} |',
  '{"kind":"mission-question","question":string,"readOnlyWorkers":true} |',
  '{"kind":"mission-work","skills":string[]}.',
  'direct-answer: pergunta trivial respondível sem arquivos/panes.',
  'mission-question: missão cujo trabalho é perguntar aos panes e consolidar.',
  'mission-work: tarefa real de código/design/produto; skills SOMENTE do',
  'vocabulário Nexus: impeccable e dembrandt (UI/design), archify',
  '(diagramas), superpowers (planejamento/execução), bridgesecurity',
  '(segurança), bridgeward (web não confiável), nexus-visual-media (mídia).',
  'Sem inventar skills; na dúvida, devolva skills vazio.',
].join('\n');

/** Tier 1: classifica com LLM barata; qualquer falha ⇒ null (fail-open). */
export async function routeWithDeepSeek(
  objective: string,
  deps: RouterDeps = {},
): Promise<IntentRoute | null> {
  const apiKey = deps.apiKey ?? null;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS);
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
            typeof skill === 'string' && /^[a-z0-9-]{1,64}$/u.test(skill),
        )
      : [];
    return { kind: 'mission-work', skills };
  }
  return null;
}

/**
 * Ponto único de decisão: Tier 0 determinístico primeiro (0ms), Tier 1 na
 * PRIMEIRA key barata configurada (deepseek → glm → qwen) para o que a
 * heurística não resolve. Sem nenhuma key → só Tier 0. Fail-open total:
 * classificador fora do ar nunca derruba o fluxo de missão que já existia.
 */
/**
 * "quanto é 1+1? Depois crie um site" — a pergunta é isca. Trabalho DEPOIS
 * do ? é missão. Sem esta guarda o Tier 1 (LLM) devolve direct-answer.
 */
export function hasTrailingWorkAfterQuestion(objective: string): boolean {
  const text = objective.trim();
  const mark = text.indexOf('?');
  if (mark < 0) return false;
  const rest = text.slice(mark + 1).trim();
  if (rest.length <= 12) return false;
  return QUESTION_VERBS.test(rest) || IMPERATIVE_OPENER_RE.test(rest);
}

export async function routeIntent(
  objective: string,
  deps: RouterDeps & {
    readonly hasKeyFor?: (providerId: string) => boolean;
    readonly loadKeyFor?: (providerId: string) => string | null;
  } = {},
): Promise<IntentRoute | null> {
  // Guarda determinística ANTES de tudo: meta-de-pane ("pergunte aos panes…")
  // nunca é resposta direta — o operador pediu OS PANES, não uma resposta.
  // Com typo de ditado ("oergunta aos panes quwnto e 1+1") o Tier 0/1 pode
  // errar; o resultado tipado precisa acompanhar a preparação até o kickoff.
  if (isPaneMetaTask(objective)) return { kind: 'mission-question', question: extractMetaPaneQuestion(objective), readOnlyWorkers: true };
  if (hasTrailingWorkAfterQuestion(objective)) return null;
  if (looksLikePureQuestion(objective)) {
    return { kind: 'direct-answer', question: extractQuestion(objective) ?? objective };
  }
  // Triagem Jev (piloto automático, superfície `intake`): UMA chamada
  // classifica kind/complexidade/risco/ambiguidade/skills. Null = cai na
  // cadeia de provedores exatamente como antes — e o tempo do Jev conta
  // dentro do deadline total do router (o deadline nasce ANTES da chamada).
  const deadline = Date.now() + (deps.totalTimeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS);
  const viaJev = await (deps.routeWithJev ?? routeWithJev)(objective);
  if (viaJev) return viaJev;
  const hasKeyFor = deps.hasKeyFor ?? hasRuntimeKey;
  const loadKeyFor = deps.loadKeyFor ?? resolveRuntimeApiKey;
  for (const provider of ROUTER_PROVIDER_CHAIN) {
    if (Date.now() >= deadline) return null;
    if (!isProviderEnabled(provider.id) || !hasKeyFor(provider.id)) continue;
    const apiKey = deps.apiKey ?? loadKeyFor(provider.id);
    if (!apiKey) continue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    const route = await classifyWithProvider(provider, objective, apiKey, {
      ...deps,
      timeoutMs: Math.min(deps.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS, remainingMs),
    });
    if (route) return route;
  }
  return null;
}

/** Extrai o objeto JSON mesmo se o modelo embrulhar em prosa/markdown. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Classifica com um provedor da cadeia. DeepSeek fala OpenAI (com
 * response_format); glm/qwen falam Anthropic e dependem de extração
 * defensiva — parseRouteJson continua fail-closed com o conteúdo.
 */
async function classifyWithProvider(
  provider: RouterProvider,
  objective: string,
  apiKey: string,
  deps: RouterDeps,
): Promise<IntentRoute | null> {
  if (provider.style === 'openai') {
    return routeWithDeepSeek(objective, {
      ...deps,
      apiKey,
      model: provider.model,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(provider.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        system: ROUTER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: objective }],
        max_tokens: 220,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const json = extractJsonObject(text);
    return json ? parseRouteJson(json) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- */
/* Resposta direta — o router CLASSIFICA; quem responde é o provedor barato   */
/* já configurado pelo operador. Fail-open como o resto do módulo: qualquer   */
/* falha devolve null e o fluxo normal de missão segue.                        */
/* ------------------------------------------------------------------------- */

const ANSWER_SYSTEM_PROMPT = [
  'Você responde a pergunta do usuário de forma direta e curta, em',
  'português. Sem preâmbulo, sem disclaimers, sem oferecer passos extras.',
  'Se a pergunta exigir arquivos ou ações no computador, responda apenas',
  'com o JSON {"unanswerable":true}.',
].join('\n');

type RouterProvider = {
  readonly id: string;
  readonly style: 'openai' | 'anthropic';
  readonly endpoint: string;
  readonly model: string;
};

/**
 * Cadeia de provedores baratos, na ordem de custo — usada tanto para
 * CLASSIFICAR (Tier 1) quanto para RESPONDER perguntas diretas. As chaves
 * vêm do mesmo vault/launcher que o operador já configurou — nenhuma
 * credencial nova é pedida. Endpoints espelham os baseUrl de
 * UPSTREAM_PROVIDERS (launcher-provider-manager): deepseek fala OpenAI,
 * glm/qwen falam Anthropic.
 */
const ROUTER_PROVIDER_CHAIN: readonly RouterProvider[] = [
  {
    id: 'deepseek',
    style: 'openai',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
  },
  {
    id: 'glm',
    style: 'anthropic',
    endpoint: 'https://api.z.ai/api/anthropic/v1/messages',
    // Slot barato do provider glm no launcher (ANTHROPIC_DEFAULT_HAIKU_MODEL):
    // glm-5.3-flash — mais barato que o 4.7 e geração atual.
    model: 'glm-5.3-flash',
  },
  {
    id: 'qwen',
    style: 'anthropic',
    endpoint: 'https://dashscope.aliyuncs.com/api/anthropic/v1/messages',
    model: 'qwen3-coder',
  },
];

async function answerWithProvider(
  provider: RouterProvider,
  question: string,
  apiKey: string,
  deps: RouterDeps,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 10_000);
  try {
    const response = await (deps.fetchImpl ?? fetch)(provider.endpoint, {
      method: 'POST',
      headers:
        provider.style === 'openai'
          ? {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            }
          : {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
      body: JSON.stringify(
        provider.style === 'openai'
          ? {
              model: provider.model,
              messages: [
                { role: 'system', content: ANSWER_SYSTEM_PROMPT },
                { role: 'user', content: question },
              ],
              max_tokens: 300,
              temperature: 0,
            }
          : {
              model: provider.model,
              system: ANSWER_SYSTEM_PROMPT,
              messages: [{ role: 'user', content: question }],
              max_tokens: 300,
              temperature: 0,
            },
      ),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      content?: { type?: string; text?: string }[];
    };
    const text =
      provider.style === 'openai'
        ? (payload.choices?.[0]?.message?.content ?? '')
        : (payload.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('');
    const answer = text.trim();
    if (!answer || answer.includes('"unanswerable"')) return null;
    return answer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Responde uma pergunta trivial sem criar missão, squad ou pane. Primeiro
 * provedor com key configurada que responder ganha; sem key/falha ⇒ null e
 * quem chamou segue o fluxo normal (fail-open, como routeIntent).
 */
export async function answerDirectQuestion(
  question: string,
  deps: RouterDeps & {
    readonly hasKeyFor?: (providerId: string) => boolean;
    readonly loadKeyFor?: (providerId: string) => string | null;
  } = {},
): Promise<string | null> {
  const text = question.trim();
  if (!text) return null;
  const hasKeyFor = deps.hasKeyFor ?? hasRuntimeKey;
  const loadKeyFor = deps.loadKeyFor ?? resolveRuntimeApiKey;
  for (const provider of ROUTER_PROVIDER_CHAIN) {
    if (!isProviderEnabled(provider.id) || !hasKeyFor(provider.id)) continue;
    const apiKey = deps.apiKey ?? loadKeyFor(provider.id);
    if (!apiKey) continue;
    const answer = await answerWithProvider(provider, text, apiKey, deps);
    if (answer) return answer;
  }
  return null;
}

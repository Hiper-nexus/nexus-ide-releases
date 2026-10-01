/**
 * `nexus_tool_pick` — recomendação semântica de ferramenta via TypeSafe Jev.
 *
 * O Nexus expõe ~170 ferramentas; escolher a certa é o erro barato mais
 * frequente dos agentes (e o mais caro para modelos pequenos). Aqui o código
 * faz um pré-filtro lexical sobre as ferramentas que ESTE chamador pode usar
 * (allowlist, papel, read-only, disponibilidade) e UMA chamada `judge()`
 * escolhe entre os candidatos. Read-only: o agente continua chamando a
 * ferramenta ele mesmo. Lições de rubrica (handout 17/09): opção `none`
 * sempre presente; o nome completo vai na descrição (é o contraste entre
 * pares quase idênticos como pane_read × pane_read_many); a resposta traz
 * top-N com probabilidades e a MARGEM entre 1º e 2º — não corta por confiança.
 */
import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import {
  canonicalToolName,
  isToolAllowedForRole,
  type AgentGateContext,
} from './gate';
import { isToolAllowedForReadOnlyContext } from './mcp-effect-policy';
import { judge, USD_PER_INPUT_TOKEN, type JevQuestion } from '../jev/jev-client';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import { consumeJevRateSlot } from '../jev/jev-rate-limit';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';

const TOOL_PICK_NAME = 'nexus_tool_pick';
const MAX_CANDIDATES = 24;
const MIN_CANDIDATES = 8;
const DESCRIPTION_MAX = 200;
const JUDGE_TIMEOUT_MS = 8_000;

export const toolPickArgsSchema = z.object({
  need: z.string().min(1).max(1_000),
  limit: z.number().int().min(1).max(5).optional(),
});

/** Registro vivo das ferramentas do servidor — injetado no boot do MCP. */
let registryTools: readonly McpToolDef[] = [];

export function setToolPickRegistry(tools: readonly McpToolDef[]): void {
  registryTools = tools;
}

/** Sinônimos pt-BR → vocabulário dos nomes/descrições (em inglês). */
const SYNONYMS: Record<string, string[]> = {
  ver: ['read', 'inspect', 'show'],
  olhar: ['read', 'inspect'],
  ler: ['read'],
  leitura: ['read'],
  escrever: ['write'],
  escreva: ['write'],
  digitar: ['write', 'input'],
  enviar: ['write', 'send', 'submit'],
  mandar: ['write', 'send'],
  arquivo: ['file'],
  arquivos: ['files', 'file'],
  pasta: ['directory', 'folder'],
  rodar: ['run', 'terminal'],
  executar: ['run', 'execute', 'terminal'],
  comando: ['command', 'terminal'],
  missao: ['mission'],
  tarefa: ['task'],
  tarefas: ['tasks', 'todo'],
  navegador: ['browser'],
  pagina: ['page', 'browser'],
  tela: ['screen', 'ui', 'screenshot'],
  abrir: ['open', 'spawn'],
  criar: ['create', 'spawn'],
  fechar: ['close'],
  buscar: ['search', 'find'],
  procurar: ['search', 'find'],
  encontrar: ['find', 'search'],
  memoria: ['memory'],
  lembrar: ['memory', 'recall'],
  esperar: ['wait', 'idle'],
  aguardar: ['wait'],
  estado: ['status', 'state'],
  situacao: ['status'],
  listar: ['list'],
  lista: ['list'],
  outro: ['pane', 'peer'],
  outros: ['panes'],
  agente: ['agent', 'pane'],
  agentes: ['agents', 'panes'],
  entregar: ['handoff', 'submit'],
  entrega: ['handoff'],
  perguntar: ['ask', 'clarify'],
  pergunta: ['ask', 'clarify', 'question'],
  julgar: ['judge'],
  decidir: ['judge', 'route'],
  comparar: ['rank', 'diff'],
  diagrama: ['diagram', 'design'],
  imagem: ['image', 'screenshot'],
  captura: ['screenshot'],
  commit: ['commit', 'git'],
  branch: ['branch', 'git'],
  publicar: ['push', 'publish', 'pr'],
  revisar: ['review', 'pr'],
  seguranca: ['security', 'audit'],
  dependencias: ['dependencies', 'install'],
};

export function tokenize(text: string): string[] {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const out = new Set<string>(base);
  for (const token of base) {
    for (const syn of SYNONYMS[token] ?? []) out.add(syn);
  }
  return [...out];
}

interface Candidate {
  name: string;
  canonical: string;
  description: string;
  score: number;
}

/** Ferramentas visíveis a este chamador, no mesmo critério do tools/list. */
export function visibleToolsFor(
  ctx: AgentGateContext,
  tools: readonly McpToolDef[] = registryTools,
): McpToolDef[] {
  return tools.filter(
    (tool) =>
      tool.name !== TOOL_PICK_NAME &&
      isToolAllowedForRole(
        ctx.role,
        ctx.allowedTools,
        tool.name,
        ctx.petStudioMediaAuthority,
      ) &&
      (!ctx.readOnly || isToolAllowedForReadOnlyContext(tool.name)) &&
      (tool.available?.() ?? true),
  );
}

/** Pré-filtro lexical: nome pesa 2, descrição pesa 1; top 24, mínimo 8. */
export function prefilterCandidates(
  need: string,
  tools: readonly McpToolDef[],
): Candidate[] {
  const needTokens = new Set(tokenize(need));
  const scored: Candidate[] = tools.map((tool) => {
    const canonical = canonicalToolName(tool.name);
    const nameTokens = new Set(tokenize(canonical.replace(/_/g, ' ')));
    const descTokens = new Set(tokenize(tool.description));
    let score = 0;
    for (const token of needTokens) {
      if (nameTokens.has(token)) score += 2;
      else if (descTokens.has(token)) score += 1;
    }
    return { name: tool.name, canonical, description: tool.description, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const matched = scored.filter((c) => c.score > 0).slice(0, MAX_CANDIDATES);
  if (matched.length >= MIN_CANDIDATES) return matched;
  const chosen = new Set(matched.map((c) => c.name));
  const fill = scored
    .filter((c) => !chosen.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MIN_CANDIDATES - matched.length);
  return [...matched, ...fill];
}

function buildQuestion(candidates: Candidate[]): JevQuestion {
  const criteria: Record<string, string | null> = {};
  for (const c of candidates) {
    const desc = c.description.replace(/\s+/g, ' ').trim();
    criteria[c.canonical] =
      `${c.name}: ${desc.length > DESCRIPTION_MAX ? `${desc.slice(0, DESCRIPTION_MAX)}…` : desc}`;
  }
  criteria.none = 'no listed tool fits this need';
  return {
    type: 'choice',
    instructions:
      'Which of these tools best accomplishes what the agent says it needs to do ' +
      'right now? Prefer the most specific tool; choose none if nothing fits.',
    criteria,
  };
}

export interface ToolPickDeps {
  judge?: typeof judge;
  tools?: readonly McpToolDef[];
}

const toolPickTool: McpToolDef = {
  name: TOOL_PICK_NAME,
  available: () => hasDecisionCredential('toolPick'),
  description:
    'Semantic tool recommendation: describe what you need to do and get the ' +
    'best-matching nexus_* tools you are allowed to call, ranked by ' +
    'probability, plus the margin between the first two. Use it before ' +
    'guessing among many tools; then call the recommended tool yourself. ' +
    'Read-only; a `none` probability means nothing listed fits.',
  inputSchema: {
    type: 'object',
    properties: {
      need: {
        type: 'string',
        description: 'What you need to accomplish right now, in your own words',
      },
      limit: { type: 'number', description: 'How many picks to return (1-5, default 3)' },
    },
    required: ['need'],
  },
  handler: async (args, ctx, invocation) => runToolPick(args, ctx, invocation, {}),
};

export async function runToolPick(
  args: Record<string, unknown>,
  ctx: AgentGateContext,
  invocation: Parameters<McpToolDef['handler']>[2],
  deps: ToolPickDeps,
): Promise<Record<string, unknown>> {
  const parsed = toolPickArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `nexus_tool_pick: argumentos inválidos: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  if (!hasDecisionCredential('toolPick')) {
    throw new Error(
      'nexus_tool_pick indisponível: configure Jev ou Clef em Ajustes → Chaves de API',
    );
  }
  if (!consumeJevRateSlot(ctx.sessionId ?? ctx.token)) {
    throw new Error('nexus_tool_pick: limite de 30 chamadas/min por sessão');
  }
  const visible = visibleToolsFor(ctx, deps.tools ?? registryTools);
  const candidates = prefilterCandidates(parsed.data.need, visible);
  if (candidates.length < 2) {
    return { picks: [], top: null, margin: 0, confidence: 0, none: 1, candidates: 0 };
  }
  const question = buildQuestion(candidates);
  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: { need: parsed.data.need },
    questions: { tool: question },
    timeoutMs: JUDGE_TIMEOUT_MS,
    signal: invocation?.signal,
    surface: 'toolPick',
  });
  assertMcpInvocationCurrent(invocation);
  if (!result) {
    throw new Error(
      'nexus_tool_pick: modelo de decisão selecionado indisponível agora (timeout/erro). Escolha a ferramenta você mesmo.',
    );
  }
  const answer = result.answers.tool;
  if (answer?.type !== 'choice') {
    throw new Error('nexus_tool_pick: resposta inesperada do serviço');
  }
  const byCanonical = new Map(candidates.map((c) => [c.canonical, c]));
  const ranked = Object.entries(answer.probabilities)
    .filter(([id]) => id !== 'none' && byCanonical.has(id))
    .sort((a, b) => b[1] - a[1]);
  const limit = parsed.data.limit ?? 3;
  const picks = ranked.slice(0, limit).map(([id, probability]) => {
    const c = byCanonical.get(id)!;
    return { tool: c.name, probability, description: c.description };
  });
  const none = answer.probabilities.none ?? 0;
  const top = picks[0]?.tool ?? null;
  const margin = (ranked[0]?.[1] ?? 0) - (ranked[1]?.[1] ?? 0);
  recordJevDecision({
    surface: 'toolPick',
    sessionId: ctx.sessionId,
    missionId: ctx.missionId,
    model: result.model,
    questions: ['tool'],
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: top ? `pick:${canonicalToolName(top)}` : 'pick:none',
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });
  return {
    picks,
    top,
    margin,
    confidence: answer.confidence,
    none,
    candidates: candidates.length,
    model: result.model,
  };
}

export function buildToolPickTools(): McpToolDef[] {
  return [toolPickTool];
}

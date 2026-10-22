// POST /hook/delegate — contexto do motor para os panes sem missão via hook
// `UserPromptSubmit` (C2, 25/09): conselho de delegação do Jev, lembrete da
// ponytail e, em pedido de interface, a regra de design do projeto com a Carta
// de Design — o que um worker recebe no prompt de spawn e o pane "+" não tinha.
// Mesmo servidor loopback e bearer do /hook/triage. A resposta vira
// `additionalContext`. Nunca atrapalha: qualquer coisa fora do caminho feliz
// responde `{}` com 200.
import type http from 'node:http';
import { createHash } from 'node:crypto';
import type { AgentGateContext } from './gate';
import { isOperatorHandContext, providerReceivesContextOnlyByHook } from './operator-hand-context';
import {
  advisePrompt,
  AUTO_ORCHESTRATE_MIN_CONFIDENCE,
  DELEGATE_TIMEOUT_MS,
  type DelegationAdvice,
} from '../jev/jev-delegation';
import { handleHookJsonPost } from './hook-http';
import {
  WORKSPACE_DESIGN_RULE_HEADING,
  operatorDesignContext,
} from './workspace-design-rule';
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from './workspace-handoff-delivery';
import { OPERATOR_DELEGATION_DOCTRINE } from './operator-delegation-doctrine';
import {
  operatorBusinessModelContext,
  providerHasDelegateHook,
} from './operator-business-model';
import { taskBusinessContextBlock } from '../context/business-model/business-model-context-block';
import { ensureBusinessModel } from '../context/business-model/business-model-ensure';
import { editedFilesForSession } from './hook-edit-provenance';
import { distillOperatorPreferenceMemory } from '../memory/operator-preference-memory';
import { operatorWorkspaceMemoryContext } from './operator-workspace-memory';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { getOrchSettings } from '../persistence/settings-store';
import {
  adoptThroughOperatorTabMission,
  suggestOperatorRoute,
  type OperatorTabMission,
} from './tools-panes';
import { taskNeedsWebSearch } from './task-router';
import { getAdapter } from '../adapters/adapter-registry';
import { isJevAutopilotEnabled } from '../jev/jev-autopilot';
import { trace } from '../observability/main-trace';
import { maestroStandingDoctrineFor } from './maestro-standing-context';
import {
  skillSuggestionDegradation,
  suggestSkillForTask,
  SKILL_SUGGESTION_MIN_CONFIDENCE,
} from './jev-skill-suggestion';
import { helpersToOpenNow, type ParallelHelperBudget } from './pane-admission';
import { currentParallelHelperBudget } from './parallel-helper-budget';
import { isRecentHumanPrompt } from './operator-input-receipts';

export const HOOK_DELEGATE_MAX_BODY_BYTES = 64 * 1024;

export function parseUserPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const prompt = (body as Record<string, unknown>).prompt;
  if (typeof prompt === 'string') return prompt.trim() ? prompt : null;
  // F-802: o Kimi manda o conteúdo da mensagem como partes (`[{type:'text',text}]`),
  // não como string — só o texto conta, como no `matcherValueText` dele.
  if (Array.isArray(prompt)) {
    const text = prompt
      .map((part: unknown) =>
        part && typeof part === 'object' &&
        (part as Record<string, unknown>).type === 'text' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? ((part as Record<string, unknown>).text as string)
          : '',
      )
      .join('\n');
    return text.trim() ? text : null;
  }
  return null;
}

/** A partir desta probabilidade o pedido conta como escrever código. */
export const LEAN_REMINDER_MIN_WRITES_CODE = 0.6;
/** Os lembretes ficam no histórico da conversa: cada um, uma vez por sessão a cada 30 min. */
export const LEAN_REMINDER_INTERVAL_MS = 30 * 60_000;

/**
 * O Codex entrega o additionalContext como mensagem developer DEPOIS do prompt
 * (openai/codex#40680) e o Kimi anexa a saída do hook como mensagem de usuário
 * depois dele; sem este aviso o modelo pode tomá-lo pela tarefa.
 */
export const AUXILIARY_CONTEXT_HEADER =
  '[Nexus] Contexto auxiliar para a mensagem do operador acima; não é uma nova tarefa.';

/** Cabeçalhos que o prompt de spawn já traz: helper que nasceu com eles não os recebe de novo. */
const PONYTAIL_RULES_HEADING = '# Ponytail';
const DESIGN_CHARTER_HEADING = '# Design Charter';

/**
 * Lembrete da skill ponytail (código enxuto) para os panes do operador: os
 * helpers já a recebem no contrato do prompt, mas o pane "+" só a tinha
 * instalada, à espera de o modelo decidir usá-la. Curto de propósito — as
 * regras completas vivem na skill.
 */
export const LEAN_CODE_REMINDER =
  '[Nexus] Pedido de código: siga a skill ponytail — mapeie tudo que a mudança ' +
  'alcança, reuse o que já existe, nada de abstração que ninguém pediu, o menor ' +
  'diff correto, um teste pequeno, e feche dizendo o que pulou e o risco.';

/**
 * Pré-filtro barato (regex, sem chamada ao Jev) para pedidos de página/
 * extração/responsividade/screenshot: sem isto o pane "+" usa WebFetch,
 * Playwright ou Firecrawl mesmo quando o navegador do Nexus já está aberto
 * com sessão e cookies.
 */
const BROWSER_REQUEST_PATTERN =
  /\bscrape\b|\bscreenshot\b|\bcaptur(a|e|ar)\s+(a\s+|de\s+)?tela\b|\bresponsiv(idade|o|a|eness)\b|\banalis(e|ar)\s+.{0,20}\b(p[aá]gina|site|url)\b|\bp[aá]gina[s]?\s+web\b/i;

// "extrair" sozinho também é zip/método/refactor: só conta com contexto web.
const BROWSER_EXTRACT_PATTERN = /\bextra(ir|ia|indo|[cç][aã]o)\b/i;
const WEB_CONTEXT_PATTERN = /https?:\/\/|\bp[aá]gina|\bsite\b|\burl\b|\bweb\b/i;

function isBrowserRequest(prompt: string): boolean {
  return (
    BROWSER_REQUEST_PATTERN.test(prompt) ||
    (BROWSER_EXTRACT_PATTERN.test(prompt) && WEB_CONTEXT_PATTERN.test(prompt))
  );
}

/**
 * Pré-filtro barato (regex, sem chamada ao Jev) para pedido de código, no mesmo
 * molde do de navegador acima. Sem ele, o pane "+" de quem não tem credencial
 * do Jev — ou com o Jev desligado, fora do ar ou estourando os 2,5 s — nunca
 * ouve falar da ponytail: a skill fica só instalada, à espera de o modelo
 * decidir usá-la. Verbo de ESCRITA só: ler, explicar e analisar não entram. E
 * só com contexto de código: "escreva o PRD", "crie um resumo" e "ajuste o
 * texto" também são escrita. Uma ordem de refatorar basta sozinha. É heurística
 * de reserva: com o Jev no ar, quem decide é ele.
 */
const CODE_WRITE_VERB_PATTERN =
  /\b(implement(a|e|ar)?|corrij(a|ir)|corrigir|conserta(r)?|arrum(a|ar)?|ajust(a|e|ar)|escrev(a|er)|cri(a|e|ar)|adicion(a|e|ar)|remov(a|er)|apag(a|ue|ar)|migra(r)?|renomei(a|e)|renomear|edit(a|e|ar)|mud(a|e|ar)|alter(a|e|ar)|modifi(ca|que|car)|fa[cç]a|fazer|fix|implement|rewrite|rename|migrate|add|create|delete|remove|update|write|build|edit|change|modify|make)\b/iu;
/**
 * Refatorar é de código por definição, mas só como ORDEM: no começo da frase
 * ou depois de "please/pode/vamos". "Explain the refactor", "do not
 * refactor" e "a refatoração" ficam de fora; `(?!\p{L})` impede casar
 * "refatora" dentro de "refatoração" (o `\b` não vê o "ç" como letra).
 */
const REFACTOR_COMMAND_PATTERN =
  /(?:^|[.;!?:]\s*|\b(?:please|can you|could you|let'?s|por favor|pode|podes|vamos)\s+)(?:refator(?:e|a|ar)|refactor)(?!\p{L})/iu;
/** Marcador que só aparece em código: basta com o verbo. */
const STRONG_CODE_CONTEXT_PATTERN =
  /\b(c[oó]digo|code|fun[cç][aã]o|function|m[eé]todo|method|classe|class|componentes?|components?|endpoint|rota|route|handler|hook|m[oó]dulo|module|script|query|schema|migra[cç][aã]o|migration|valida[cç][aã]o|validation|vari[aá]vel|variable|import|lint|typecheck|banco de dados|database|sql|regex|frontend|backend)\b|`[^`]+`|\b[\w-]+\.(tsx?|jsx?|mjs|cjs|json|vue|svelte|py|go|rs|java|kt|swift|rb|php|cs|cpp|hpp|css|scss|html|xml|sql|sh|ya?ml|toml|gradle|tf)\b|\b(src|lib|app)\//iu;
/**
 * Marcador ambíguo: também nomeia texto ("commit message", "bug report",
 * "API summary", "relatório de testes"). Só conta quando o pedido não é um
 * desses textos.
 */
const WEAK_CODE_CONTEXT_PATTERN =
  /\b(testes?|tests?|bug|api|branch|commit|reposit[oó]rio|repo)\b/iu;
const TEXT_ARTIFACT_PATTERN =
  /\b(message|mensagem|report|relat[oó]rio|summary|resumo|e-?mail|prd|post|artigo|article|documenta[cç][aã]o|readme|changelog|release notes|ata|apresenta[cç][aã]o)\b/iu;

function isCodeRequest(prompt: string): boolean {
  const text = prompt.trim();
  if (REFACTOR_COMMAND_PATTERN.test(text)) return !TEXT_ARTIFACT_PATTERN.test(text);
  if (!CODE_WRITE_VERB_PATTERN.test(prompt)) return false;
  return STRONG_CODE_CONTEXT_PATTERN.test(prompt) ||
    (WEAK_CODE_CONTEXT_PATTERN.test(prompt) && !TEXT_ARTIFACT_PATTERN.test(prompt));
}

export const BROWSER_TOOL_HINT =
  '[Nexus · Jev] Para analisar páginas, extrair dados ou testar responsividade, ' +
  'use nexus_browser_* (o navegador do Nexus já está aberto, com sessão) — não ' +
  'WebFetch, Playwright ou Firecrawl para uma URL que será aberta agora. ' +
  'Responsividade num só chamado: nexus_browser_responsive.';

/**
 * Lembrete do Maestro (F-701) no prompt, a cada 30 min por sessão. A doutrina
 * inteira já está nas instructions do MCP; o Codex, que não as recebe, ganha
 * a doutrina no lugar deste lembrete. Bug7: o promovido da mão do operador
 * também nunca a recebeu pelo MCP (o initialize foi como `user`), então
 * também ganha a doutrina inteira aqui — ver maestroContextFor.
 */
export const MAESTRO_TURN_REMINDER =
  '[Nexus] Maestro: o trabalho da missão vai para workers (nexus_pane_spawn, ' +
  'os independentes em paralelo); seu pane coordena, integra e valida. ' +
  'Trabalho restante sem worker vivo: abra os workers agora. ' +
  'Entrega com código: veredito de modelo de ponta antes de integrar. ' +
  // F-1633: "rode o teste" fixo manda a entrega de aparência para um teste que
  // não existe; a prova dela é a captura do navegador. E sem o gesto de ACEITE
  // o laço só tinha a saída que custa outra rodada do worker.
  'Handoff é alegação: confira o diff e rode o teste da correção (entrega de ' +
  'aparência: captura do navegador), depois aceite com nexus_handoff_ack accepted.';

const maestroRemindedAt = new Map<string, number>();
const leanRemindedAt = new Map<string, number>();
const designRemindedAt = new Map<string, number>();
const doctrineDeliveredAt = new Map<string, number>();
const businessModelDeliveredAt = new Map<string, { hash: string; at: number }>();
const businessEnsureAt = new Map<string, number>();
const browserHintDeliveredAt = new Map<string, number>();
const memoryDeliveredAt = new Map<string, { hash: string; at: number }>();
/** F-753: mesma skill sugerida ao mesmo pane no máximo a cada 30 min. */
const skillHintDeliveredAt = new Map<string, number>();
/** F-1309: o aviso de degradação da sugestão de skill, uma vez por sessão. */
const skillDegradationDeliveredAt = new Map<string, number>();
/** F-802: a dica de CLI melhor, uma vez por sessão a cada 30 min. */
const routeHintDeliveredAt = new Map<string, number>();

/**
 * Confiança mínima para a dica de skill entrar no pedido. F-1306: é o MESMO
 * piso do parse e do spawn (`SKILL_SUGGESTION_MIN_CONFIDENCE`) — uma fonte só.
 */
export const OPERATOR_SKILL_HINT_MIN_CONFIDENCE = SKILL_SUGGESTION_MIN_CONFIDENCE;

export function operatorSkillHint(skill: { name: string; path?: string }): string {
  return skill.path
    ? `[Nexus · Jev] Skill útil para este pedido: ${skill.name} — leia \`${skill.path}\` antes de começar.`
    : `[Nexus · Jev] Skill útil para este pedido: ${skill.name} — leia a SKILL.md dela antes de começar.`;
}

function remindedRecently(ledger: Map<string, number>, sessionId: string, now: number): boolean {
  const last = ledger.get(sessionId);
  return last !== undefined && now - last < LEAN_REMINDER_INTERVAL_MS;
}

function markReminded(ledger: Map<string, number>, sessionId: string, now: number): void {
  for (const [id, at] of ledger) {
    if (now - at >= LEAN_REMINDER_INTERVAL_MS) ledger.delete(id);
  }
  ledger.set(sessionId, now);
}

function claimLeanReminder(sessionId: string, now: number): boolean {
  if (remindedRecently(leanRemindedAt, sessionId, now)) return false;
  markReminded(leanRemindedAt, sessionId, now);
  return true;
}

/** Test-only: esquece quem já recebeu os lembretes. */
export function __resetLeanRemindersForTests(): void {
  maestroRemindedAt.clear();
  leanRemindedAt.clear();
  designRemindedAt.clear();
  doctrineDeliveredAt.clear();
  businessModelDeliveredAt.clear();
  businessEnsureAt.clear();
  browserHintDeliveredAt.clear();
  memoryDeliveredAt.clear();
  skillHintDeliveredAt.clear();
  skillDegradationDeliveredAt.clear();
  routeHintDeliveredAt.clear();
}

/** Orçamento da dica de rota: o hook do Claude morre aos 5 s e leva o resto junto. */
export const ROUTE_HINT_DEADLINE_MS = 1_500;
/** Só o começo do pedido é varrido: o custo não cresce com o paste do operador. */
const ROUTE_HINT_SCAN_CHARS = 4_000;

export interface RouteHintDeps {
  autopilot?: () => boolean;
  /** A CLI do pane tem busca na web confirmada no manifesto? Desconhecida → sim (sem dica). */
  paneHasWebSearch?: (providerId: string | undefined) => boolean;
  suggestRoute?: (task: string, ctx: HookContext) => Promise<Record<string, unknown>> | null;
  deadlineMs?: number;
}

function defaultPaneHasWebSearch(providerId: string | undefined): boolean {
  const adapter = providerId ? getAdapter(providerId) : null;
  return adapter?.kind !== 'cli-pty' || adapter.capabilities?.webSearch === true;
}

/**
 * F-802: o pedido exige trabalho que a CLI deste pane não confirma ter — busca
 * na web (o MiMo respondeu "WebSearch indisponível neste pane", 02/10) — e outra
 * CLI do Nexus tem. Uma linha, sem forçar: a rota vem do mesmo motor do
 * nexus_pane_spawn, SEM chamar o Jev (não gasta a chave do operador) e sem
 * registrar decisão. Piloto automático desligado, CLI com busca confirmada, ou
 * qualquer atraso/erro: nada.
 */
export async function operatorRouteHint(
  ctx: HookContext,
  prompt: string,
  deps: RouteHintDeps = {},
): Promise<string | null> {
  if (!taskNeedsWebSearch(prompt.slice(0, ROUTE_HINT_SCAN_CHARS))) return null;
  if (!(deps.autopilot ?? isJevAutopilotEnabled)()) return null;
  if ((deps.paneHasWebSearch ?? defaultPaneHasWebSearch)(ctx.providerId)) return null;
  const own = ctx.providerId ?? 'esta';
  let target = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = (deps.suggestRoute ?? ((task, c) => suggestOperatorRoute(task, c as AgentGateContext)))(
      prompt,
      ctx,
    );
    if (pending) {
      const route = await Promise.race([
        pending.catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deps.deadlineMs ?? ROUTE_HINT_DEADLINE_MS);
        }),
      ]);
      const adapterId = typeof route?.adapterId === 'string' ? route.adapterId : '';
      const model = typeof route?.model === 'string' ? route.model : '';
      // A rota repetir a CLI do pane não ensina nada: sem dica.
      if (adapterId && adapterId === ctx.providerId) return null;
      target = adapterId ? ` (rota sugerida: ${adapterId}${model ? ` ${model}` : ''})` : '';
    }
  } catch {
    target = '';
  } finally {
    if (timer) clearTimeout(timer);
  }
  return (
    `[Nexus · Jev] Este pedido precisa de busca na web, que o Nexus não confirma na CLI deste pane (${own}). ` +
    `Para garantir a ferramenta, delegue com nexus_pane_spawn({ task, prompt })${target} — o Nexus escolhe a CLI; é só uma sugestão.`
  );
}

type MemoryBlockFn = typeof operatorWorkspaceMemoryContext;

/**
 * `<business-model>` por tarefa para o pane da mão do operador (mesmo canal
 * da memória: o bloco IDÊNTICO entregue na última meia hora é suprimido; uma
 * seleção nova — outra tarefa, outro fluxo — sempre passa). O bloco estático
 * do MCP é o fallback quando a seleção não acha nada ou não há modelo.
 */
type BusinessContextFn = (
  ctx: HookContext,
  prompt: string,
) => Promise<string | null>;

// O hook do operador morre em ~4 s no curl (Claude mata aos 5). A seleção
// por tarefa pode esperar até 6 s de Jev — estourado o prazo, TODO o
// additionalContext da rodada ia embora em silêncio. Deadline duro: passou,
// cai no bloco estático (que já é contexto de negócio válido).
const BUSINESS_CONTEXT_DEADLINE_MS = 1_500;

async function defaultBusinessContext(
  ctx: HookContext,
  prompt: string,
): Promise<string | null> {
  if (!isOperatorHandContext(ctx) || !providerHasDelegateHook(ctx.providerId)) {
    return null;
  }
  const scope = ctx.executionScope ?? ctx.scope;
  if (!scope) return null;
  const selected = await Promise.race([
    taskBusinessContextBlock(scope, prompt, ctx.scope, {
      sessionId: ctx.sessionId,
      // F-1347: o que esta conversa já editou (proveniência do PostToolUse).
      touchedFiles: editedFilesForSession(ctx.sessionId, scope.rootRealPath),
    }),
    new Promise<null>((resolve) =>
      setTimeout(resolve, BUSINESS_CONTEXT_DEADLINE_MS),
    ),
  ]);
  return selected ?? operatorBusinessModelContext(ctx, 'hook');
}

function businessContextFor(
  ctx: HookContext,
  prompt: string,
  now: number,
  block: BusinessContextFn,
): Promise<string | null> {
  if (!ctx.sessionId) return Promise.resolve(null);
  const scope = ctx.executionScope ?? ctx.scope;
  return block(ctx, prompt).then((context) => {
    if (!context) return null;
    const hash = createHash('sha256')
      .update(JSON.stringify([scope?.projectId, scope?.checkoutId, scope?.rootRealPath, context]))
      .digest('hex');
    const previous = businessModelDeliveredAt.get(ctx.sessionId!);
    if (previous?.hash === hash && now - previous.at < LEAN_REMINDER_INTERVAL_MS) return null;
    for (const [id, entry] of businessModelDeliveredAt) {
      if (now - entry.at >= LEAN_REMINDER_INTERVAL_MS) businessModelDeliveredAt.delete(id);
    }
    businessModelDeliveredAt.set(ctx.sessionId!, { hash, at: now });
    return context;
  }).catch(() => null);
}

/**
 * `<workspace-memory>` do Codex "+ Pane" (os demais recebem pelo MCP), como o
 * modelo de negócio. A consulta segue a tarefa atual: só um bloco IDÊNTICO
 * já entregue é suprimido por 30 min. Trocar de assunto não perde memória
 * relevante. Banco sem hit não marca a sessão.
 */
function memoryContextFor(
  ctx: HookContext,
  prompt: string,
  now: number,
  block: MemoryBlockFn,
): string | null {
  if (!ctx.sessionId) return null;
  let acknowledge: (() => void) | undefined;
  const context = block(ctx, 'hook', prompt, (ack) => { acknowledge = ack; });
  if (!context) return null;
  const scope = ctx.executionScope ?? ctx.scope;
  const hash = createHash('sha256')
    .update(JSON.stringify([scope?.projectId, scope?.checkoutId, scope?.rootRealPath, context]))
    .digest('hex');
  const previous = memoryDeliveredAt.get(ctx.sessionId);
  if (previous?.hash === hash && now - previous.at < LEAN_REMINDER_INTERVAL_MS) return null;
  for (const [id, entry] of memoryDeliveredAt) {
    if (now - entry.at >= LEAN_REMINDER_INTERVAL_MS) memoryDeliveredAt.delete(id);
  }
  memoryDeliveredAt.set(ctx.sessionId, { hash, at: now });
  acknowledge?.();
  return context;
}

type HookContext = Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'> &
  Partial<
    Pick<
      AgentGateContext,
      | 'scope'
      | 'executionScope'
      | 'providerId'
      | 'operatorParentSessionId'
      | 'promotedFromUserSession'
      | 'allowedSkills'
    >
  >;

/**
 * Só o que o humano digita no pane que ELE abriu vira preferência: helper
 * (tem `operatorParentSessionId`, o brief é do agente pai) e texto que o
 * próprio Nexus cola (pack de failover) nunca.
 */
function typedByOperator(ctx: HookContext, prompt: string): boolean {
  return ctx.operatorParentSessionId === undefined && !prompt.includes(FAILOVER_HANDOFF_HEADER);
}

/**
 * Texto que o harness ou o Nexus injeta como prompt mas que NÃO é pedido do
 * operador (notificação de task, entrega de handoff, feedback de hook Stop,
 * corpo de skill, avisos [Nexus]). Julgar isso com o Jev gerou conselhos como
 * "delegate:5p" em mensagem que ninguém escreveu — nem a dica vale aqui.
 * O `<pasted_content …>` que embrulha a entrega sai antes de comparar.
 */
const NON_OPERATOR_PROMPT_PREFIXES = [
  '<task-notification>',
  '[nexus handoff delivery_metadata]',
  'Stop hook feedback:',
  'Base directory for this skill:',
  '[Nexus]',
  '[Nexus ·',
  // F-784: o empurrão de continuidade que o próprio Nexus digita no pane
  // (failover-continuity, terminal-host) também ia ao Jev como pedido.
  'Continue the current mission from exactly where you stopped',
];

function isNonOperatorPrompt(prompt: string): boolean {
  const head = prompt.trim().replace(/^<pasted_content\b[^>]*>/u, '').trim();
  return NON_OPERATOR_PROMPT_PREFIXES.some((prefix) => head.startsWith(prefix));
}

type MaestroDoctrineFn = (ctx: HookContext) => string | null;
type ParallelBudgetFn = () => ParallelHelperBudget | null;

/** Uma leitura do orçamento por pedido, só se alguém precisar dele. */
function onceBudget(read: ParallelBudgetFn): ParallelBudgetFn {
  let cached: ParallelHelperBudget | null | undefined;
  return () => {
    if (cached === undefined) cached = read();
    return cached;
  };
}

/** O que fixou o teto seguro, em pt-BR curto (vai dentro das dicas). */
function budgetCeilingNote(budget: ParallelHelperBudget): string {
  if (budget.limitedBy === 'swap') return 'swap acima do limite desta máquina';
  if (budget.limitedBy === 'license') return 'limite de agentes do plano menos 2 vagas para Maestro e revisor';
  if (budget.limitedBy === 'memory' && budget.freeMB !== null) {
    return `${(budget.freeMB / 1024).toFixed(1).replace('.', ',')} GB de memória livre`;
  }
  return `${budget.liveAgentPanes} de ${budget.maxAgentPanes} panes de agente vivos`;
}

/**
 * F-784: quantos abrir agora — todas as partes até o teto seguro; o que não
 * cabe vai quando os primeiros entregarem (nada de "um por parte" numa
 * máquina com 15 CLIs vivas e o swap cheio).
 */
function parallelWave(parts: number, budget: ParallelHelperBudget | null): string {
  const open = helpersToOpenNow(parts, budget);
  return budget && open < parts
    ? `${open} em paralelo agora (teto seguro: ${budgetCeilingNote(budget)}), o resto quando esses entregarem`
    : `${open} em paralelo agora`;
}

function maestroContextFor(
  ctx: HookContext,
  now: number,
  doctrineFor: MaestroDoctrineFn,
  budgetOf: ParallelBudgetFn,
): string | null {
  if (ctx.role !== 'orchestrator' || !ctx.missionId || !ctx.sessionId) return null;
  if (remindedRecently(maestroRemindedAt, ctx.sessionId, now)) return null;
  const doctrine = doctrineFor(ctx);
  if (!doctrine) return null;
  markReminded(maestroRemindedAt, ctx.sessionId, now);
  // Bug7: promovido de `user` nunca recebeu a doutrina pelas instructions do
  // MCP (initialize único, antes da promoção) — recebe a inteira pelo hook,
  // como Codex/Kimi, e não o lembrete que pressupõe esse canal.
  const text =
    ctx.promotedFromUserSession === true || providerReceivesContextOnlyByHook(ctx.providerId)
      ? doctrine
      : MAESTRO_TURN_REMINDER;
  // F-784: o lembrete manda abrir workers; com a máquina no teto seguro ele
  // diz o contrário, com o número.
  const budget = budgetOf();
  return budget && budget.slots === 0
    ? `${text}\n[Nexus] Teto seguro desta máquina atingido agora ` +
        `(${budgetCeilingNote(budget)}): não abra workers novos até algum ` +
        'entregar; feche os panes que já entregaram.'
    : text;
}

/** Maestro de missão que não é a mão do operador (essa já recebe o conselho). */
function isMissionMaestro(ctx: HookContext): boolean {
  return ctx.role === 'orchestrator' && Boolean(ctx.missionId) && ctx.promotedFromUserSession !== true;
}

/**
 * F-708: o que o operador digita no Maestro é o pedido que ele deve dividir.
 * Até aqui só a mão do operador passava pelo Jev de delegação; o Maestro, que
 * é quem mais delega, recebia só o lembrete genérico — e em 30/09 respondeu
 * "vinha atuando direto na Inbox". Missão de execução direta fica de fora
 * (a doutrina dela manda executar).
 */
async function maestroDelegationDirective(
  ctx: HookContext,
  prompt: string,
  advise: typeof advisePrompt,
  doctrineFor: MaestroDoctrineFn,
  budgetOf: ParallelBudgetFn,
): Promise<string | null> {
  if (!doctrineFor(ctx)) return null;
  const advice = await advise(prompt, { sessionId: ctx.sessionId, missionId: ctx.missionId }).catch(() => null);
  const delegation = advice?.delegation;
  if (!delegation || (delegation.parts < 2 && !delegation.heavyRead)) return null;
  const budget = budgetOf();
  const work = delegation.heavyRead
    ? 'este pedido é uma leitura pesada'
    : `este pedido se divide em ${splitSizeText(delegation)} ` +
      `(${splitCountsText(delegation)})`;
  let text: string;
  if (budget && helpersToOpenNow(delegation.parts, budget) === 0) {
    text =
      `[Nexus · Jev] Maestro: ${work}, mas a máquina está no teto seguro agora ` +
      `(${budgetCeilingNote(budget)}): não abra workers — espere as entregas, ` +
      'feche os panes que já entregaram e despache quando houver vaga.';
  } else if (delegation.heavyRead) {
    text =
      `[Nexus · Jev] Maestro: ${work}. Abra um worker com ` +
      'nexus_pane_spawn({ task, prompt, readOnly: true }) para ela e encerre o ' +
      'turno. Não faça a leitura você mesmo.';
  } else {
    text =
      `[Nexus · Jev] Maestro: ${work}. Abra um worker por parte com ` +
      `nexus_pane_spawn({ task, prompt }) — ${parallelWave(delegation.parts, budget)}; ` +
      'readOnly: true nas de leitura, isolatedWriter: true nas de escrita — e ' +
      'encerre o turno. Não faça as partes você mesmo.';
  }
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

type DesignContextFn = (prompt: string, workspaceRoot: string) => string | null;

/** Regra de design + carta no primeiro pedido de UI da sessão, a cada 30 min. */
function designContextFor(
  ctx: HookContext,
  prompt: string,
  now: number,
  design: DesignContextFn,
): string | null {
  const root = ctx.executionScope?.rootRealPath ?? ctx.scope?.rootRealPath;
  if (!root || !ctx.sessionId) return null;
  if (prompt.includes(WORKSPACE_DESIGN_RULE_HEADING) || prompt.includes(DESIGN_CHARTER_HEADING)) {
    return null;
  }
  if (remindedRecently(designRemindedAt, ctx.sessionId, now)) return null;
  const text = design(prompt, root);
  if (!text) return null;
  markReminded(designRemindedAt, ctx.sessionId, now);
  return text;
}

/**
 * Texto pt-BR (≤ 400 caracteres) injetado como additionalContext. F-784: as
 * escritas também vão em paralelo, cada uma na sua worktree (o "uma por vez"
 * era de antes da auto-isolação da 0.76.110 e fazia o pane enfileirar
 * writers), e o número de helpers vem do teto seguro da máquina.
 */
/**
 * F-1317: tamanho do leque — "N+" é piso ("pelo menos N"); contagem exata
 * segue "~N" como antes.
 */
function splitSizeText(advice: DelegationAdvice): string {
  return advice.partsAtLeast ? `pelo menos ${advice.parts} partes` : `~${advice.parts} partes`;
}

/**
 * F-1317: com writersUncertain, a divisão leitura/escrita não é fato — a
 * diretiva manda os dois flags sem declarar número nenhum.
 */
function splitCountsText(advice: DelegationAdvice): string {
  if (advice.writersUncertain) return 'divisão leitura/escrita incerta';
  const reads = Math.max(0, advice.parts - advice.writers);
  return `${reads} de leitura, ${advice.writers} de escrita`;
}

export function formatDelegationContext(
  advice: DelegationAdvice,
  budget: ParallelHelperBudget | null = null,
): string {
  const work = advice.heavyRead
    ? 'Leitura pesada'
    : `Esta tarefa se divide em ${splitSizeText(advice)}`;
  let text: string;
  if (budget && helpersToOpenNow(advice.parts, budget) === 0) {
    text =
      `[Nexus · Jev] ${work}, mas a máquina está no teto seguro agora ` +
      `(${budgetCeilingNote(budget)}): não abra helpers — feche os que já ` +
      'entregaram ou faça em sequência.';
  } else if (advice.heavyRead) {
    text =
      '[Nexus · Jev] Leitura pesada: delegue a investigação a um helper com ' +
      'nexus_pane_spawn({ task, prompt, readOnly: true }) e encerre o turno; ' +
      'a entrega chega sozinha.';
  } else {
    text =
      `[Nexus · Jev] ${work} (${splitCountsText(advice)}). ` +
      'Delegue com nexus_pane_spawn({ task, prompt }), um helper por parte — ' +
      `${parallelWave(advice.parts, budget)}; readOnly: true nas de leitura, ` +
      'isolatedWriter: true nas de escrita. Encerre o turno; não execute tudo sozinho.';
  }
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/**
 * Diretiva da adoção (Autopilot, confiança ≥ 0,7): o pane JÁ virou
 * orquestrador — a ordem muda de "delegue" para "abra os helpers e encerre".
 */
function formatAutoOrchestrateDirective(
  advice: DelegationAdvice,
  budget: ParallelHelperBudget | null,
): string {
  const text =
    `[Nexus · Jev] Esta tarefa se divide em ${splitSizeText(advice)} ` +
    `(${splitCountsText(advice)}). O Nexus tornou ` +
    'este pane orquestrador de uma missão para ela. Abra um helper por ' +
    `parte com nexus_pane_spawn({ task, prompt }) — ${parallelWave(advice.parts, budget)}; ` +
    'readOnly: true nas de leitura, isolatedWriter: true nas de escrita —, ' +
    'encerre o turno e integre as entregas quando chegarem. Não faça as ' +
    'partes você mesmo.';
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/**
 * Título da missão adotada: sem as tags `<pasted_content>` e sem tokens de
 * caminho absoluto (o anexo .ogg do pedido não vira nome de missão). Vazio →
 * null e o provider usa o título padrão dele.
 */
function missionSummaryFromPrompt(prompt: string): string | null {
  const text = prompt
    .replace(/<\/?pasted_content\b[^>]*>/gu, ' ')
    .replace(/(?:^|\s)(\/[^\s]+|[A-Za-z]:[\\/][^\s]*)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text || null;
}

/**
 * Pedido do operador que se divide, com confiança alta e em Autopilot: o
 * Nexus torna o pane orquestrador pela missão sob demanda da aba (mesmo
 * provedor do "1º helper") e troca a dica pela diretiva. Pane com missão,
 * Hardened, confiança menor, máquina no teto seguro e adoção recusada ficam
 * na dica (helper nem chega aqui: F-784).
 */
async function delegationContextFor(
  ctx: HookContext,
  prompt: string,
  advice: DelegationAdvice,
  autopilot: () => boolean,
  adoptMission: (ctx: HookContext, summary: string | null) => OperatorTabMission | null | Promise<OperatorTabMission | null>,
  budget: ParallelHelperBudget | null,
): Promise<string> {
  const hint = formatDelegationContext(advice, budget);
  if (
    advice.confidence < AUTO_ORCHESTRATE_MIN_CONFIDENCE ||
    advice.parts < 2 ||
    // F-784: no teto seguro não há helper a abrir — promover o pane só
    // trocaria a dica por uma ordem impossível.
    helpersToOpenNow(advice.parts, budget) === 0 ||
    ctx.role !== 'user' ||
    ctx.missionId ||
    !typedByOperator(ctx, prompt) ||
    !autopilot()
  ) {
    return hint;
  }
  let adopted: OperatorTabMission | null = null;
  try {
    adopted = await adoptMission(ctx, missionSummaryFromPrompt(prompt));
  } catch {
    adopted = null;
  }
  if (!adopted) return hint;
  trace({
    kind: 'auto-orchestrate',
    sessionId: ctx.sessionId ?? null,
    missionId: adopted.missionId,
    parts: advice.parts,
    writers: advice.writers,
    confidence: advice.confidence,
  });
  return formatAutoOrchestrateDirective(advice, budget);
}

export async function handleHookDelegateRequest(
  ctx: HookContext,
  body: unknown,
  deps: {
    advise?: typeof advisePrompt;
    now?: () => number;
    design?: DesignContextFn;
    /** Destilação de preferência (fatia 3); default fire-and-forget. */
    distillPreference?: typeof distillOperatorPreferenceMemory;
    /** Main-owned exact human input receipt. Absent proof fails closed. */
    proveOperatorPrompt?: (sessionId: string, prompt: string) => boolean;
    /** Bloco <workspace-memory> do primeiro prompt do Codex (fatia 4). */
    memoryBlock?: MemoryBlockFn;
    /** Bloco <business-model> por tarefa; default = seleção Jev + fallback. */
    businessContext?: BusinessContextFn;
    /** Autopiloto (operator-choice): a auto-orquestração só roda nele. */
    autopilot?: () => boolean;
    /** Adoção pela missão sob demanda da aba (provedor do tools-panes). */
    adoptMission?: (ctx: HookContext, summary: string | null) => OperatorTabMission | null | Promise<OperatorTabMission | null>;
    /** Doutrina permanente do Maestro da missão (F-701); default lê a missão. */
    maestroDoctrine?: MaestroDoctrineFn;
    /** F-753: skill do Nexus ou do projeto que o Jev/Clef acha útil no pedido. */
    suggestSkill?: typeof suggestSkillForTask;
    /** F-1309: aviso de degradação quando a sugestão de skill não está disponível. */
    skillDegradation?: () => string | null;
    /** F-784: teto seguro de helpers agora; default = panes vivos × RAM livre. */
    parallelBudget?: ParallelBudgetFn;
    /** F-802: dica de CLI melhor (busca na web); default = motor de rota sem Jev. */
    routeHint?: (ctx: HookContext, prompt: string) => Promise<string | null>;
  } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    const prompt = parseUserPrompt(body);
    if (!prompt) return { statusCode: 200, payload: {} };
    const now = (deps.now ?? Date.now)();
    const budgetOf = onceBudget(deps.parallelBudget ?? currentParallelHelperBudget);
    // A entrega de um helper chega como prompt, mas não é pedido novo do operador.
    const operatorPrompt =
      !prompt.startsWith(WORKSPACE_HANDOFF_DELIVERY_PREFIX) &&
      !prompt.includes(FAILOVER_HANDOFF_HEADER) &&
      !isNonOperatorPrompt(prompt);
    const doctrineFor = deps.maestroDoctrine ?? maestroStandingDoctrineFor;
    // F-708: pedido do operador no Maestro passa pelo mesmo Jev do "+ Pane";
    // o lembrete genérico vira "abra N workers". Sem divisão, fica o lembrete
    // — que vale em qualquer prompt, inclusive na entrega de um worker: é
    // processando entregas que ele passa a fazer o trabalho.
    const maestroDirective =
      operatorPrompt && isMissionMaestro(ctx)
        ? await maestroDelegationDirective(
            ctx,
            prompt,
            deps.advise ?? advisePrompt,
            doctrineFor,
            budgetOf,
          )
        : null;
    const maestro = maestroDirective ?? maestroContextFor(ctx, now, doctrineFor, budgetOf);
    const parts: string[] = maestro ? [maestro] : [];
    // Preferência do operador: pré-filtro regex no próprio módulo; o Jev só é
    // chamado quando há marcador. Fire-and-forget — não segura o prompt.
    const distillPreference = deps.distillPreference ?? distillOperatorPreferenceMemory;
    // Memória é por projeto; o escopo primário evita abrir o store pela worktree da aba (F-806).
    const preferenceScope = ctx.scope;
    if (preferenceScope && ctx.sessionId && operatorPrompt && typedByOperator(ctx, prompt) &&
      (isOperatorHandContext(ctx) || isMissionMaestro(ctx)) &&
      (deps.proveOperatorPrompt ?? isRecentHumanPrompt)(ctx.sessionId, prompt) === true) {
      void distillPreference(preferenceScope, prompt).catch(() => {});
    }
    if (!isOperatorHandContext(ctx) || !operatorPrompt) {
      return additionalContextResponse(ctx, parts);
    }
    const advise = deps.advise ?? advisePrompt;
    const businessContext = deps.businessContext ?? defaultBusinessContext;
    // Duas consultas Jev no mesmo turno rodam em PARALELO: sequenciais, o
    // prompt do operador pagava a soma dos timeouts no pior caso.
    // F-784: só o pane raiz (o do operador) é empurrado a delegar. O brief de
    // um helper julgado "divisível" virava "delegue" e abria helpers de
    // helpers — a cascata que já levou o Mac ao swap (F-572: 33 panes); o
    // decisions.jsonl de 26–27/09 tem briefs de helper com delegate:5p.
    const advicePromise =
      ctx.operatorParentSessionId === undefined
        ? advise(prompt, { sessionId: ctx.sessionId, missionId: ctx.missionId }).catch(() => null)
        : Promise.resolve(null);
    const businessModelPromise = businessContextFor(ctx, prompt, now, businessContext);
    // F-753: a skill certa para o pedido, entre as do Nexus e as do projeto —
    // antes o operador arrastava cada uma do painel para o pane. Mesmo teto
    // TOTAL do conselho de delegação: o hook do Claude corta em 5 s e levaria
    // o conselho junto, e o prompt do Codex esperaria o retry inteiro.
    const skillScope = ctx.executionScope ?? ctx.scope;
    const skillPromise = (deps.suggestSkill ?? suggestSkillForTask)(prompt, {
      allowedSkills: ctx.allowedSkills ?? null,
      projectRoot: skillScope?.rootRealPath,
      // F-772 (G7a): pane sem superfície de skills (muse, minimax-code…)
      // nunca recebe a dica de uma SKILL.md que a sessão dele não tem.
      adapterId: ctx.providerId,
      sessionId: ctx.sessionId,
      timeoutMs: DELEGATE_TIMEOUT_MS,
      signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
    }).catch(() => null);
    // F-802: pedido que a CLI do pane não confirma atender (busca na web) — em
    // paralelo com o resto, com prazo próprio; só roda com o regex local batendo.
    const routeHintPromise = ctx.operatorParentSessionId === undefined
      ? (deps.routeHint ?? operatorRouteHint)(ctx, prompt).catch(() => null)
      : Promise.resolve(null);
    // Jev fora do ar não pode levar junto o contexto de design, que é local.
    const advice = await advicePromise;
    // O Codex não recebe a doutrina pelas instructions do MCP (ele as repete
    // em cada tool) e o Kimi nem as lê; ela chega aqui, uma vez por sessão a
    // cada 30 min. Bug7: depois da promoção a Maestro, reentregar a doutrina
    // do operador ("tarefa pequena: faça você") contradiz a do Maestro
    // entregue acima — o promovido fica só com a do Maestro.
    if (
      ctx.promotedFromUserSession !== true &&
      providerReceivesContextOnlyByHook(ctx.providerId) &&
      ctx.sessionId &&
      !remindedRecently(doctrineDeliveredAt, ctx.sessionId, now)
    ) {
      markReminded(doctrineDeliveredAt, ctx.sessionId, now);
      parts.push(OPERATOR_DELEGATION_DOCTRINE);
    }
    // O modelo extraído do HEAD deve existir antes do prompt renderizar:
    // dispara a extração (dedup 30 min/sessão) sem bloquear este turno — a
    // primeira mensagem pode cair no bloco estático/doc revisado e a segunda
    // já encontra o modelo extraído no store.
    const businessScope = ctx.executionScope ?? ctx.scope;
    if (
      businessScope &&
      ctx.sessionId &&
      !remindedRecently(businessEnsureAt, ctx.sessionId, now)
    ) {
      markReminded(businessEnsureAt, ctx.sessionId, now);
      void ensureBusinessModel(businessScope, { wait: false }).catch(() => {});
    }
    // Modelo de negócio por tarefa: a seleção (Jev, com fallback lexical) muda
    // com o pedido; a dedup por hash só suprime o bloco idêntico recente.
    const businessModel = await businessModelPromise;
    if (businessModel) parts.push(businessModel);
    const skill = await skillPromise;
    if (skill && skill.confidence >= OPERATOR_SKILL_HINT_MIN_CONFIDENCE && ctx.sessionId) {
      const key = `${ctx.sessionId}\u0000${skill.name}`;
      if (!remindedRecently(skillHintDeliveredAt, key, now)) {
        markReminded(skillHintDeliveredAt, key, now);
        parts.push(operatorSkillHint(skill));
      }
    }
    // F-1309: sem chave do Jev a dica de skill some em silêncio — um aviso
    // único de degradação aparece onde a dica deveria estar. Quem injeta o
    // sinal é o entrypoint HTTP (handleHookDelegateHttp); o default é passivo.
    const skillDegradation = skill ? null : (deps.skillDegradation ?? (() => null))();
    if (
      skillDegradation &&
      ctx.sessionId &&
      !remindedRecently(skillDegradationDeliveredAt, ctx.sessionId, now)
    ) {
      markReminded(skillDegradationDeliveredAt, ctx.sessionId, now);
      parts.push(skillDegradation);
    }
    // A dica de CLI vale quando o conselho NÃO manda delegar: delegar já passa
    // pelo roteador, e duas linhas do mesmo assunto só gastam contexto.
    const routeLine = await routeHintPromise;
    if (routeLine && !advice?.delegation && ctx.sessionId && !remindedRecently(routeHintDeliveredAt, ctx.sessionId, now)) {
      markReminded(routeHintDeliveredAt, ctx.sessionId, now);
      parts.push(routeLine);
    }
    if (advice?.delegation) {
      const autopilot =
        deps.autopilot ??
        (() => isOperatorChoicePolicy(getOrchSettings().squadCliPolicy));
      const adoptMission =
        deps.adoptMission ??
        ((context: HookContext, summary: string | null) =>
          adoptThroughOperatorTabMission(context as AgentGateContext, summary));
      parts.push(
        await delegationContextFor(
          ctx,
          prompt,
          advice.delegation,
          autopilot,
          adoptMission,
          budgetOf(),
        ),
      );
    }
    if (
      isBrowserRequest(prompt) &&
      ctx.sessionId &&
      !remindedRecently(browserHintDeliveredAt, ctx.sessionId, now)
    ) {
      markReminded(browserHintDeliveredAt, ctx.sessionId, now);
      parts.push(BROWSER_TOOL_HINT);
    }
    // Com conselho, quem decide é o Jev (um "não é código" dele vale). Sem
    // conselho nenhum, o pré-filtro decide: silêncio ali deixava o pedido de
    // código sem a ponytail, que é o pontapé inicial de todo trabalho de código.
    const writesCode = advice
      ? advice.writesCode >= LEAN_REMINDER_MIN_WRITES_CODE
      : isCodeRequest(prompt);
    if (
      writesCode &&
      !prompt.includes(PONYTAIL_RULES_HEADING) &&
      ctx.sessionId &&
      claimLeanReminder(ctx.sessionId, now)
    ) {
      parts.push(LEAN_CODE_REMINDER);
    }
    const design = designContextFor(ctx, prompt, now, deps.design ?? operatorDesignContext);
    if (design) parts.push(design);
    const memory = memoryContextFor(ctx, prompt, now, deps.memoryBlock ?? operatorWorkspaceMemoryContext);
    if (memory) parts.push(memory);
    return additionalContextResponse(ctx, parts);
  } catch {
    return { statusCode: 200, payload: {} };
  }
}

function additionalContextResponse(
  ctx: HookContext,
  parts: readonly string[],
): { statusCode: 200; payload: Record<string, unknown> } {
  if (parts.length === 0) return { statusCode: 200, payload: {} };
  const context = parts.join('\n');
  return {
    statusCode: 200,
    payload: {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: providerReceivesContextOnlyByHook(ctx.providerId)
          ? `${AUXILIARY_CONTEXT_HEADER}\n${context}`
          : context,
      },
    },
  };
}

/**
 * F-802: o Kimi não lê `additionalContext` — ele injeta o stdout do comando (ou
 * `message`) como mensagem. Um `{}` viraria uma mensagem "{}" a cada prompt;
 * para ele a resposta é o texto puro, e VAZIA quando não há nada a dizer.
 */
function replyAsPlainText(providerId: string | undefined): boolean {
  return providerId?.trim().toLowerCase() === 'kimi';
}

export function additionalContextText(payload: unknown): string {
  const output = (payload as { hookSpecificOutput?: { additionalContext?: unknown } } | null)
    ?.hookSpecificOutput;
  return typeof output?.additionalContext === 'string' ? output.additionalContext : '';
}

export async function handleHookDelegateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext | null,
): Promise<void> {
  await handleHookJsonPost(
    req,
    res,
    ctx,
    HOOK_DELEGATE_MAX_BODY_BYTES,
    // F-1309: é aqui, na superfície do operador, que a degradação da sugestão
    // de skill vira texto — o default do request handler fica passivo.
    (body) =>
      handleHookDelegateRequest(ctx!, body, {
        skillDegradation: skillSuggestionDegradation,
      }),
    ctx && replyAsPlainText(ctx.providerId) ? additionalContextText : undefined,
  );
}

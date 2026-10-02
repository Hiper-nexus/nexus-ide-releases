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
import { isOperatorHandContext } from './operator-hand-context';
import {
  advisePrompt,
  AUTO_ORCHESTRATE_MIN_CONFIDENCE,
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
import { distillOperatorPreferenceMemory } from '../memory/operator-preference-memory';
import { operatorWorkspaceMemoryContext } from './operator-workspace-memory';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { getOrchSettings } from '../persistence/settings-store';
import {
  adoptThroughOperatorTabMission,
  type OperatorTabMission,
} from './tools-panes';
import { trace } from '../observability/main-trace';
import { maestroStandingDoctrineFor } from './maestro-standing-context';

export const HOOK_DELEGATE_MAX_BODY_BYTES = 64 * 1024;

export function parseUserPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const prompt = (body as Record<string, unknown>).prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
}

/** A partir desta probabilidade o pedido conta como escrever código. */
export const LEAN_REMINDER_MIN_WRITES_CODE = 0.6;
/** Os lembretes ficam no histórico da conversa: cada um, uma vez por sessão a cada 30 min. */
export const LEAN_REMINDER_INTERVAL_MS = 30 * 60_000;

/**
 * O Codex entrega o additionalContext como mensagem developer DEPOIS do prompt
 * (openai/codex#40680); sem este aviso o modelo pode tomá-lo pela tarefa.
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
  '[Nexus · Jev] Pedido de código: siga a skill ponytail — entenda o fluxo, ' +
  'reuse o que já existe, nada de abstração que ninguém pediu, o menor diff ' +
  'correto e um teste pequeno que falhe se a lógica quebrar.';

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

export const BROWSER_TOOL_HINT =
  '[Nexus · Jev] Para analisar páginas, extrair dados ou testar responsividade, ' +
  'use nexus_browser_* (o navegador do Nexus já está aberto, com sessão) — não ' +
  'WebFetch, Playwright ou Firecrawl para uma URL que será aberta agora. ' +
  'Responsividade num só chamado: nexus_browser_responsive.';

/**
 * Lembrete do Maestro (F-701) no prompt, a cada 30 min por sessão. A doutrina
 * inteira já está nas instructions do MCP; o Codex, que não as recebe, ganha
 * a doutrina no lugar deste lembrete.
 */
export const MAESTRO_TURN_REMINDER =
  '[Nexus] Maestro: o trabalho da missão vai para workers (nexus_pane_spawn, ' +
  'os independentes em paralelo); seu pane coordena, integra e valida. ' +
  'Trabalho restante sem worker vivo: abra os workers agora. ' +
  'Entrega com código: veredito de modelo de ponta antes de integrar. ' +
  'Handoff é alegação: confira o diff e rode o teste da correção antes de aceitar.';

const maestroRemindedAt = new Map<string, number>();
const leanRemindedAt = new Map<string, number>();
const designRemindedAt = new Map<string, number>();
const doctrineDeliveredAt = new Map<string, number>();
const businessModelDeliveredAt = new Map<string, { hash: string; at: number }>();
const businessEnsureAt = new Map<string, number>();
const browserHintDeliveredAt = new Map<string, number>();
const memoryDeliveredAt = new Map<string, { hash: string; at: number }>();

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
  const context = block(ctx, 'hook', prompt);
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
  return context;
}

type HookContext = Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'> &
  Partial<
    Pick<AgentGateContext, 'scope' | 'executionScope' | 'providerId' | 'operatorParentSessionId' | 'promotedFromUserSession'>
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
];

function isNonOperatorPrompt(prompt: string): boolean {
  const head = prompt.trim().replace(/^<pasted_content\b[^>]*>/u, '').trim();
  return NON_OPERATOR_PROMPT_PREFIXES.some((prefix) => head.startsWith(prefix));
}

type MaestroDoctrineFn = (ctx: HookContext) => string | null;

function maestroContextFor(
  ctx: HookContext,
  now: number,
  doctrineFor: MaestroDoctrineFn,
): string | null {
  if (ctx.role !== 'orchestrator' || !ctx.missionId || !ctx.sessionId) return null;
  if (remindedRecently(maestroRemindedAt, ctx.sessionId, now)) return null;
  const doctrine = doctrineFor(ctx);
  if (!doctrine) return null;
  markReminded(maestroRemindedAt, ctx.sessionId, now);
  return ctx.providerId === 'codex' ? doctrine : MAESTRO_TURN_REMINDER;
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
): Promise<string | null> {
  if (!doctrineFor(ctx)) return null;
  const advice = await advise(prompt, { sessionId: ctx.sessionId }).catch(() => null);
  const delegation = advice?.delegation;
  if (!delegation || delegation.parts < 2) return null;
  const reads = Math.max(0, delegation.parts - delegation.writers);
  const text =
    `[Nexus · Jev] Maestro: este pedido se divide em ~${delegation.parts} partes ` +
    `(${reads} de leitura, ${delegation.writers} de escrita). Abra agora um worker ` +
    'por parte com nexus_pane_spawn({ task, prompt }), todos em paralelo — ' +
    'readOnly: true nas de leitura, isolatedWriter: true nas de escrita — e ' +
    'encerre o turno. Não faça as partes você mesmo.';
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

/** Texto pt-BR (≤ 400 caracteres) injetado como additionalContext. */
export function formatDelegationContext(advice: DelegationAdvice): string {
  const reads = Math.max(0, advice.parts - advice.writers);
  const text =
    `[Nexus · Jev] Esta tarefa se divide em ~${advice.parts} partes ` +
    `(${reads} de leitura em paralelo, ${advice.writers} de escrita, uma por vez). ` +
    'Delegue com nexus_pane_spawn({ task, prompt }) — readOnly: true nas de ' +
    'leitura — e encerre o turno; não execute tudo sozinho.';
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/**
 * Diretiva da adoção (Autopilot, confiança ≥ 0,7): o pane JÁ virou
 * orquestrador — a ordem muda de "delegue" para "abra os helpers e encerre".
 */
function formatAutoOrchestrateDirective(advice: DelegationAdvice): string {
  const reads = Math.max(0, advice.parts - advice.writers);
  const text =
    `[Nexus · Jev] Esta tarefa se divide em ~${advice.parts} partes ` +
    `(${reads} de leitura, ${advice.writers} de escrita). O Nexus tornou ` +
    'este pane orquestrador de uma missão para ela. Abra um helper por ' +
    'parte com nexus_pane_spawn({ task, prompt }) — readOnly: true nas de ' +
    'leitura, isolatedWriter: true nas de escrita em paralelo —, encerre o ' +
    'turno e integre as entregas quando chegarem. Não faça as partes você ' +
    'mesmo.';
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
 * provedor do "1º helper") e troca a dica pela diretiva. Helper, pane com
 * missão, Hardened, confiança menor e adoção recusada ficam na dica.
 */
function delegationContextFor(
  ctx: HookContext,
  prompt: string,
  advice: DelegationAdvice,
  autopilot: () => boolean,
  adoptMission: (ctx: HookContext, summary: string | null) => OperatorTabMission | null,
): string {
  const hint = formatDelegationContext(advice);
  if (
    advice.confidence < AUTO_ORCHESTRATE_MIN_CONFIDENCE ||
    advice.parts < 2 ||
    ctx.role !== 'user' ||
    ctx.missionId ||
    !typedByOperator(ctx, prompt) ||
    !autopilot()
  ) {
    return hint;
  }
  let adopted: OperatorTabMission | null = null;
  try {
    adopted = adoptMission(ctx, missionSummaryFromPrompt(prompt));
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
  return formatAutoOrchestrateDirective(advice);
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
    /** Bloco <workspace-memory> do primeiro prompt do Codex (fatia 4). */
    memoryBlock?: MemoryBlockFn;
    /** Bloco <business-model> por tarefa; default = seleção Jev + fallback. */
    businessContext?: BusinessContextFn;
    /** Autopiloto (operator-choice): a auto-orquestração só roda nele. */
    autopilot?: () => boolean;
    /** Adoção pela missão sob demanda da aba (provedor do tools-panes). */
    adoptMission?: (ctx: HookContext, summary: string | null) => OperatorTabMission | null;
    /** Doutrina permanente do Maestro da missão (F-701); default lê a missão. */
    maestroDoctrine?: MaestroDoctrineFn;
  } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    const prompt = parseUserPrompt(body);
    if (!prompt) return { statusCode: 200, payload: {} };
    const now = (deps.now ?? Date.now)();
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
        ? await maestroDelegationDirective(ctx, prompt, deps.advise ?? advisePrompt, doctrineFor)
        : null;
    const maestro = maestroDirective ?? maestroContextFor(ctx, now, doctrineFor);
    const parts: string[] = maestro ? [maestro] : [];
    if (!isOperatorHandContext(ctx) || !operatorPrompt) {
      return additionalContextResponse(ctx, parts);
    }
    // Preferência do operador: pré-filtro regex no próprio módulo; o Jev só é
    // chamado quando há marcador. Fire-and-forget — não segura o prompt.
    const distillPreference = deps.distillPreference ?? distillOperatorPreferenceMemory;
    const preferenceScope = ctx.executionScope ?? ctx.scope;
    if (preferenceScope && typedByOperator(ctx, prompt)) {
      void distillPreference(preferenceScope, prompt).catch(() => {});
    }
    const advise = deps.advise ?? advisePrompt;
    const businessContext = deps.businessContext ?? defaultBusinessContext;
    // Duas consultas Jev no mesmo turno rodam em PARALELO: sequenciais, o
    // prompt do operador pagava a soma dos timeouts no pior caso.
    const advicePromise = advise(prompt, { sessionId: ctx.sessionId }).catch(() => null);
    const businessModelPromise = businessContextFor(ctx, prompt, now, businessContext);
    // Jev fora do ar não pode levar junto o contexto de design, que é local.
    const advice = await advicePromise;
    // O Codex não recebe a doutrina pelas instructions do MCP (ele as repete
    // em cada tool); ela chega aqui, uma vez por sessão a cada 30 min.
    if (ctx.providerId === 'codex' && ctx.sessionId && !remindedRecently(doctrineDeliveredAt, ctx.sessionId, now)) {
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
    if (advice?.delegation) {
      const autopilot =
        deps.autopilot ??
        (() => isOperatorChoicePolicy(getOrchSettings().squadCliPolicy));
      const adoptMission =
        deps.adoptMission ??
        ((context: HookContext, summary: string | null) =>
          adoptThroughOperatorTabMission(context as AgentGateContext, summary));
      parts.push(
        delegationContextFor(ctx, prompt, advice.delegation, autopilot, adoptMission),
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
    if (
      advice &&
      advice.writesCode >= LEAN_REMINDER_MIN_WRITES_CODE &&
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
        additionalContext:
          ctx.providerId === 'codex' ? `${AUXILIARY_CONTEXT_HEADER}\n${context}` : context,
      },
    },
  };
}

export async function handleHookDelegateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext | null,
): Promise<void> {
  await handleHookJsonPost(req, res, ctx, HOOK_DELEGATE_MAX_BODY_BYTES, (body) =>
    handleHookDelegateRequest(ctx!, body),
  );
}

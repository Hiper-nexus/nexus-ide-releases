// POST /hook/delegate — contexto do motor para os panes sem missão via hook
// `UserPromptSubmit` (C2, 25/09): conselho de delegação do Jev, lembrete da
// ponytail e, em pedido de interface, a regra de design do projeto com a Carta
// de Design — o que um worker recebe no prompt de spawn e o pane "+" não tinha.
// Mesmo servidor loopback e bearer do /hook/triage. A resposta vira
// `additionalContext`. Nunca atrapalha: qualquer coisa fora do caminho feliz
// responde `{}` com 200.
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { advisePrompt, type DelegationAdvice } from '../jev/jev-delegation';
import { handleHookJsonPost } from './hook-http';
import {
  WORKSPACE_DESIGN_RULE_HEADING,
  operatorDesignContext,
} from './workspace-design-rule';
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from './workspace-handoff-delivery';
import { OPERATOR_DELEGATION_DOCTRINE } from './operator-delegation-doctrine';
import { operatorBusinessModelContext } from './operator-business-model';

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

const leanRemindedAt = new Map<string, number>();
const designRemindedAt = new Map<string, number>();
const doctrineDeliveredAt = new Map<string, number>();
const businessModelDeliveredAt = new Map<string, number>();

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
  leanRemindedAt.clear();
  designRemindedAt.clear();
  doctrineDeliveredAt.clear();
  businessModelDeliveredAt.clear();
}

type HookContext = Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope' | 'providerId'>>;

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

export async function handleHookDelegateRequest(
  ctx: HookContext,
  body: unknown,
  deps: { advise?: typeof advisePrompt; now?: () => number; design?: DesignContextFn } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    if (ctx.role !== 'user' || ctx.missionId) return { statusCode: 200, payload: {} };
    const prompt = parseUserPrompt(body);
    // A entrega de um helper chega como prompt, mas não é pedido novo do operador.
    if (!prompt || prompt.startsWith(WORKSPACE_HANDOFF_DELIVERY_PREFIX)) {
      return { statusCode: 200, payload: {} };
    }
    const now = (deps.now ?? Date.now)();
    const advise = deps.advise ?? advisePrompt;
    // Jev fora do ar não pode levar junto o contexto de design, que é local.
    const advice = await advise(prompt, { sessionId: ctx.sessionId }).catch(() => null);
    const parts: string[] = [];
    // O Codex não recebe a doutrina pelas instructions do MCP (ele as repete
    // em cada tool); ela chega aqui, uma vez por sessão a cada 30 min.
    if (ctx.providerId === 'codex' && ctx.sessionId && !remindedRecently(doctrineDeliveredAt, ctx.sessionId, now)) {
      markReminded(doctrineDeliveredAt, ctx.sessionId, now);
      parts.push(OPERATOR_DELEGATION_DOCTRINE);
    }
    // Idem o modelo de negócio do projeto (os demais recebem pelo MCP).
    if (ctx.sessionId && !remindedRecently(businessModelDeliveredAt, ctx.sessionId, now)) {
      const businessModel = operatorBusinessModelContext(ctx, 'hook');
      if (businessModel) {
        markReminded(businessModelDeliveredAt, ctx.sessionId, now);
        parts.push(businessModel);
      }
    }
    if (advice?.delegation) parts.push(formatDelegationContext(advice.delegation));
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
  } catch {
    return { statusCode: 200, payload: {} };
  }
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

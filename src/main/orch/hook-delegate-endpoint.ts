// POST /hook/delegate — conselho Jev de delegação via hook `UserPromptSubmit`
// (C2, 25/09). Mesmo servidor loopback e bearer do /hook/triage. A resposta
// vira `additionalContext` do Claude. Nunca atrapalha: qualquer coisa fora do
// caminho feliz responde `{}` com 200.
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { advisePrompt, type DelegationAdvice } from '../jev/jev-delegation';
import { handleHookJsonPost } from './hook-http';

export const HOOK_DELEGATE_MAX_BODY_BYTES = 64 * 1024;

export function parseUserPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const prompt = (body as Record<string, unknown>).prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
}

/** A partir desta probabilidade o pedido conta como escrever código. */
export const LEAN_REMINDER_MIN_WRITES_CODE = 0.6;
/** O lembrete fica no histórico da conversa: uma vez por sessão a cada 30 min. */
export const LEAN_REMINDER_INTERVAL_MS = 30 * 60_000;

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

function claimLeanReminder(sessionId: string, now: number): boolean {
  const last = leanRemindedAt.get(sessionId);
  if (last !== undefined && now - last < LEAN_REMINDER_INTERVAL_MS) return false;
  for (const [id, at] of leanRemindedAt) {
    if (now - at >= LEAN_REMINDER_INTERVAL_MS) leanRemindedAt.delete(id);
  }
  leanRemindedAt.set(sessionId, now);
  return true;
}

/** Test-only: esquece quem já recebeu o lembrete. */
export function __resetLeanRemindersForTests(): void {
  leanRemindedAt.clear();
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
  ctx: Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'>,
  body: unknown,
  deps: { advise?: typeof advisePrompt; now?: () => number } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    if (ctx.role !== 'user' || ctx.missionId) return { statusCode: 200, payload: {} };
    const prompt = parseUserPrompt(body);
    if (!prompt) return { statusCode: 200, payload: {} };
    const advise = deps.advise ?? advisePrompt;
    const advice = await advise(prompt, { sessionId: ctx.sessionId });
    if (!advice) return { statusCode: 200, payload: {} };
    const parts: string[] = [];
    if (advice.delegation) parts.push(formatDelegationContext(advice.delegation));
    if (
      advice.writesCode >= LEAN_REMINDER_MIN_WRITES_CODE &&
      ctx.sessionId &&
      claimLeanReminder(ctx.sessionId, (deps.now ?? Date.now)())
    ) {
      parts.push(LEAN_CODE_REMINDER);
    }
    if (parts.length === 0) return { statusCode: 200, payload: {} };
    return {
      statusCode: 200,
      payload: {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: parts.join('\n'),
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

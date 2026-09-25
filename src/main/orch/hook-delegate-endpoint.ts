// POST /hook/delegate — conselho Jev de delegação via hook `UserPromptSubmit`
// (C2, 25/09). Mesmo servidor loopback e bearer do /hook/triage. A resposta
// vira `additionalContext` do Claude. Nunca atrapalha: qualquer coisa fora do
// caminho feliz responde `{}` com 200.
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { adviseDelegation, type DelegationAdvice } from '../jev/jev-delegation';
import { handleHookJsonPost } from './hook-http';

export const HOOK_DELEGATE_MAX_BODY_BYTES = 64 * 1024;

export function parseUserPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const prompt = (body as Record<string, unknown>).prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
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
  deps: { advise?: typeof adviseDelegation } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    if (ctx.role !== 'user' || ctx.missionId) return { statusCode: 200, payload: {} };
    const prompt = parseUserPrompt(body);
    if (!prompt) return { statusCode: 200, payload: {} };
    const advise = deps.advise ?? adviseDelegation;
    const advice = await advise(prompt, { sessionId: ctx.sessionId });
    if (!advice) return { statusCode: 200, payload: {} };
    return {
      statusCode: 200,
      payload: {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: formatDelegationContext(advice),
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

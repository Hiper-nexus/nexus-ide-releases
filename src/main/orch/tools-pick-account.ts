/**
 * `nexus_pick_account` — qual conta tem folga agora, só pelo scorer
 * determinístico. Jev não escolhe conta. A consulta que o agente faz ANTES
 * de abrir o pane, para o pane nascer na conta certa.
 *
 * Privacidade igual ao nexus_quota_status: só ids opacos, janelas e números —
 * label/email nunca são moldados na resposta.
 */

import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';

export const pickAccountArgsSchema = z.object({
  /** Omitido → melhor conta da frota inteira (qualquer adapter). */
  adapterId: z.string().min(1).max(64).optional(),
});

export const pickAccountTool: McpToolDef = {
  name: 'nexus_pick_account',
  description:
    'Pick the account with the most usage headroom right now (deterministic ' +
    'quota arithmetic; Jev does not pick accounts). Call with `adapterId` ' +
    'BEFORE opening a pane so the pane is born on an account that will not ' +
    'hit a limit mid-task; the answer carries the pick, its decisive window ' +
    '(the tightest one, with minutes to reset), a plan-B ranking, the ' +
    'reading age and `decidedBy` ("scorer"). Read-only projection of the ' +
    'quota snapshot — it never contacts a provider and never renews tokens. ' +
    'Rows are identified by adapterId + opaque accountId; labels/emails ' +
    'never cross. A reset due within 60min counts as headroom coming back, ' +
    'proportionally.',
  inputSchema: {
    type: 'object',
    properties: {
      adapterId: {
        type: 'string',
        description:
          'Adapter/CLI to pick for (e.g. "claude"). Omit for the best account fleet-wide.',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const parsed = pickAccountArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(
        `nexus_pick_account: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // Worker só enxerga o próprio provider (mesma fronteira do quota_status).
    const ownProviderOnly = ctx.role === 'worker';
    if (ownProviderOnly && !ctx.providerId) {
      return Object.freeze({
        available: false,
        decidedBy: 'unavailable' as const,
        reason:
          'worker provider identity is unknown in this session — refusing to widen the pick to the whole fleet',
        alternatives: [],
      });
    }
    // F-1330: pedir outro provider devolvia o pick do próprio, sem aviso.
    // A fronteira é a mesma; a recusa agora é explícita.
    if (ownProviderOnly && parsed.data.adapterId && parsed.data.adapterId !== ctx.providerId) {
      return Object.freeze({
        available: false,
        decidedBy: 'unavailable' as const,
        reason:
          `this worker runs on provider "${ctx.providerId}"; picking for "${parsed.data.adapterId}" ` +
          'is outside its boundary — a worker picks only within its own provider, and nothing was swapped silently',
        alternatives: [],
      });
    }
    const adapterId = ownProviderOnly ? ctx.providerId : parsed.data.adapterId;

    assertMcpInvocationCurrent(invocation);
    const { computeAccountPick } = await import('../quota/account-pick');
    const answer = await computeAccountPick({
      adapterId,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
      signal: invocation?.signal,
    });
    assertMcpInvocationCurrent(invocation);
    return Object.freeze(answer);
  },
};

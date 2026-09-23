/**
 * `nexus_account_windows` — janelas de cota por conta (paridade Overclock 1.4
 * `account_windows`). Leitura fria do snapshot; missing ≠ zero — idade da
 * leitura sempre publicada. Privacidade igual ao pick/quota: ids opacos.
 */

import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';

export const accountWindowsArgsSchema = z
  .object({
    adapterId: z.string().min(1).max(64).optional(),
    accountId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const accountWindowsTool: McpToolDef = {
  name: 'nexus_account_windows',
  description:
    'List every usage window of an account (or all accounts) from the last ' +
    'quota snapshot: used ratio, reset time, source and confidence. Never ' +
    'assumes zero usage when a reading is missing — rows report status ' +
    '"ok" | "queimada" | "sem leitura" plus reading age. Read-only; does not ' +
    'contact providers. Opaque adapterId + accountId only.',
  inputSchema: {
    type: 'object',
    properties: {
      adapterId: { type: 'string', description: 'Filter by adapter/CLI.' },
      accountId: { type: 'string', description: 'Filter by opaque account id.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const parsed = accountWindowsArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(
        `nexus_account_windows: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // Worker só enxerga o próprio provider (mesma fronteira do pick).
    const ownProviderOnly = ctx.role === 'worker';
    const adapterId = ownProviderOnly
      ? (ctx.providerId ?? undefined)
      : parsed.data.adapterId;
    if (ownProviderOnly && !ctx.providerId) {
      return Object.freeze({
        available: false,
        reason:
          'worker provider identity is unknown in this session — refusing to widen windows to the whole fleet',
        accounts: [],
      });
    }

    const { requireQuotaService } = await import('../quota/quota-service');
    const snapshot = requireQuotaService().lastSnapshot();
    if (!snapshot) {
      return Object.freeze({
        available: false,
        reason: 'nenhum snapshot de cota ainda — missing ≠ zero',
        accounts: [],
      });
    }

    const accounts = snapshot.entries
      .filter((entry) => entry.installed !== false)
      .filter((entry) => (adapterId ? entry.adapterId === adapterId : true))
      .filter((entry) =>
        parsed.data.accountId ? entry.accountId === parsed.data.accountId : true,
      )
      .map((entry) => {
        const windows = (entry.windows ?? []).map((w) => ({
          label: w.label,
          kind: w.kind,
          usedPct: Math.round((w.usedRatio ?? 0) * 100),
          ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
          source: w.source,
          confidence: w.confidence,
        }));
        const worst = windows.reduce(
          (acc, w) => (w.usedPct > acc ? w.usedPct : acc),
          0,
        );
        const status = entry.onCooldown
          ? 'queimada'
          : windows.length === 0
            ? 'sem leitura'
            : worst >= 95
              ? 'queimada'
              : 'ok';
        return {
          entryId: entry.id,
          adapterId: entry.adapterId,
          ...(entry.accountId ? { accountId: entry.accountId } : {}),
          status,
          windows,
          usedPctWorst: windows.length ? worst : null,
          onCooldown: Boolean(entry.onCooldown),
        };
      });

    return Object.freeze({
      available: true,
      snapshotAt: snapshot.updatedAt,
      readingAgeMs: Date.now() - snapshot.updatedAt,
      accounts,
      avisos:
        accounts.filter((a) => a.status !== 'ok').map((a) => ({
          entryId: a.entryId,
          status: a.status,
          note:
            a.status === 'queimada'
              ? 'conta em cooldown/limite — espere o reset ou escolha outra'
              : 'sem leitura de cota — não assuma folga',
        })),
    });
  },
};

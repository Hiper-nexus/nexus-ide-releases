/**
 * `nexus_harness` — ler/aplicar a tabela de harness por tarefa (paridade
 * Overclock 1.4). Worker nunca aplica: só `propose`. O dono/orquestrador
 * aplica em lote all-or-nothing; qualquer recusa não escreve nada.
 */

import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import {
  applyHarnessChanges,
  factoryHarnessTable,
  formatHarnessReceipt,
  isSkillAllowedByHarness,
  parseHarnessTable,
  resolveHarnessType,
  serializeHarnessTable,
  type HarnessOp,
  type HarnessTable,
  type HarnessTypeValues,
} from './harness-table';
import { getOrchSettings, replaceOrchSettings } from '../persistence/settings-store';

const valuesSchema = z
  .object({
    cli: z.string().max(64).optional(),
    model: z.string().max(128).optional(),
    account: z.string().max(128).optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    skills: z.array(z.string().max(64)).max(32).optional(),
    agent: z.string().max(128).optional(),
  })
  .strict();

const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_category'), categoryId: z.string().min(1).max(64), name: z.string().min(1).max(128) }),
  z.object({ op: z.literal('rename_category'), categoryId: z.string().min(1).max(64), name: z.string().min(1).max(128) }),
  z.object({ op: z.literal('remove_category'), categoryId: z.string().min(1).max(64) }),
  z.object({
    op: z.literal('create_type'),
    categoryId: z.string().min(1).max(64),
    typeId: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    set: valuesSchema.optional(),
    values: valuesSchema.optional(),
  }),
  z.object({
    op: z.literal('edit_type'),
    typeId: z.string().min(1).max(64),
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(500).optional(),
    set: valuesSchema.optional(),
    values: valuesSchema.optional(),
  }),
  z.object({ op: z.literal('remove_type'), typeId: z.string().min(1).max(64) }),
  z.object({ op: z.literal('restore_type'), typeId: z.string().min(1).max(64) }),
  z.object({ op: z.literal('restore_all') }),
]);

const harnessArgsSchema = z
  .object({
    /** `read` (default) · `apply` · `propose` · `proposals` · `simulate`. */
    action: z.enum(['read', 'apply', 'propose', 'proposals', 'simulate']).optional(),
    id: z.string().max(64).optional(),
    query: z.string().max(200).optional(),
    reason: z.string().min(1).max(500).optional(),
    change: changeSchema.optional(),
    changes: z.array(changeSchema).max(50).optional(),
  })
  .strict();

/** Tabela viva — carregada do settings-store e gravada no apply. */
let liveTable: HarnessTable | null = null;
const pendingProposals: Array<{
  id: string;
  reason: string;
  changes: HarnessOp[];
  at: number;
  from: string;
}> = [];

export function getHarnessTable(): HarnessTable {
  if (!liveTable) {
    try {
      liveTable = parseHarnessTable(getOrchSettings().taskHarnessTable);
    } catch {
      liveTable = factoryHarnessTable();
    }
  }
  return liveTable;
}

function persistHarnessTable(table: HarnessTable): void {
  liveTable = table;
  try {
    replaceOrchSettings({ taskHarnessTable: serializeHarnessTable(table) });
  } catch (err) {
    // Persistência falhar não desfaz a tabela em memória da sessão.
    console.warn('[harness] persist falhou; tabela segue em memória:', err);
  }
}

export function resetHarnessTableForTesting(table = factoryHarnessTable()): void {
  liveTable = table;
  pendingProposals.length = 0;
  try {
    replaceOrchSettings({ taskHarnessTable: serializeHarnessTable(table) });
  } catch {
    /* testes sem settings-store real */
  }
}

export const harnessTool: McpToolDef = {
  name: 'nexus_harness',
  description:
    'Read or edit the per-task harness table (CLI, model, account, effort, ' +
    'skills, agent per task type). action=read (default) returns categories, ' +
    'types and options; id reads one row; query/simulate previews the ' +
    'deterministic rule. action=apply commits a batch all-or-nothing (owner / ' +
    'declared orchestrator / external connector only). A worker pane must use ' +
    'action=propose (requires reason) which queues a pending proposal for the ' +
    'human — an agent assertion of consent is never an approval. action=' +
    'proposals lists pending items. The spawn receipt (`▸ harness:` / ' +
    '`▸ decisor:` / `▸ origens:`) is where the chosen harness lives.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'apply', 'propose', 'proposals', 'simulate'],
      },
      id: { type: 'string', description: 'One row: its typeId or its name.' },
      query: { type: 'string', description: 'Preview/simulate classification.' },
      reason: { type: 'string', description: 'Required for action=propose.' },
      change: { type: 'object' },
      changes: { type: 'array', items: { type: 'object' } },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const parsed = harnessArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(
        `nexus_harness: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const input = parsed.data;
    const action = input.action ?? 'read';
    const changes: HarnessOp[] = [
      ...(input.change ? [input.change as HarnessOp] : []),
      ...((input.changes ?? []) as HarnessOp[]),
    ];

    if (action === 'proposals') {
      return Object.freeze({
        pending: pendingProposals.map((p) => ({
          id: p.id,
          reason: p.reason,
          changes: p.changes,
          at: p.at,
          from: p.from,
        })),
        history: [] as unknown[],
      });
    }

    if (action === 'propose') {
      if (changes.length === 0) throw new Error('propose exige change/changes');
      if (!input.reason?.trim()) {
        throw new Error('propose exige reason (o dono aprova na tela — o agente nunca aprova a si)');
      }
      const id = `hp-${Date.now().toString(36)}-${pendingProposals.length}`;
      // Cap: a fila é de aprovação humana, não um log infinito.
      if (pendingProposals.length >= 50) pendingProposals.shift();
      pendingProposals.push({
        id,
        reason: input.reason.trim(),
        changes,
        at: Date.now(),
        from: ctx.sessionId ?? 'unknown',
      });
      return Object.freeze({
        ok: true,
        proposalId: id,
        note: 'proposta enfileirada para aprovação humana — nada foi aplicado',
      });
    }

    if (action === 'apply') {
      // Worker (aberto por outro agente) nunca aplica — só propõe.
      if (ctx.role === 'worker') {
        throw new Error(
          'harness_apply_requires_orchestrator: use action=propose com reason ' +
            '(o dono aprova na tela; assertiva do agente não é aprovação)',
        );
      }
      if (changes.length === 0) throw new Error('apply exige change/changes');
      const outcome = applyHarnessChanges(getHarnessTable(), changes);
      if (!outcome.ok) {
        return Object.freeze({
          ok: false,
          ...(outcome.message ? { message: outcome.message } : {}),
          ...(outcome.problems ? { problems: outcome.problems } : {}),
          note: 'nada foi escrito (all-or-nothing)',
        });
      }
      persistHarnessTable(outcome.table);
      return Object.freeze({ ok: true, table: outcome.table });
    }

    if (action === 'simulate' || input.query) {
      const query = (input.query ?? '').trim();
      const resolution = resolveHarnessType(getHarnessTable(), query);
      return Object.freeze({
        simulation: true,
        query,
        resolution,
        receipt: formatHarnessReceipt({
          resolution,
          classificationVia: resolution.via === 'default' ? 'default' : 'keyword',
        }),
        note: 'preview determinístico da regra — não é decisão de Jev; o recibo do spawn é autoridade',
      });
    }

    // read
    const table = getHarnessTable();
    if (input.id) {
      const resolution = resolveHarnessType(table, input.id);
      return Object.freeze({
        id: resolution.typeId,
        categoryId: resolution.categoryId,
        name: resolution.typeName,
        values: resolution.values,
        via: resolution.via,
        appliesIn: 'agentic mission (a free pane edits it, never uses it)',
      });
    }
    return Object.freeze({
      version: table.version,
      categories: table.categories,
      options: {
        efforts: ['low', 'medium', 'high'],
        canApply: ctx.role !== 'worker',
      },
    });
  },
};

/** Helper de receipt para o caminho de spawn (tools-panes). */
export function harnessReceiptForTask(
  task: string | undefined,
  explicit?: { cli?: string; model?: string; effort?: 'low' | 'medium' | 'high'; agent?: string },
): string | null {
  if (!task?.trim()) return null;
  const resolution = resolveHarnessType(getHarnessTable(), task);
  return formatHarnessReceipt({ resolution, explicit });
}

/** Gate de skill do harness para o spawn (OVKA-713). */
export function harnessSkillGate(
  task: string | undefined,
  skillName: string,
): { allowed: boolean; filter: 'none' | 'declared'; reason?: string } {
  if (!task?.trim()) return { allowed: true, filter: 'none' };
  const resolution = resolveHarnessType(getHarnessTable(), task);
  return isSkillAllowedByHarness(resolution.values as HarnessTypeValues, skillName);
}

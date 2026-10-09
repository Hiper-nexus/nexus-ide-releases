import { z } from 'zod';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from './scoped-store';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  createScopedEffectOutboxStore,
  EffectOutboxStore,
  REPLAY_SAFE_EFFECT_TYPES,
  type EffectClass,
  type EffectOutboxEnqueueInput,
  type EffectOutboxEntry,
} from './effect-outbox';

/**
 * ORC-04 — recibo de comando com `resultSequence` (porte da política T3
 * `CommandReceiptStore.ts` @ 26285ab; casca reescrita em better-sqlite).
 *
 * Idempotência cobre o journal, mas não devolvia o MESMO recibo de um
 * `nexus_*` com efeito. Retry após timeout caía em `effectMayHaveCommitted`.
 * Mesmo `commandId` duas vezes → um efeito; o segundo lê o recibo e a
 * sequence final. Recibo reservado com sequence 0 se o processo morrer no
 * meio (o T3 faz isso de propósito).
 *
 * Status T3: `accepted` | `rejected`. `insertIfAbsent` para o primeiro
 * aceite; `upsert` para assentar sequence/erro.
 */

export type CommandReceiptStatus = 'accepted' | 'rejected';
export type CommandReceiptAggregateKind = 'thread' | 'project';

export interface CommandReceipt {
  readonly commandId: string;
  readonly aggregateKind: CommandReceiptAggregateKind;
  readonly aggregateId: string;
  readonly commandType: string;
  readonly acceptedAt: number;
  /** 0 enquanto não assentado; a sequence final só no upsert. */
  readonly resultSequence: number;
  readonly status: CommandReceiptStatus;
  readonly error: string | null;
  readonly effectClass: EffectClass;
  /** Resultado JSON do despacho, quando o handler já terminou. */
  readonly outcomeJson: string | null;
}

export interface CommandReceiptInsertInput {
  readonly commandId: string;
  readonly commandType: string;
  readonly acceptedAt?: number;
  readonly resultSequence?: number;
  readonly status?: CommandReceiptStatus;
  readonly error?: string | null;
  /** Identidade do aggregate: thread (missão/pane) ou projeto. */
  readonly threadId?: string;
  readonly projectId?: string;
  readonly generatedInvocation?: boolean;
}

export interface CommandReceiptUpsertInput extends CommandReceiptInsertInput {
  readonly commandId: string;
  readonly resultSequence: number;
  readonly status: CommandReceiptStatus;
}

const rowSchema = z
  .object({
    command_id: z.string().min(1).max(128),
    aggregate_kind: z.enum(['thread', 'project']),
    aggregate_id: z.string().min(1).max(128),
    command_type: z.string().min(1).max(128),
    accepted_at: z.number().int().nonnegative(),
    result_sequence: z.number().int().nonnegative(),
    status: z.enum(['accepted', 'rejected']),
    error: z.string().max(512).nullable(),
    effect_class: z.enum(['process_bound', 'replay_safe']),
    outcome_json: z.string().max(32768).nullable(),
    generated_invocation: z.number().int().min(0).max(1),
  })
  .strict();

const insertSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    commandType: z.string().min(1).max(128),
    acceptedAt: z.number().int().nonnegative().optional(),
    resultSequence: z.number().int().nonnegative().optional(),
    status: z.enum(['accepted', 'rejected']).optional(),
    error: z.string().max(512).nullish(),
    threadId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(128).optional(),
    /** True quando o commandId foi um UUID do despacho, não um operationId. */
    generatedInvocation: z.boolean().optional(),
  })
  .strict();

/** Aceite que ainda vai enfileirar efeito: só `accepted` com sequence 0. */
const acceptanceSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    commandType: z.string().min(1).max(128),
    acceptedAt: z.number().int().nonnegative().optional(),
    resultSequence: z.literal(0).optional(),
    status: z.literal('accepted').optional(),
    threadId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(128).optional(),
    generatedInvocation: z.boolean().optional(),
  })
  .strict();

export interface CommandEffectAcceptanceInput {
  readonly commandId: string;
  readonly commandType: string;
  readonly acceptedAt?: number;
  readonly resultSequence?: 0;
  readonly status?: 'accepted';
  readonly threadId?: string;
  readonly projectId?: string;
  readonly generatedInvocation?: boolean;
}

function rowToReceipt(row: unknown): CommandReceipt {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    throw new ScopedStoreCorruptionError('command_receipts', { cause: parsed.error });
  }
  const value = parsed.data;
  return {
    commandId: value.command_id,
    aggregateKind: value.aggregate_kind,
    aggregateId: value.aggregate_id,
    commandType: value.command_type,
    acceptedAt: value.accepted_at,
    resultSequence: value.result_sequence,
    status: value.status,
    error: value.error,
    effectClass: value.effect_class,
    outcomeJson: value.outcome_json,
  };
}

function resolveAggregate(input: {
  readonly threadId?: string;
  readonly projectId?: string;
}): { kind: CommandReceiptAggregateKind; id: string } {
  if (input.threadId) return { kind: 'thread', id: input.threadId };
  if (input.projectId) return { kind: 'project', id: input.projectId };
  throw new Error('command receipt requires threadId or projectId');
}

function existingCommandEffect(
  outbox: EffectOutboxStore,
  commandId: string,
  effectId: string,
): EffectOutboxEntry | null {
  const byId = outbox.get(effectId);
  if (byId) {
    if (byId.commandId !== commandId) {
      throw new Error('effect outbox id is already bound to another command');
    }
    return byId;
  }
  return outbox.listByCommandId(commandId)[0] ?? null;
}

function classForCommandType(commandType: string): EffectClass {
  return (REPLAY_SAFE_EFFECT_TYPES as readonly string[]).includes(commandType)
    ? 'replay_safe'
    : 'process_bound';
}

export class CommandReceiptStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  /**
   * Recibo e efeito na mesma transação. O id do efeito, quando omitido, é
   * o `commandId`. Se o recibo já existe, não cria outro efeito: a linha
   * que ainda está no outbox é devolvida; se o prune já a apagou, o
   * retorno é `effect: null` e o comando não volta a pending.
   */
  acceptCommandEffect(
    outbox: EffectOutboxStore,
    receiptInput: CommandEffectAcceptanceInput,
    effectInput: EffectOutboxEnqueueInput,
  ): { readonly inserted: boolean; readonly effect: EffectOutboxEntry | null } {
    const receipt = acceptanceSchema.parse(receiptInput);
    if (effectInput.commandId !== receipt.commandId) {
      throw new Error('command receipt and effect commandId must match');
    }
    if (receipt.threadId && effectInput.threadId !== receipt.threadId) {
      throw new Error('command receipt and effect threadId must match');
    }
    if (effectInput.type !== receipt.commandType) {
      throw new Error('command receipt and effect type must match');
    }
    if (
      outbox.scope.projectId !== this.scope.projectId ||
      outbox.scope.checkoutId !== this.scope.checkoutId
    ) {
      throw new Error('command receipt and effect must share a project scope');
    }
    const db = this.#binding.writeDatabase();
    return db.transaction(() => {
      const inserted = this.insertIfAbsent(receipt);
      const effectId = effectInput.id ?? receipt.commandId;
      if (!inserted) {
        // F-1045: commandId reusado com outra identidade é conflito — nunca
        // devolve o efeito antigo em silêncio. Identidade do recibo E do efeito.
        const stored = this.getByCommandId(receipt.commandId);
        const aggregate = resolveAggregate(receipt);
        if (
          !stored ||
          stored.commandType !== receipt.commandType ||
          stored.aggregateKind !== aggregate.kind ||
          stored.aggregateId !== aggregate.id
        ) {
          throw new Error('command receipt is already bound to another command');
        }
        const effect = existingCommandEffect(outbox, receipt.commandId, effectId);
        if (
          effect &&
          (effect.commandId !== receipt.commandId ||
            effect.type !== effectInput.type ||
            effect.threadId !== effectInput.threadId)
        ) {
          throw new Error('effect outbox command is already bound to another effect');
        }
        return { inserted: false, effect };
      }
      const effect = outbox.enqueue({
        ...effectInput,
        id: effectId,
      });
      return { inserted: true, effect };
    })();
  }

  /**
   * Polítia T3 `insertIfAbsent`: primeiro aceite. Segunda chamada com o mesmo
   * `commandId` devolve false e NÃO sobrescreve o recibo que o agente já leu.
   */
  insertIfAbsent(raw: CommandReceiptInsertInput): boolean {
    const input = insertSchema.parse(raw);
    const aggregate = resolveAggregate(input);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    return db.transaction((): boolean => {
      const existing = db
        .prepare(`SELECT 1 FROM command_receipts WHERE command_id = ?`)
        .get(input.commandId);
      if (existing) return false;
      db.prepare(
        `INSERT INTO command_receipts (
           command_id, aggregate_kind, aggregate_id, command_type,
           accepted_at, result_sequence, status, error, effect_class,
           generated_invocation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.commandId,
        aggregate.kind,
        aggregate.id,
        input.commandType,
        input.acceptedAt ?? now,
        input.resultSequence ?? 0,
        input.status ?? 'accepted',
        input.error ?? null,
        classForCommandType(input.commandType),
        input.generatedInvocation ? 1 : 0,
      );
      return true;
    })();
  }

  /**
   * Política T3 `upsert`: assenta sequence/erro. Cria se ainda não existe
   * (caminho de recovery que não passou pelo insertIfAbsent).
   */
  upsert(raw: CommandReceiptUpsertInput): CommandReceipt {
    const input = insertSchema.extend({
      resultSequence: z.number().int().nonnegative(),
      status: z.enum(['accepted', 'rejected']),
    }).parse(raw);
    const aggregate = resolveAggregate(input);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    return db.transaction((): CommandReceipt => {
      const existing = db
        .prepare(`SELECT * FROM command_receipts WHERE command_id = ?`)
        .get(input.commandId);
      if (existing) {
        const stored = rowToReceipt(existing);
        if (
          stored.commandType !== input.commandType ||
          stored.aggregateKind !== aggregate.kind ||
          stored.aggregateId !== aggregate.id
        ) {
          throw new Error('command receipt is already bound to another command');
        }
        db.prepare(
          `UPDATE command_receipts
           SET result_sequence = ?, status = ?, error = ?
           WHERE command_id = ?`,
        ).run(
          input.resultSequence,
          input.status,
          input.error ?? null,
          input.commandId,
        );
      } else {
        db.prepare(
          `INSERT INTO command_receipts (
             command_id, aggregate_kind, aggregate_id, command_type,
             accepted_at, result_sequence, status, error, effect_class,
             generated_invocation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.commandId,
          aggregate.kind,
          aggregate.id,
          input.commandType,
          input.acceptedAt ?? now,
          input.resultSequence,
          input.status,
          input.error ?? null,
          classForCommandType(input.commandType),
          input.generatedInvocation ? 1 : 0,
        );
      }
      const row = db
        .prepare(`SELECT * FROM command_receipts WHERE command_id = ?`)
        .get(input.commandId);
      return rowToReceipt(row);
    })();
  }

  /**
   * Grava o resultado do primeiro despacho. O retry lê isto e não roda o
   * handler de novo. Não mexe em `result_sequence`: o efeito pode continuar
   * pending enquanto o resultado da tool já é conhecido.
   */
  rememberDispatchOutcome(commandId: string, outcome: unknown): void {
    const id = z.string().min(1).max(128).parse(commandId);
    let json: string;
    try {
      json = JSON.stringify(outcome);
    } catch {
      return;
    }
    if (json.length === 0 || json.length > 32_768) return;
    this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE command_receipts
         SET outcome_json = ?
         WHERE command_id = ? AND outcome_json IS NULL`,
      )
      .run(json, id);
  }

  getByCommandId(commandId: string): CommandReceipt | null {
    const row = this.#binding
      .readDatabase()
      .prepare(`SELECT * FROM command_receipts WHERE command_id = ?`)
      .get(commandId);
    return row ? rowToReceipt(row) : null;
  }

  /**
   * Recibo com sequence 0 = não assentado (processo morreu no meio).
   * O T3 mantém a marca de propósito; não a inventa depois.
   */
  listUnsettled(): CommandReceipt[] {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT * FROM command_receipts
         WHERE result_sequence = 0
         ORDER BY accepted_at ASC`,
      )
      .all();
    return rows.map(rowToReceipt);
  }
}

/**
 * Aceite de um `nexus_*` com efeito: recibo e `checkpoint.capture` na mesma
 * transação. O gate de conclusão observa esse tipo enquanto estiver
 * pending/running. `commandType` é o tipo do efeito, não o nome da tool.
 */
export function acceptDispatchCheckpointEffect(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  command: {
    readonly commandId: string;
    readonly threadId: string;
    readonly toolName: string;
    readonly missionBound: boolean;
    /** UUID do despacho. Some no prune. operationId do chamador não leva isto. */
    readonly generatedInvocation?: boolean;
  },
): { readonly inserted: boolean; readonly effect: EffectOutboxEntry | null } {
  const receipts = createScopedCommandReceiptStore(runtimeManager, scope);
  const outbox = createScopedEffectOutboxStore(runtimeManager, scope);
  const accepted = receipts.acceptCommandEffect(
    outbox,
    command.missionBound
      ? {
          commandId: command.commandId,
          commandType: 'checkpoint.capture',
          threadId: command.threadId,
          generatedInvocation: command.generatedInvocation,
        }
      : {
          commandId: command.commandId,
          commandType: 'checkpoint.capture',
          projectId: scope.projectId,
          generatedInvocation: command.generatedInvocation,
        },
    {
      id: command.commandId,
      commandId: command.commandId,
      threadId: command.threadId,
      type: 'checkpoint.capture',
      payload: { toolName: command.toolName },
    },
  );
  if (!accepted.inserted) {
    const storedTool = toolNameFromEffectPayload(accepted.effect?.payload);
    if (storedTool && storedTool !== command.toolName) {
      throw new Error('command receipt is already bound to another command');
    }
  }
  return accepted;
}

function toolNameFromEffectPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const toolName = (payload as { toolName?: unknown }).toolName;
  return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
}

export function createScopedCommandReceiptStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): CommandReceiptStore {
  return new CommandReceiptStore(runtimeManager, scope, options);
}

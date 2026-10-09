/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62.
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Upstream reference: apps/server/src/orchestration-v2/CommandReceiptStore.ts.
 * Nexus changes: Scoped SQLite receipt vocabulary and insertion adapted; Main dispatch adds original caller-bound safe response observations and event sequences. Original owned-process lifetime/verifier transactions refuse distinct managers/scopes and never reconstruct results or native capabilities.
 */
import type Database from 'better-sqlite3';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../../shared/cursor-pagination';
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
  /** 0 while unresolved; dispatch settlement points to a real journal event. */
  readonly resultSequence: number;
  readonly status: CommandReceiptStatus;
  readonly error: string | null;
  readonly effectClass: EffectClass;
  /** Fixed safe response projection; never original handler output or error. */
  readonly outcomeJson: string | null;
  readonly bindingDigest: string | null;
  readonly dispatchState: 'admitted'|'observed-success'|'observed-rejection'|'unknown'|'settled';
  readonly physicalState: 'none'|'pending'|'proven'|'unknown';
}

export interface CommandReceiptInsertInput {
  readonly bindingDigest?: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly acceptedAt?: number;
  readonly resultSequence?: number;
  readonly status?: CommandReceiptStatus;
  readonly error?: string | null;
  /** Identidade do aggregate: thread (missão/pane) ou projeto. */
  readonly threadId?: string;
  readonly projectId?: string;
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
    binding_digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
    dispatch_state: z.enum(['admitted','observed-success','observed-rejection','unknown','settled']).optional(),
    physical_state: z.enum(['none','pending','proven','unknown']).optional(),
    generated_invocation: z.union([z.literal(0),z.literal(1)]).optional(),
  })
  .strict();

const insertSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    commandType: z.string().min(1).max(128),
    acceptedAt: z.number().int().nonnegative().optional(),
    resultSequence: z.number().int().nonnegative().optional(),
    status: z.enum(['accepted', 'rejected']).optional(),
    error: z.string().max(512).nullish(),
    threadId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(128).optional(),
  })
  .strict();

/** Aceite que ainda vai enfileirar efeito: só `accepted` com sequence 0. */
const acceptanceSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    commandType: z.string().min(1).max(128),
    acceptedAt: z.number().int().nonnegative().optional(),
    resultSequence: z.literal(0).optional(),
    status: z.literal('accepted').optional(),
    threadId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(128).optional(),
  })
  .strict();

export interface CommandEffectAcceptanceInput {
  readonly bindingDigest?: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly acceptedAt?: number;
  readonly resultSequence?: 0;
  readonly status?: 'accepted';
  readonly threadId?: string;
  readonly projectId?: string;
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
    bindingDigest: value.binding_digest ?? null,
    dispatchState: value.dispatch_state ?? 'unknown',
    physicalState: value.physical_state ?? 'none',
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

  #appendDispatchEvent(db: Database.Database, commandId: string, kind: string, response: string | null, physical: string): number {
    db.prepare(`INSERT OR IGNORE INTO command_dispatch_events(command_id,event_kind,occurred_at,response_kind,physical_state) VALUES(?,?,?,?,?)`)
      .run(commandId,kind,this.#binding.now(),response,physical);
    const event=db.prepare('SELECT sequence FROM command_dispatch_events WHERE command_id=? AND event_kind=?').get(commandId,kind) as {sequence:number};
    return event.sequence;
  }

  /** Logical response observation only. No checkpoint/physical obligation is implied. */
  acceptDispatchObservation(input: {commandId:string;toolName:string;bindingDigest:string;generated:boolean;threadId?:string;projectId?:string}): {inserted:boolean} {
    const db=this.#binding.writeDatabase();
    return db.transaction(()=>{
      const inserted=this.insertIfAbsent({commandId:input.commandId,commandType:'dispatch.observation',bindingDigest:input.bindingDigest,threadId:input.threadId,projectId:input.projectId});
      const receipt=this.getByCommandId(input.commandId)!;
      const aggregate=resolveAggregate(input);
      if(receipt.bindingDigest!==input.bindingDigest || receipt.commandType!=='dispatch.observation' || receipt.aggregateKind!==aggregate.kind || receipt.aggregateId!==aggregate.id) throw new Error('command_effect_identity_conflict');
      if(inserted){
        db.prepare("UPDATE command_receipts SET dispatch_state='admitted',generated_invocation=? WHERE command_id=?").run(input.generated?1:0,input.commandId);
        this.#appendDispatchEvent(db,input.commandId,'admitted',null,'none');
      }
      return {inserted};
    })();
  }

  /** Main-owned marker BEFORE any preparation capable of creating external work. */
  beginPhysicalDispatch(outbox: EffectOutboxStore, commandId: string, bindingDigest: string, toolName: string): void {
    if (!['nexus_terminal_run','nexus_bg_run'].includes(toolName)) throw new Error('unsupported physical producer');
    if (!outbox.sharesTransactionWith(this.#binding)) throw new Error('physical effect must share the same transaction database');
    const db=this.#binding.writeDatabase();
    db.transaction(()=>{
      const receipt=this.getByCommandId(commandId);
      if (!receipt || receipt.commandType!=='dispatch.observation' || receipt.bindingDigest!==bindingDigest || receipt.physicalState!=='none' || receipt.outcomeJson!==null || receipt.resultSequence!==0) throw new Error('physical dispatch identity conflict');
      outbox.enqueue({id:commandId,commandId,threadId:receipt.aggregateId,type:'dispatch.physical-settlement',payload:{toolName}});
      db.prepare("UPDATE command_receipts SET physical_state='pending' WHERE command_id=?").run(commandId);
      this.#appendDispatchEvent(db,commandId,'physical-start',null,'pending');
    })();
  }

  /** A captured Main lifetime may record an exit fact after caller revocation. */
  recordPhysicalDispatchProof(commandId: string, bindingDigest: string, proof: 'proven'|'unknown'): void {
    const db=this.#binding.writeDatabase();
    db.transaction(()=>{
      const receipt=this.getByCommandId(commandId);
      if (!receipt || receipt.bindingDigest!==bindingDigest || !['pending','unknown'].includes(receipt.physicalState)) throw new Error('physical dispatch identity conflict');
      db.prepare('UPDATE command_receipts SET physical_state=? WHERE command_id=?').run(proof,commandId);
      this.#appendDispatchEvent(db,commandId,proof==='proven'?'physical-proven':'physical-unknown',null,proof);
    })();
  }

  /** Verify persisted exit proof; never re-execute a mutation or infer flight absence. */
  settlePhysicalDispatch(outbox: EffectOutboxStore, entry: EffectOutboxEntry): boolean {
    if (!outbox.sharesTransactionWith(this.#binding)) throw new Error('physical effect must share the same transaction database');
    if(entry.type!=='dispatch.physical-settlement' || entry.status!=='running' || !entry.leaseOwner)return false;
    const db=this.#binding.writeDatabase();
    return db.transaction(()=>{
      const receipt=this.getByCommandId(entry.commandId);
      if(!receipt || receipt.physicalState!=='proven' || receipt.outcomeJson===null)return false;
      const now=this.#binding.now();
      const changed=db.prepare("UPDATE effect_outbox SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?,last_error=NULL WHERE effect_id=? AND command_id=? AND effect_type='dispatch.physical-settlement' AND status='running' AND lease_owner=? AND attempt_count=?")
        .run(now,now,entry.id,entry.commandId,entry.leaseOwner,entry.attemptCount);
      if(changed.changes!==1)return false;
      const sequence=this.#appendDispatchEvent(db,entry.commandId,'settled',receipt.dispatchState,'proven');
      db.prepare("UPDATE command_receipts SET result_sequence=?,dispatch_state='settled' WHERE command_id=?").run(sequence,entry.commandId);
      return true;
    })();
  }

  /** Process loss cannot reconstruct supervisor/OCI authority from a command ID. */
  markPhysicalDispatchesUnknownAfterProcessLoss(): number {
    return this.#binding.writeDatabase().prepare("UPDATE command_receipts SET physical_state='unknown' WHERE physical_state='pending' AND result_sequence=0").run().changes;
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
    if (!outbox.sharesTransactionWith(this.#binding)) {
      throw new Error('command receipt and effect must share the same transaction database');
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
        if (receipt.bindingDigest !== undefined && stored?.bindingDigest !== receipt.bindingDigest) throw new Error('command_effect_identity_conflict');
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
           accepted_at, result_sequence, status, error, effect_class, binding_digest
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
        input.bindingDigest ?? null,
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
        if (input.bindingDigest !== undefined && stored.bindingDigest !== input.bindingDigest) throw new Error('command_effect_identity_conflict');
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
             accepted_at, result_sequence, status, error, effect_class, binding_digest
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
          input.bindingDigest ?? null,
        );
      }
      const row = db
        .prepare(`SELECT * FROM command_receipts WHERE command_id = ?`)
        .get(input.commandId);
      return rowToReceipt(row);
    })();
  }

  /** Record a bounded response observation, never a handler result or raw error.
   * This is logical observation only; it is not physical/capture settlement.
   */
  rememberDispatchOutcome(commandId: string, outcome: unknown): void {
    const id = z.string().min(1).max(128).parse(commandId);
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return;
    const value = outcome as Record<string, unknown>;
    if (typeof value.ok !== 'boolean' || typeof value.tool !== 'string' ||
        !/^nexus_[a-z0-9_]{1,120}$/u.test(value.tool)) return;
    const response = value.ok ? 'observed-success' :
      value.effectMayHaveCommitted === true ? 'unknown' : 'observed-rejection';
    const projection = {
      schema: 'nexus.command-response/v1',
      tool: value.tool,
      response,
      originalResultAvailable: false,
      effectMayHaveCommitted: value.ok || value.effectMayHaveCommitted === true,
      denied: value.denied === true,
    };
    const db=this.#binding.writeDatabase();
    db.transaction(()=>{
      const stored=this.getByCommandId(id);
      if(!stored || stored.outcomeJson!==null)return;
      db.prepare('UPDATE command_receipts SET outcome_json=? WHERE command_id=? AND outcome_json IS NULL').run(JSON.stringify(projection),id);
      if(stored.commandType!=='dispatch.observation')return;
      db.prepare('UPDATE command_receipts SET dispatch_state=? WHERE command_id=?').run(response,id);
      this.#appendDispatchEvent(db,id,'response',response,stored.physicalState);
      if(stored.physicalState==='none' && response!=='unknown'){
        const sequence=this.#appendDispatchEvent(db,id,'settled',response,'none');
        db.prepare("UPDATE command_receipts SET result_sequence=?,dispatch_state='settled',status=? WHERE command_id=?")
          .run(sequence,response==='observed-rejection'?'rejected':'accepted',id);
      }
    })();
  }

  getByCommandId(commandId: string): CommandReceipt | null {
    const row = this.#binding
      .readDatabase()
      .prepare(`SELECT * FROM command_receipts WHERE command_id = ?`)
      .get(commandId);
    return row ? rowToReceipt(row) : null;
  }

  countUnsettled(): number {
    const row=this.#binding.readDatabase().prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE result_sequence=0').get() as {n:number};
    return row.n;
  }

  listUnsettledMetadata(query: {limit?:number;cursor?:string|null} = {}): {rows:Array<Omit<CommandReceipt,'outcomeJson'|'error'>>;nextCursor:string|null} {
    const limit=z.number().int().min(1).max(100).parse(query.limit??100);
    const slice=`receipts:${this.scope.projectId}:${this.scope.checkoutId}`;
    let key:number|undefined;let id:string|undefined;
    if(query.cursor!==undefined && query.cursor!==null){const cursor=decodeCursor(query.cursor);if(cursor.s!==slice || typeof cursor.k!=='number' || !Number.isSafeInteger(cursor.k) || cursor.k<0 || !cursor.i)throw new InvalidCursorError();key=cursor.k;id=cursor.i;}
    const columns='command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,effect_class,binding_digest,dispatch_state,physical_state,generated_invocation';
    const rows=this.#binding.readDatabase().prepare(`SELECT ${columns} FROM command_receipts WHERE result_sequence=0 ${key===undefined?'':'AND (accepted_at>? OR (accepted_at=? AND command_id>?))'} ORDER BY accepted_at,command_id LIMIT ?`)
      .all(...(key===undefined?[limit+1]:[key,key,id,limit+1])) as Array<Record<string,unknown>>;
    const page=rows.slice(0,limit).map(row=>{const {outcomeJson:_out,error:_error,...metadata}=rowToReceipt({...row,outcome_json:null,error:null});return metadata;});
    const last=page.at(-1);return {rows:page,nextCursor:rows.length>limit&&last?encodeCursor({key:last.acceptedAt,id:last.commandId,slice}):null};
  }

  /** Compatibility view is bounded and deliberately excludes outcome bodies. */
  listUnsettled(): CommandReceipt[] {
    return this.listUnsettledMetadata().rows.map(row=>({...row,outcomeJson:null,error:null}));
  }

  pruneGeneratedSettled(input: {retentionMs?:number;limit?:number} = {}): number {
    const limit=z.number().int().min(1).max(500).parse(input.limit??100);
    const cutoff=this.#binding.now()-z.number().finite().min(0).parse(input.retentionMs??7*24*60*60*1000);
    return this.#binding.writeDatabase().prepare(`DELETE FROM command_receipts WHERE command_id IN(
      SELECT command_id FROM command_receipts WHERE generated_invocation=1 AND result_sequence>0 AND dispatch_state='settled' AND physical_state IN('none','proven') AND accepted_at<=? ORDER BY accepted_at,command_id LIMIT ?)`)
      .run(cutoff,limit).changes;
  }

}

/** Isolated legacy/schema acceptance helper. No production dispatch calls it;
 * it does not prove Git capture or owned exit. Unproven capture stays deferred. */
export function acceptDispatchCheckpointEffect(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  command: {
    readonly commandId: string;
    readonly threadId: string;
    readonly toolName: string;
    readonly missionBound: boolean;
    readonly bindingDigest?: string;
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
          bindingDigest: command.bindingDigest,
          threadId: command.threadId,
        }
      : {
          commandId: command.commandId,
          commandType: 'checkpoint.capture',
          bindingDigest: command.bindingDigest,
          projectId: scope.projectId,
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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import { priceForModel } from '../orch/pricing';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { UsageEvent } from './claude-transcript';
import { legacyCodexUsageMessageId } from './codex-transcript';

/**
 * Project-local token accounting backed by the V1 `usage_events` contract.
 * A store is permanently bound to one immutable project/checkout scope; paths
 * never select a database and no process-global/in-memory persistence exists.
 */

export type UsageProvider = 'claude' | 'codex' | (string & {});

export interface UsageRecord extends UsageEvent {
  /** Cost computed/reported by the provider CLI; not an invoice or plan debit. */
  reportedCostUsd?: number;
  paneId?: string | null;
  missionId?: string | null;
  /** Exact Nexus vault account that owned the provider session. */
  accountId?: string | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

export interface PaneUsageTotals extends UsageTotals {
  paneId: string;
}

export interface AccountUsageTotals extends UsageTotals {
  accountId: string;
  provider: string;
}

export interface CapturedProviderSession {
  provider: string;
  sessionId: string;
  accountId?: string;
  capturedAt: number;
}

export interface CodexSessionAuthority {
  paneId: string | null;
  executionRoot: string;
}

interface UsageMetadata {
  schemaVersion: 1;
  sessionId: string;
  messageId: string | null;
  displayPaneId: string | null;
  accountId?: string | null;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  sourceTimestamp: number | null;
  recordedAt: number;
}

interface TotalsRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_micros: number | null;
  turns: number | null;
}

interface PersistedUsageIdentityRow {
  model: unknown;
  input_units: unknown;
  output_units: unknown;
  session_id: unknown;
  message_id: unknown;
  cache_read_tokens: unknown;
  cache_write_5m_tokens: unknown;
  cache_write_1h_tokens: unknown;
  source_timestamp: unknown;
}

interface ResolvedUsageIdentity {
  id: string;
  existed: boolean;
}

const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_5M_RATIO = 1.25;
const CACHE_WRITE_1H_RATIO = 2;
const MICROS_PER_USD = 1_000_000;
const TOKEN_EVENT_TYPE = 'token-usage';

const usageProviderSchema = z.string().trim().min(1).max(128);
const entityIdSchema = z.string().min(1).max(256);
const nullableEntityIdSchema = entityIdSchema.nullish();
const providerUsageEventSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512).nullable(),
    model: z.string().min(1).max(256),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    cacheReadTokens: z.number().int().nonnegative().safe(),
    cacheWrite5mTokens: z.number().int().nonnegative().safe(),
    cacheWrite1hTokens: z.number().int().nonnegative().safe(),
    timestamp: z.number().int().nonnegative().safe().nullable(),
  });
const usageEventSchema = providerUsageEventSchema
  .extend({
    reportedCostUsd: z.number().finite().nonnegative().optional(),
    paneId: nullableEntityIdSchema.optional(),
    missionId: nullableEntityIdSchema.optional(),
    accountId: nullableEntityIdSchema.optional(),
  })
  .strict();

const sessionMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512).nullable(),
    displayPaneId: z.string().min(1).max(256).nullable(),
    accountId: z.string().min(1).max(256).nullable().optional(),
    cacheReadTokens: z.number().int().nonnegative().safe(),
    cacheWrite5mTokens: z.number().int().nonnegative().safe(),
    cacheWrite1hTokens: z.number().int().nonnegative().safe(),
    sourceTimestamp: z.number().int().nonnegative().safe().nullable(),
    recordedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
const persistedPaneExecutionScopeSchema = z
  .object({
    executionScope: projectExecutionScopeSchema,
  })
  .passthrough();
const persistedUsageIdentitySchema = z
  .object({
    model: z.string().min(1).max(256),
    input_units: z.number().int().nonnegative().safe(),
    output_units: z.number().int().nonnegative().safe(),
    session_id: z.string().min(1).max(512),
    message_id: z.string().min(1).max(512),
    cache_read_tokens: z.number().int().nonnegative().safe(),
    cache_write_5m_tokens: z.number().int().nonnegative().safe(),
    cache_write_1h_tokens: z.number().int().nonnegative().safe(),
    source_timestamp: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();

/** Cost in USD derived from a provider-reported event and the pricing table. */
export function computeRealCost(ev: UsageEvent): number {
  const parsed = providerUsageEventSchema.parse(ev);
  const price = priceForModel(parsed.model);
  const cacheReadPrice =
    price.cacheReadPerM !== undefined
      ? price.cacheReadPerM
      : price.inputPerM * CACHE_READ_RATIO;
  const cacheWrite5mPrice =
    price.cacheWritePerM !== undefined
      ? price.cacheWritePerM
      : price.inputPerM * CACHE_WRITE_5M_RATIO;
  const cacheWrite1hPrice = price.inputPerM * CACHE_WRITE_1H_RATIO;

  const cost =
    (parsed.inputTokens / MICROS_PER_USD) * price.inputPerM +
    (parsed.outputTokens / MICROS_PER_USD) * price.outputPerM +
    (parsed.cacheReadTokens / MICROS_PER_USD) * cacheReadPrice +
    (parsed.cacheWrite5mTokens / MICROS_PER_USD) * cacheWrite5mPrice +
    (parsed.cacheWrite1hTokens / MICROS_PER_USD) * cacheWrite1hPrice;
  if (!Number.isFinite(cost) || cost < 0) throw new Error('invalid usage cost');
  return cost;
}

function deterministicUsageId(
  provider: string,
  sessionId: string,
  messageId: string,
): string {
  const digest = createHash('sha256')
    .update(provider)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(messageId)
    .digest('hex');
  return `usage-${digest}`;
}

function isMatchingLegacyCodexUsage(
  row: PersistedUsageIdentityRow,
  record: UsageRecord,
  legacyMessageId: string,
  stableMessageId: string,
): boolean {
  let persisted: z.infer<typeof persistedUsageIdentitySchema>;
  try {
    persisted = persistedUsageIdentitySchema.parse(row);
  } catch (error) {
    throw new ScopedStoreCorruptionError('legacy Codex usage identity', {
      cause: error,
    });
  }
  const claimMatches =
    persisted.message_id === legacyMessageId ||
    persisted.message_id === stableMessageId;
  return Boolean(
    claimMatches &&
      persisted.model === record.model &&
      persisted.input_units === record.inputTokens &&
      persisted.output_units === record.outputTokens &&
      persisted.session_id === record.sessionId &&
      persisted.cache_read_tokens === record.cacheReadTokens &&
      persisted.cache_write_5m_tokens === record.cacheWrite5mTokens &&
      persisted.cache_write_1h_tokens === record.cacheWrite1hTokens &&
      persisted.source_timestamp === record.timestamp,
  );
}

function persistedUsageIdentity(
  db: Database.Database,
  id: string,
  provider: string,
): PersistedUsageIdentityRow | undefined {
  return db.prepare(
    `SELECT model,
            input_units,
            output_units,
            json_extract(metadata_json, '$.sessionId') AS session_id,
            json_extract(metadata_json, '$.messageId') AS message_id,
            json_extract(metadata_json, '$.cacheReadTokens') AS cache_read_tokens,
            json_extract(metadata_json, '$.cacheWrite5mTokens') AS cache_write_5m_tokens,
            json_extract(metadata_json, '$.cacheWrite1hTokens') AS cache_write_1h_tokens,
            json_extract(metadata_json, '$.sourceTimestamp') AS source_timestamp
     FROM usage_events
     WHERE id = ? AND provider = ? AND event_type = ?`,
  ).get(
    id,
    provider,
    TOKEN_EVENT_TYPE,
  ) as PersistedUsageIdentityRow | undefined;
}

function resolveMessageUsageIdentity(
  db: Database.Database,
  provider: string,
  record: UsageRecord,
  messageId: string,
): ResolvedUsageIdentity {
  const stableId = deterministicUsageId(provider, record.sessionId, messageId);
  const stableExists =
    db.prepare('SELECT 1 AS found FROM usage_events WHERE id = ?').get(
      stableId,
    ) !== undefined;
  if (stableExists || provider !== 'codex') {
    return { id: stableId, existed: stableExists };
  }

  const legacyMessageId = legacyCodexUsageMessageId(messageId);
  if (!legacyMessageId) return { id: stableId, existed: false };
  const legacyId = deterministicUsageId(
    provider,
    record.sessionId,
    legacyMessageId,
  );
  const legacyRow = persistedUsageIdentity(db, legacyId, provider);
  if (
    !legacyRow ||
    !isMatchingLegacyCodexUsage(
      legacyRow,
      record,
      legacyMessageId,
      messageId,
    )
  ) {
    return { id: stableId, existed: false };
  }
  // The legacy physical row claims exactly one v2 ordinal. Updating its
  // metadata with the stable id makes restart replay idempotent while allowing
  // other same-millisecond ordinals to insert.
  return { id: legacyId, existed: true };
}

function toTotals(row: TotalsRow | undefined): UsageTotals {
  const values = [
    row?.input_tokens ?? 0,
    row?.output_tokens ?? 0,
    row?.cache_read_tokens ?? 0,
    row?.cache_write_tokens ?? 0,
    row?.cost_micros ?? 0,
    row?.turns ?? 0,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ScopedStoreCorruptionError('usage totals');
  }
  return {
    inputTokens: values[0],
    outputTokens: values[1],
    cacheReadTokens: values[2],
    cacheWriteTokens: values[3],
    costUsd: values[4] / MICROS_PER_USD,
    turns: values[5],
  };
}

const TOTALS_SELECT = `
  SELECT COALESCE(SUM(input_units), 0) AS input_tokens,
         COALESCE(SUM(output_units), 0) AS output_tokens,
         COALESCE(SUM(CAST(json_extract(metadata_json, '$.cacheReadTokens') AS INTEGER)), 0)
           AS cache_read_tokens,
         COALESCE(SUM(
           CAST(json_extract(metadata_json, '$.cacheWrite5mTokens') AS INTEGER) +
           CAST(json_extract(metadata_json, '$.cacheWrite1hTokens') AS INTEGER)
         ), 0) AS cache_write_tokens,
         COALESCE(SUM(cost_micros), 0) AS cost_micros,
         COUNT(*) AS turns
  FROM usage_events`;

interface PaneOwnership {
  internalPaneId: string | null;
  missionId: string | null;
}

export class ScopedUsageStore {
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

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  /**
   * Upserts provider snapshots by (provider, session, message). Events without
   * a message id remain append-only, matching provider transcript semantics.
   */
  record(
    rawProvider: UsageProvider,
    rawRecord: UsageRecord,
  ): boolean {
    const provider = usageProviderSchema.parse(rawProvider);
    const record = usageEventSchema.parse(rawRecord);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const ownership = this.#resolvePaneOwnership(
      db,
      record.paneId ?? null,
      record.missionId ?? null,
    );
    const accountId =
      record.accountId ??
      this.accountIdForProviderSession(provider, record.sessionId);
    const costMicros = Math.round((record.reportedCostUsd ?? computeRealCost(record)) * MICROS_PER_USD);
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
      throw new Error('usage cost exceeds the supported range');
    }
    const metadata: UsageMetadata = sessionMetadataSchema.parse({
      schemaVersion: 1,
      sessionId: record.sessionId,
      messageId: record.messageId,
      displayPaneId: record.paneId ?? null,
      accountId,
      cacheReadTokens: record.cacheReadTokens,
      cacheWrite5mTokens: record.cacheWrite5mTokens,
      cacheWrite1hTokens: record.cacheWrite1hTokens,
      sourceTimestamp: record.timestamp,
      recordedAt: now,
    });
    const identity = record.messageId
      ? resolveMessageUsageIdentity(
          db,
          provider,
          record,
          record.messageId,
        )
      : { id: this.#binding.makeId('usage'), existed: false };
    db.prepare(
      `INSERT INTO usage_events
         (id, mission_id, pane_id, provider, model, event_type, input_units,
          output_units, cost_micros, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         mission_id = excluded.mission_id,
         pane_id = excluded.pane_id,
         model = excluded.model,
         input_units = excluded.input_units,
         output_units = excluded.output_units,
         cost_micros = excluded.cost_micros,
         metadata_json = excluded.metadata_json,
         occurred_at = excluded.occurred_at
       WHERE usage_events.provider = excluded.provider
         AND usage_events.event_type = excluded.event_type`,
    ).run(
      identity.id,
      ownership.missionId,
      ownership.internalPaneId,
      provider,
      record.model,
      TOKEN_EVENT_TYPE,
      record.inputTokens,
      record.outputTokens,
      costMicros,
      JSON.stringify(metadata),
      record.timestamp ?? now,
    );
    this.#binding.emitChange();
    return !identity.existed;
  }

  totals(): UsageTotals {
    const row = this.#binding
      .readDatabase()
      .prepare(`${TOTALS_SELECT} WHERE event_type = ?`)
      .get(TOKEN_EVENT_TYPE) as TotalsRow | undefined;
    return toTotals(row);
  }

  totalsBySession(rawSessionId: string): UsageTotals {
    const sessionId = z.string().min(1).max(512).parse(rawSessionId);
    const row = this.#binding
      .readDatabase()
      .prepare(
        `${TOTALS_SELECT}
         WHERE event_type = ?
           AND json_extract(metadata_json, '$.sessionId') = ?`,
      )
      .get(TOKEN_EVENT_TYPE, sessionId) as TotalsRow | undefined;
    return toTotals(row);
  }

  totalsByMission(rawMissionId: string): UsageTotals {
    const missionId = entityIdSchema.parse(rawMissionId);
    const row = this.#binding
      .readDatabase()
      .prepare(`${TOTALS_SELECT} WHERE event_type = ? AND mission_id = ?`)
      .get(TOKEN_EVENT_TYPE, missionId) as TotalsRow | undefined;
    return toTotals(row);
  }

  breakdownByModel(): Array<{ model: string } & UsageTotals> {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `${TOTALS_SELECT.replace('SELECT', 'SELECT model,')}
         WHERE event_type = ? GROUP BY model ORDER BY model ASC`,
      )
      .all(TOKEN_EVENT_TYPE) as Array<TotalsRow & { model: unknown }>;
    return rows.map((row) => {
      const model = z.string().min(1).max(256).parse(row.model);
      return { model, ...toTotals(row) };
    });
  }

  totalsByPane(): PaneUsageTotals[] {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `${TOTALS_SELECT.replace(
          'SELECT',
          `SELECT COALESCE(
             mp.pane_id,
             json_extract(usage_events.metadata_json, '$.displayPaneId')
           ) AS display_pane_id,`,
        )}
         LEFT JOIN mission_panes mp ON mp.id = usage_events.pane_id
         WHERE usage_events.event_type = ?
           AND COALESCE(
             mp.pane_id,
             json_extract(usage_events.metadata_json, '$.displayPaneId')
           ) IS NOT NULL
         GROUP BY display_pane_id
         ORDER BY display_pane_id ASC`,
      )
      .all(TOKEN_EVENT_TYPE) as Array<TotalsRow & { display_pane_id: unknown }>;
    return rows.map((row) => ({
      paneId: entityIdSchema.parse(row.display_pane_id),
      ...toTotals(row),
    }));
  }

  totalsByAccount(): AccountUsageTotals[] {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `${TOTALS_SELECT.replace(
          'SELECT',
          `SELECT provider,
             json_extract(metadata_json, '$.accountId') AS account_id,`,
        )}
         WHERE event_type = ?
           AND json_extract(metadata_json, '$.accountId') IS NOT NULL
         GROUP BY provider, account_id
         ORDER BY account_id ASC, provider ASC`,
      )
      .all(TOKEN_EVENT_TYPE) as Array<
        TotalsRow & { account_id: unknown; provider: unknown }
      >;
    return rows.map((row) => ({
      accountId: entityIdSchema.parse(row.account_id),
      provider: usageProviderSchema.parse(row.provider),
      ...toTotals(row),
    }));
  }

  /** A provider session is account-bound; ambiguity fails closed. */
  accountIdForProviderSession(
    rawProvider: UsageProvider,
    rawSessionId: string,
  ): string | null {
    const provider = usageProviderSchema.parse(rawProvider);
    const sessionId = z.string().min(1).max(512).parse(rawSessionId);
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT DISTINCT json_extract(metadata_json, '$.accountId') AS account_id
         FROM usage_events
         WHERE event_type = ?
           AND provider = ?
           AND json_extract(metadata_json, '$.sessionId') = ?
           AND json_extract(metadata_json, '$.accountId') IS NOT NULL
         LIMIT 2`,
      )
      .all(TOKEN_EVENT_TYPE, provider, sessionId) as Array<{
        account_id: unknown;
      }>;
    if (rows.length !== 1) return null;
    return entityIdSchema.parse(rows[0].account_id);
  }

  latestProviderSessionByPane(
    rawPaneId: string,
  ): CapturedProviderSession | null {
    const paneId = entityIdSchema.parse(rawPaneId);
    const row = this.#binding
      .readDatabase()
      .prepare(
        `SELECT provider, metadata_json, occurred_at
         FROM usage_events
         LEFT JOIN mission_panes mp ON mp.id = usage_events.pane_id
         WHERE usage_events.event_type = ?
           AND COALESCE(
             mp.pane_id,
             json_extract(usage_events.metadata_json, '$.displayPaneId')
           ) = ?
         ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
         LIMIT 1`,
      )
      .get(TOKEN_EVENT_TYPE, paneId) as
      | { provider: unknown; metadata_json: unknown; occurred_at: unknown }
      | undefined;
    if (!row) return null;
    try {
      const metadata = sessionMetadataSchema.parse(
        JSON.parse(z.string().parse(row.metadata_json)),
      );
      return {
        provider: usageProviderSchema.parse(row.provider),
        sessionId: metadata.sessionId,
        ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
        capturedAt: z.number().int().nonnegative().safe().parse(row.occurred_at),
      };
    } catch (error) {
      throw new ScopedStoreCorruptionError('provider session usage', {
        cause: error,
      });
    }
  }

  hasProviderSession(
    rawProvider: UsageProvider,
    rawSessionId: string,
  ): boolean {
    const provider = usageProviderSchema.parse(rawProvider);
    const sessionId = z.string().min(1).max(512).parse(rawSessionId);
    const row = this.#binding
      .readDatabase()
      .prepare(
        `SELECT 1 AS found FROM usage_events
         WHERE event_type = ? AND provider = ?
           AND json_extract(metadata_json, '$.sessionId') = ?
         LIMIT 1`,
      )
      .get(TOKEN_EVENT_TYPE, provider, sessionId) as
      | { found?: unknown }
      | undefined;
    return row?.found === 1;
  }

  /**
   * Resolves one unambiguous physical authority for a historical Codex
   * session. A session spanning multiple panes/roots is not resumable from
   * telemetry alone.
   */
  codexSessionAuthority(
    rawSessionId: string,
  ): CodexSessionAuthority | null {
    const sessionId = z.string().min(1).max(512).parse(rawSessionId);
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT DISTINCT
           COALESCE(
             mission_panes.pane_id,
             json_extract(usage_events.metadata_json, '$.displayPaneId')
           ) AS display_pane_id,
           mission_panes.scope_json
         FROM usage_events
         LEFT JOIN mission_panes
           ON mission_panes.id = usage_events.pane_id
         WHERE usage_events.event_type = ?
           AND usage_events.provider = 'codex'
           AND json_extract(usage_events.metadata_json, '$.sessionId') = ?
           AND (
             usage_events.pane_id IS NULL OR
             mission_panes.adapter_id = 'codex'
           )
         LIMIT 2`,
      )
      .all(TOKEN_EVENT_TYPE, sessionId) as Array<{
        display_pane_id: unknown;
        scope_json: unknown;
      }>;
    if (rows.length !== 1) return null;
    try {
      const paneId = nullableEntityIdSchema.parse(
        rows[0].display_pane_id,
      ) ?? null;
      if (rows[0].scope_json === null) {
        return { paneId: null, executionRoot: this.scope.rootRealPath };
      }
      const paneScope = persistedPaneExecutionScopeSchema.parse(
        JSON.parse(z.string().parse(rows[0].scope_json)),
      );
      return {
        paneId,
        executionRoot: paneScope.executionScope.rootRealPath,
      };
    } catch (error) {
      throw new ScopedStoreCorruptionError(
        'Codex provider session authority',
        { cause: error },
      );
    }
  }

  #resolvePaneOwnership(
    db: Database.Database,
    paneId: string | null,
    claimedMissionId: string | null,
  ): PaneOwnership {
    if (!paneId) {
      return { internalPaneId: null, missionId: claimedMissionId };
    }
    const rows = db
      .prepare(
        `SELECT id, mission_id FROM mission_panes
         WHERE pane_id = ? ORDER BY created_at DESC LIMIT 2`,
      )
      .all(paneId) as Array<{ id: unknown; mission_id: unknown }>;
    if (rows.length > 1) {
      throw new ScopedStoreCorruptionError('usage pane ownership');
    }
    if (rows.length === 0) {
      if (claimedMissionId) {
        throw new Error('mission usage pane is not persisted in this scope');
      }
      return { internalPaneId: null, missionId: null };
    }
    const internalPaneId = entityIdSchema.parse(rows[0].id);
    const persistedMissionId = entityIdSchema.parse(rows[0].mission_id);
    if (claimedMissionId && claimedMissionId !== persistedMissionId) {
      throw new Error('usage mission does not own the attributed pane');
    }
    return { internalPaneId, missionId: persistedMissionId };
  }
}

export function createScopedUsageStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedUsageStore {
  return new ScopedUsageStore(runtimeManager, scope, options);
}

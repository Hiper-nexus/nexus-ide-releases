import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import { ScopedStoreCorruptionError } from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptAppend {
  role: TranscriptRole;
  text: string;
  final: boolean;
  audio_url?: string | null;
}

export interface TranscriptRecord extends TranscriptAppend {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly ts: string;
  readonly audio_url: string | null;
  readonly projectId: string;
  readonly checkoutId: string;
}

export interface TranscriptStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
  maxTextChars?: number;
  retentionDays?: number;
}

const DEFAULT_MAX_TEXT_CHARS = 4_000;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_INPUT_TEXT_CHARS = 1_048_576;

const sessionIdSchema = z.string().min(1).max(256);
const transcriptAppendSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MAX_INPUT_TEXT_CHARS),
    final: z.boolean(),
    audio_url: z.string().max(4_096).nullable().optional(),
  })
  .strict();
const transcriptRowSchema = z
  .object({
    id: z.string().min(1).max(256),
    session_id: sessionIdSchema,
    sequence: z.number().int().positive(),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(DEFAULT_MAX_TEXT_CHARS),
    audio_url: z.string().max(4_096).nullable(),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

function immutableScope(scope: ProjectExecutionScope): ProjectExecutionScope {
  return Object.freeze(projectExecutionScopeSchema.parse({ ...scope }));
}

function validateOptions(options: TranscriptStoreOptions): {
  now: () => Date;
  idFactory: () => string;
  maxTextChars: number;
  retentionDays: number;
} {
  return {
    now: options.now ?? (() => new Date()),
    idFactory: options.idFactory ?? (() => `voice-transcript-${randomUUID()}`),
    maxTextChars: z
      .number()
      .int()
      .positive()
      .max(DEFAULT_MAX_TEXT_CHARS)
      .parse(options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS),
    retentionDays: z
      .number()
      .int()
      .nonnegative()
      .max(3_650)
      .parse(options.retentionDays ?? DEFAULT_RETENTION_DAYS),
  };
}

/**
 * Append-only voice transcript bound to one immutable project/checkout.
 * Session ids order rows inside that physical runtime but never select it.
 */
export class TranscriptStore {
  readonly scope: ProjectExecutionScope;
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #maxTextChars: number;
  readonly #retentionDays: number;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: TranscriptStoreOptions = {},
  ) {
    const validated = validateOptions(options);
    this.#runtimeManager = runtimeManager;
    this.scope = immutableScope(scope);
    this.#now = validated.now;
    this.#idFactory = validated.idFactory;
    this.#maxTextChars = validated.maxTextChars;
    this.#retentionDays = validated.retentionDays;
  }

  append(
    rawSessionId: string,
    rawLine: TranscriptAppend,
  ): TranscriptRecord | null {
    const sessionId = sessionIdSchema.parse(rawSessionId);
    const line = transcriptAppendSchema.parse(rawLine);
    if (!line.final) return null;
    const now = this.#validNow();
    const id = z.string().min(1).max(256).parse(this.#idFactory());
    const db = this.#runtimeManager.open(this.scope);
    db.assertWritable();

    return db.db
      .transaction(() => {
        this.#pruneExpired(db.db, now);
        const row = db.db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
             FROM voice_transcript_entries WHERE session_id = ?`,
          )
          .get(sessionId) as { next_sequence?: unknown } | undefined;
        const sequence = z.number().int().positive().parse(row?.next_sequence);
        const text = line.text.slice(0, this.#maxTextChars);
        db.db
          .prepare(
            `INSERT INTO voice_transcript_entries
               (id, session_id, sequence, role, text, audio_url, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            sessionId,
            sequence,
            line.role,
            text,
            line.audio_url ?? null,
            now.getTime(),
          );
        return this.#record({
          id,
          session_id: sessionId,
          sequence,
          role: line.role,
          text,
          audio_url: line.audio_url ?? null,
          created_at: now.getTime(),
        });
      })
      .immediate();
  }

  list(rawSessionId: string): TranscriptRecord[] {
    const sessionId = sessionIdSchema.parse(rawSessionId);
    const rows = this.#runtimeManager
      .open(this.scope)
      .db.prepare(
        `SELECT id, session_id, sequence, role, text, audio_url, created_at
         FROM voice_transcript_entries
         WHERE session_id = ?
         ORDER BY sequence ASC`,
      )
      .all(sessionId);
    return rows.map((row) => this.#record(row));
  }

  #validNow(): Date {
    const now = this.#now();
    if (
      !(now instanceof Date) ||
      !Number.isSafeInteger(now.getTime()) ||
      now.getTime() < 0
    ) {
      throw new Error('transcript store clock returned an invalid date');
    }
    return new Date(now.getTime());
  }

  #pruneExpired(
    db: Database.Database,
    now: Date,
  ): void {
    if (this.#retentionDays <= 0) return;
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - this.#retentionDays);
    db.prepare('DELETE FROM voice_transcript_entries WHERE created_at < ?').run(
      cutoff.getTime(),
    );
  }

  #record(rawRow: unknown): TranscriptRecord {
    let row: z.infer<typeof transcriptRowSchema>;
    try {
      row = transcriptRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('voice transcript', {
        cause: error,
      });
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      ts: new Date(row.created_at).toISOString(),
      role: row.role,
      text: row.text,
      audio_url: row.audio_url,
      final: true,
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
    };
  }
}

export function createScopedTranscriptStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: TranscriptStoreOptions = {},
): TranscriptStore {
  return new TranscriptStore(runtimeManager, scope, options);
}

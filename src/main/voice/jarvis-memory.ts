import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

/**
 * Project knowledge remembered by JARVIS. User-wide voice preferences remain
 * in voice-config-store (persona/userName/customInstructions); facts here are
 * always bound to one project checkout and live in `memory_entries`.
 */

export interface JarvisFact {
  content: string;
  updatedAt: number;
  deleted?: boolean;
  history: Array<{ content: string; at: number }>;
}

export interface JarvisMemoryAccess {
  remember(key: string, content: string): void;
  forget(key: string): boolean;
  list(): Array<{ key: string; content: string; updatedAt: number }>;
  factsBlock(maxChars?: number): string;
}

const HISTORY_CAP = 10;
const MAX_FACTS = 200;
const FACT_KIND = 'jarvis-project-fact';
const FACT_ID_PREFIX = 'jarvis-fact:';
const MAX_FACT_CHARS = 16_384;
export const FACTS_BLOCK_MAX_CHARS = 700;

const historySchema = z
  .array(
    z
      .object({
        content: z.string().max(MAX_FACT_CHARS),
        at: z.number().int().nonnegative().safe(),
      })
      .strict(),
  )
  .max(HISTORY_CAP);
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().min(1).max(48),
    deleted: z.boolean(),
    history: historySchema,
  })
  .strict();
const rowSchema = z
  .object({
    id: z.string().min(1).max(256),
    content: z.string().max(MAX_FACT_CHARS),
    metadata_json: z.string(),
    created_at: z.number().int().nonnegative().safe(),
    updated_at: z.number().int().nonnegative().safe(),
  })
  .strict();

interface FactRow {
  id: string;
  key: string;
  content: string;
  deleted: boolean;
  history: Array<{ content: string; at: number }>;
  createdAt: number;
  updatedAt: number;
}

/** Stable lowercase ASCII key used as the project-local fact identity. */
export function slugifyMemoryKey(key: string): string {
  return key
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function parseRow(raw: unknown): FactRow {
  try {
    const row = rowSchema.parse(raw);
    const metadata = metadataSchema.parse(JSON.parse(row.metadata_json));
    if (row.id !== `${FACT_ID_PREFIX}${metadata.key}`) {
      throw new Error('fact id/key mismatch');
    }
    return {
      id: row.id,
      key: metadata.key,
      content: row.content,
      deleted: metadata.deleted,
      history: metadata.history.map((item) => ({ ...item })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    throw new ScopedStoreCorruptionError('JARVIS project fact', {
      cause: error,
    });
  }
}

function metadataFor(row: Pick<FactRow, 'key' | 'deleted' | 'history'>): string {
  return JSON.stringify(
    metadataSchema.parse({
      schemaVersion: 1,
      key: row.key,
      deleted: row.deleted,
      history: row.history,
    }),
  );
}

export class ScopedJarvisMemory implements JarvisMemoryAccess {
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

  remember(rawKey: string, rawContent: string): void {
    const content = rawContent.trim();
    if (!content) return;
    if (content.length > MAX_FACT_CHARS) {
      throw new Error('JARVIS fact is too large');
    }
    let key = slugifyMemoryKey(rawKey);
    if (!key) key = slugifyMemoryKey(content).slice(0, 32);
    if (!key) return;
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const changed = db.transaction(() => {
      const existing = this.#getFromDatabase(db, key);
      if (existing && !existing.deleted && existing.content === content) {
        return false;
      }
      if (existing) {
        const history = [
          ...existing.history,
          { content: existing.content, at: existing.updatedAt },
        ].slice(-HISTORY_CAP);
        const result = db.prepare(
          `UPDATE memory_entries
           SET content = ?, metadata_json = ?, updated_at = ?
           WHERE id = ? AND kind = ?`,
        ).run(
          content,
          metadataFor({ key, deleted: false, history }),
          now,
          existing.id,
          FACT_KIND,
        );
        if (result.changes !== 1) {
          throw new ScopedStoreCorruptionError('JARVIS project fact update');
        }
      } else {
        db.prepare(
          `INSERT INTO memory_entries
             (id, mission_id, kind, content, source_uri, metadata_json,
              created_at, updated_at)
           VALUES (?, NULL, ?, ?, NULL, ?, ?, ?)`,
        ).run(
          `${FACT_ID_PREFIX}${key}`,
          FACT_KIND,
          content,
          metadataFor({ key, deleted: false, history: [] }),
          now,
          now,
        );
      }
      this.#evictIfNeeded(db);
      return true;
    })();
    if (changed) this.#binding.emitChange();
  }

  forget(rawKey: string): boolean {
    const key = slugifyMemoryKey(rawKey);
    if (!key) return false;
    const db = this.#binding.writeDatabase();
    const existing = this.#getFromDatabase(db, key);
    if (!existing || existing.deleted) return false;
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET metadata_json = ?, updated_at = ?
         WHERE id = ? AND kind = ?`,
      )
      .run(
        metadataFor({
          key,
          deleted: true,
          history: existing.history,
        }),
        this.#binding.now(),
        existing.id,
        FACT_KIND,
      );
    if (result.changes !== 1) {
      throw new ScopedStoreCorruptionError('JARVIS project fact delete');
    }
    this.#binding.emitChange();
    return true;
  }

  list(): Array<{ key: string; content: string; updatedAt: number }> {
    return this.#listAll(this.#binding.readDatabase())
      .filter((fact) => !fact.deleted)
      .map(({ key, content, updatedAt }) => ({ key, content, updatedAt }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  factsBlock(maxChars: number = FACTS_BLOCK_MAX_CHARS): string {
    if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 32_768) {
      throw new Error('invalid JARVIS facts block size');
    }
    const lines: string[] = [];
    let used = 0;
    for (const fact of this.list()) {
      const line = `- ${fact.key}: ${fact.content}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  #getFromDatabase(db: import('better-sqlite3').Database, key: string): FactRow | null {
    const raw = db
      .prepare(
        `SELECT id, content, metadata_json, created_at, updated_at
         FROM memory_entries WHERE id = ? AND kind = ?`,
      )
      .get(`${FACT_ID_PREFIX}${key}`, FACT_KIND);
    return raw === undefined ? null : parseRow(raw);
  }

  #listAll(db: import('better-sqlite3').Database): FactRow[] {
    return db
      .prepare(
        `SELECT id, content, metadata_json, created_at, updated_at
         FROM memory_entries WHERE kind = ?`,
      )
      .all(FACT_KIND)
      .map(parseRow);
  }

  #evictIfNeeded(db: import('better-sqlite3').Database): void {
    const facts = this.#listAll(db);
    if (facts.length <= MAX_FACTS) return;
    const byAge = [...facts].sort((left, right) => {
      if (left.deleted !== right.deleted) return left.deleted ? -1 : 1;
      return left.updatedAt - right.updatedAt;
    });
    const remove = byAge.slice(0, facts.length - MAX_FACTS);
    const statement = db.prepare(
      'DELETE FROM memory_entries WHERE id = ? AND kind = ?',
    );
    for (const fact of remove) statement.run(fact.id, FACT_KIND);
  }
}

export function createScopedJarvisMemory(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedJarvisMemory {
  return new ScopedJarvisMemory(runtimeManager, scope, options);
}

/** Safe default for non-project diagnostics/tests: it never retains data. */
export const EMPTY_JARVIS_MEMORY: JarvisMemoryAccess = Object.freeze({
  remember: () => undefined,
  forget: () => false,
  list: () => [],
  factsBlock: () => '',
});

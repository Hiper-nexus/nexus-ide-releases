import { z } from 'zod';
import type { JarvisTurn } from '../../shared/voice-ipc';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

/** Recent voice conversation, isolated to one project checkout. */

export const CONVERSATION_MAX_MESSAGES = 40;
// Long enough to survive an ordinary work session/restart without injecting a
// stale conversation on the next day. Durable facts use ScopedJarvisMemory.
export const RESUME_WINDOW_MS = 2 * 60 * 60_000;
export const RESUME_INJECT_MESSAGES = 6;

export interface JarvisConversationAccess {
  record(userText: string, assistantText: string): void;
  resume(): JarvisTurn[];
  clear(): void;
}

const CONVERSATION_ID = 'jarvis-conversation:recent';
const CONVERSATION_KIND = 'jarvis-project-conversation';
const MAX_TURN_CHARS = 16_384;
const turnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(MAX_TURN_CHARS),
  })
  .strict();
const turnsSchema = z.array(turnSchema).max(CONVERSATION_MAX_MESSAGES);
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
const rowSchema = z
  .object({
    content: z.string(),
    metadata_json: z.string(),
  })
  .strict();

interface ConversationState {
  turns: JarvisTurn[];
  updatedAt: number;
}

function parseState(raw: unknown): ConversationState {
  if (raw === undefined) return { turns: [], updatedAt: 0 };
  try {
    const row = rowSchema.parse(raw);
    const turns = turnsSchema.parse(JSON.parse(row.content));
    const metadata = metadataSchema.parse(JSON.parse(row.metadata_json));
    return {
      turns: turns.map((turn) => ({ ...turn })),
      updatedAt: metadata.updatedAt,
    };
  } catch (error) {
    throw new ScopedStoreCorruptionError('JARVIS project conversation', {
      cause: error,
    });
  }
}

export class ScopedJarvisConversation implements JarvisConversationAccess {
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

  record(rawUserText: string, rawAssistantText: string): void {
    const userText = rawUserText.trim();
    const assistantText = rawAssistantText.trim();
    if (!userText || !assistantText) return;
    const pair = turnsSchema.parse([
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    ]);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    db.transaction(() => {
      const state = this.#readFromDatabase(db);
      const turns = [...state.turns, ...pair].slice(
        -CONVERSATION_MAX_MESSAGES,
      );
      this.#writeToDatabase(db, { turns, updatedAt: now });
    })();
    this.#binding.emitChange();
  }

  resume(): JarvisTurn[] {
    const state = this.#readFromDatabase(this.#binding.readDatabase());
    if (state.turns.length === 0) return [];
    if (this.#binding.now() - state.updatedAt > RESUME_WINDOW_MS) return [];
    return state.turns
      .slice(-RESUME_INJECT_MESSAGES)
      .map((turn) => ({ ...turn }));
  }

  clear(): void {
    this.#writeToDatabase(this.#binding.writeDatabase(), {
      turns: [],
      updatedAt: this.#binding.now(),
    });
    this.#binding.emitChange();
  }

  #readFromDatabase(
    db: import('better-sqlite3').Database,
  ): ConversationState {
    return parseState(
      db
        .prepare(
          `SELECT content, metadata_json FROM memory_entries
           WHERE id = ? AND kind = ?`,
        )
        .get(CONVERSATION_ID, CONVERSATION_KIND),
    );
  }

  #writeToDatabase(
    db: import('better-sqlite3').Database,
    state: ConversationState,
  ): void {
    const turns = turnsSchema.parse(state.turns);
    const metadata = metadataSchema.parse({
      schemaVersion: 1,
      updatedAt: state.updatedAt,
    });
    const result = db.prepare(
      `INSERT INTO memory_entries
         (id, mission_id, kind, content, source_uri, metadata_json,
          created_at, updated_at)
       VALUES (?, NULL, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at
       WHERE memory_entries.kind = excluded.kind`,
    ).run(
      CONVERSATION_ID,
      CONVERSATION_KIND,
      JSON.stringify(turns),
      JSON.stringify(metadata),
      state.updatedAt,
      state.updatedAt,
    );
    if (result.changes !== 1) {
      throw new ScopedStoreCorruptionError(
        'JARVIS project conversation write',
      );
    }
  }
}

export function createScopedJarvisConversation(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedJarvisConversation {
  return new ScopedJarvisConversation(runtimeManager, scope, options);
}

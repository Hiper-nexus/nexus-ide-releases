// Derived from can1357/oh-my-pi@03c48d073 packages/mnemopi design (MIT)
//
// Porte enxuto FTS-only do design do mnemopi (schema "beam": episodic_memory
// com importance/scope/superseded_by/contadores de recall + FTS5 de conteúdo
// externo com triggers de sincronização; "banks" com escopo global/por
// projeto; fachada remember/recall/stats). Sem sidecar Bun, sem embeddings,
// sem LLM: roda sobre o better-sqlite3 que já é dependência do app.
//
// Um banco por workspace (projectId — checkouts/worktrees do mesmo projeto
// compartilham memória) + um banco global do usuário. O recall consulta o
// workspace primeiro e completa as vagas restantes com o banco global.
//
// PENDÊNCIA (C2): reflect() — consolidação/sumarização de memórias exige um
// LLM (equivalente ao consolidate do beam). Não implementado nesta entrega;
// quando existir, deve ler memórias ativas, gravar o resumo via retain() e
// marcar as origens com superseded_by.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ProjectExecutionScope } from '../../shared/types';
import { redactSecretText } from '../terminal/command-redaction';
import {
  projectionCounts,
  projectionSignature,
  projectionTitle,
  removeCanonicalMemoryProjection,
  resolveMemoryRoot,
  syncCanonicalMemoryProjections,
  writeCanonicalMemoryProjection,
  type CanonicalMemoryProjectionInput,
  type MemoryNote,
  type ProjectionCounts,
} from './nexus-memory';
import {
  collectProjectionEdits,
  type ProjectionEdit,
} from './nexus-memory-ingest';

export const MAX_MEMORY_CONTENT_BYTES = 8_192;

export const MEMORY_KINDS = ['fact', 'decision', 'preference', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SCOPES = ['workspace', 'global'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Sentinela de superseded_by para memórias esquecidas sem substituta. */
export const FORGOTTEN_SENTINEL = 'forgotten';

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
/** Pool de candidatos por banco antes do re-ranking em JS. */
const RECALL_CANDIDATE_POOL = 64;
const MAX_QUERY_TOKENS = 12;
/**
 * Provenance prefix of Nexus-verified events. These are the only memories the
 * automatic prompt recall injects (`trustedOnly`), so they are also the only
 * ones a file on disk may never author.
 */
const TRUSTED_SOURCE_PREFIX = 'trusted:';
/** Candidates offered when an id lookup misses. */
const NOT_FOUND_SUGGESTIONS = 3;
const SUGGESTION_TITLE_MAX = 60;

const EMPTY_PROJECTION_COUNTS: ProjectionCounts = Object.freeze({
  notes: 0,
  byKind: Object.freeze({
    decision: 0,
    mission: 0,
    agent: 0,
    note: 0,
  }) as Readonly<Record<MemoryNote['kind'], number>>,
  cached: true,
});

export interface RetainInput {
  readonly content: string;
  readonly kind?: MemoryKind;
  readonly importance?: number;
  readonly scope?: MemoryScope;
  readonly source?: string;
  /** Id de memória que esta substitui (marcada superseded_by = novo id). */
  readonly supersedes?: string;
}

export interface AgentAuthoredMemoryAuthority {
  /**
   * Main-derived opaque authority. Agent-controlled MCP arguments can never
   * select this value.
   */
  readonly source: string;
}

export interface ForgetAgentAuthoredInput extends AgentAuthoredMemoryAuthority {
  readonly id: string;
  readonly scope: MemoryScope;
}

export interface RetainResult {
  readonly id: string;
  readonly scope: MemoryScope;
  /** True quando o conteúdo já existia e apenas updated_at foi renovado. */
  readonly deduped: boolean;
  /** True quando a redação de segredos alterou o conteúdo persistido. */
  readonly redacted: boolean;
}

export interface RecallInput {
  readonly query: string;
  readonly limit?: number;
  readonly kind?: MemoryKind;
  /** Default true: completa as vagas restantes com o banco global. */
  readonly includeGlobal?: boolean;
  /** Internal safety filter used by automatic prompt recall. */
  readonly trustedOnly?: boolean;
}

export interface MemoryRecallHit {
  readonly id: string;
  readonly content: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly importance: number;
  readonly source: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Já reflete o incremento causado por este recall. */
  readonly recallCount: number;
  readonly score: number;
}

export interface MemoryBankStats {
  readonly total: number;
  readonly active: number;
  readonly byKind: Readonly<Record<MemoryKind, number>>;
  readonly totalRecalls: number;
}

export interface WorkspaceMemoryStats {
  readonly workspace: MemoryBankStats;
  readonly global: MemoryBankStats;
  /** Counts of the readable projection, served without a full re-read. */
  readonly projection: ProjectionCounts;
}

export interface WorkspaceMemoryStoreOptions {
  readonly workspaceDbPath: string;
  readonly globalDbPath: string;
  /** Nexus-owned root receiving the generated `.nexus-memory/*.md` view. */
  readonly projectionRoot?: string;
  readonly now?: () => number;
}

const retainInputSchema = z
  .object({
    content: z.string().min(1),
    kind: z.enum(MEMORY_KINDS).default('note'),
    importance: z.number().int().min(1).max(5).default(3),
    scope: z.enum(MEMORY_SCOPES).default('workspace'),
    source: z.string().min(1).max(256).optional(),
    supersedes: z.string().min(1).max(128).optional(),
  })
  .strict();

const agentAuthoredRetainInputSchema = retainInputSchema.omit({
  source: true,
});

const agentAuthoredSourceSchema = z
  .string()
  .regex(/^agent-authored:(?:mission|pane):[a-f0-9]{64}$/);

const agentAuthoredAuthoritySchema = z
  .object({
    source: agentAuthoredSourceSchema,
  })
  .strict();

const forgetAgentAuthoredInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    scope: z.enum(MEMORY_SCOPES),
    source: agentAuthoredSourceSchema,
  })
  .strict();

const recallInputSchema = z
  .object({
    query: z.string().min(1).max(1_024),
    limit: z.number().int().min(1).max(32).default(8),
    kind: z.enum(MEMORY_KINDS).optional(),
    includeGlobal: z.boolean().default(true),
    trustedOnly: z.boolean().default(false),
  })
  .strict();

const memoryRowSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(MEMORY_SCOPES),
  importance: z.number().int().min(1).max(5),
  source: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  recall_count: z.number().int().nonnegative(),
  rank: z.number(),
});

const projectionMemoryRowSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  kind: z.enum(MEMORY_KINDS),
  scope: z.literal('workspace'),
  importance: z.number().int().min(1).max(5),
  source: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});

// Schema derivado do beam do mnemopi, reduzido ao essencial FTS-only.
// memories_fts é FTS5 de conteúdo externo (content='memories') mantida em
// sincronia pelos triggers ai/ad/au — o mesmo padrão do fts_episodes do beam.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','note')),
  scope            TEXT NOT NULL CHECK (scope IN ('workspace','global')),
  importance       INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source           TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  superseded_by    TEXT,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash_active
  ON memories(content_hash) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_kind_active
  ON memories(kind) WHERE superseded_by IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

type DatabaseConstructor = new (
  filename: string,
  options?: Database.Options,
) => Database.Database;

function loadDatabaseConstructor(): DatabaseConstructor {
  // Require tardio: contém uma falha do binário nativo no primeiro uso da
  // memória em vez de derrubar o bootstrap (mesmo padrão de persistence/db.ts).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require('better-sqlite3') as
    | DatabaseConstructor
    | { default?: DatabaseConstructor };
  const Constructor = typeof loaded === 'function' ? loaded : loaded.default;
  if (typeof Constructor !== 'function') {
    throw new Error('better-sqlite3 did not export a database constructor');
  }
  return Constructor;
}

/** Hash de dedupe: NFC + minúsculas + espaços colapsados, então SHA-256. */
function contentHash(content: string): string {
  const normalized = content
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Converte a consulta livre em MATCH seguro do FTS5: só tokens alfanuméricos,
 * cada um entre aspas, unidos por OR. Documentos que casam mais termos sobem
 * naturalmente no bm25 (match "exato" > parcial). Retorna null sem tokens.
 */
function buildFtsMatch(query: string): string | null {
  const tokens: string[] = [];
  for (const match of query.matchAll(/[\p{L}\p{N}_]+/gu)) {
    tokens.push(match[0].slice(0, 64));
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

/**
 * Fórmula de ranking (documentada, deliberadamente simples):
 *   relevância = -bm25            (no FTS5, menor/negativo = melhor)
 *   recência   = 1 / (1 + idadeDias/30)   com idade desde updated_at
 *   score = relevância * (1 + 0.1*(importância-3))  — reforço multiplicativo
 *         + 0.05 * importância                      — desempate em empate de bm25
 *         + 0.25 * recência                         — memórias recentes sobem
 */
function scoreHit(
  rank: number,
  importance: number,
  updatedAt: number,
  now: number,
): number {
  const relevance = -rank;
  const ageDays = Math.max(0, now - updatedAt) / 86_400_000;
  const recency = 1 / (1 + ageDays / 30);
  return (
    relevance * (1 + 0.1 * (importance - 3)) + 0.05 * importance + 0.25 * recency
  );
}

function ensureDatabaseDirectory(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: DIRECTORY_MODE });
}

function redactMemoryContent(content: string): {
  readonly content: string;
  readonly redacted: boolean;
} {
  const result = redactSecretText(content.slice(0, MAX_MEMORY_CONTENT_BYTES));
  return { content: result.text, redacted: result.redacted };
}

/**
 * `source` is projected verbatim into the readable frontmatter, so it needs the
 * same scrubbing as the body — a provenance string can carry a token
 * (`curl:https://u:ghp_…@api`) just as easily as the content can.
 */
function redactMemorySource(source: string | null | undefined): string | null {
  if (!source) return null;
  const scrubbed = redactSecretText(source).text.replaceAll('\n', ' ').trim();
  return scrubbed.length > 0 ? scrubbed : null;
}

/**
 * Memória agentic durável de um workspace: banco SQLite do workspace + banco
 * global do usuário, ambos com o mesmo schema. Compartilhada por todas as
 * CLIs hospedadas via tools nexus_memory_* (src/main/orch/tools-memory.ts).
 */
export class WorkspaceMemoryStore {
  readonly #workspaceDb: Database.Database;
  readonly #globalDb: Database.Database;
  readonly #now: () => number;
  readonly #projectionRoots = new Set<string>();
  readonly #unsyncedProjectionRoots = new Set<string>();
  readonly #projectionSignatures = new Map<string, string>();
  #closed = false;

  constructor(options: WorkspaceMemoryStoreOptions) {
    if (path.resolve(options.workspaceDbPath) === path.resolve(options.globalDbPath)) {
      throw new Error('workspace and global memory databases must be distinct files');
    }
    this.#now = options.now ?? Date.now;
    const Constructor = loadDatabaseConstructor();
    this.#workspaceDb = this.#openDatabase(Constructor, options.workspaceDbPath);
    try {
      this.#globalDb = this.#openDatabase(Constructor, options.globalDbPath);
    } catch (error) {
      this.#workspaceDb.close();
      throw error;
    }
    if (options.projectionRoot) {
      this.#registerProjectionRootBestEffort(options.projectionRoot);
    }
  }

  #openDatabase(
    Constructor: DatabaseConstructor,
    dbPath: string,
  ): Database.Database {
    ensureDatabaseDirectory(dbPath);
    const db = new Constructor(dbPath, { timeout: 5_000 });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
      db.exec(SCHEMA);
      fs.chmodSync(dbPath, DATABASE_MODE);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #dbFor(scope: MemoryScope): Database.Database {
    return scope === 'global' ? this.#globalDb : this.#workspaceDb;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('workspace memory store is closed');
  }

  /**
   * Registers the Nexus-owned generated view for this projectId. Runtime
   * resolution never supplies a project checkout here; workspace export is a
   * one-shot operation handled separately.
   */
  #registerProjectionRoot(projectRoot: string): void {
    this.#assertOpen();
    if (!path.isAbsolute(projectRoot)) {
      throw new Error('memory projection root must be absolute');
    }
    const resolved = fs.realpathSync(projectRoot);
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('memory projection root must be a directory');
    }
    if (this.#projectionRoots.has(resolved)) return;
    this.#projectionRoots.add(resolved);
    this.#unsyncedProjectionRoots.add(resolved);
  }

  #registerProjectionRootBestEffort(projectRoot: string): void {
    try {
      this.#registerProjectionRoot(projectRoot);
    } catch (error) {
      console.warn(
        `[memory] could not register generated projection for ${path.basename(projectRoot)}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  get projectionRoot(): string {
    const root = this.#projectionRoots.values().next().value as
      | string
      | undefined;
    if (!root) throw new Error('workspace memory projection root unavailable');
    return root;
  }

  /**
   * Reconciles every registered generated view with the SQLite authority in
   * both directions: operator edits are ingested first, then the view is
   * rewritten from the (possibly updated) rows.
   */
  syncProjections(): void {
    this.#assertOpen();
    for (const root of this.#projectionRoots) {
      if (this.#syncProjectionRootBestEffort(root)) {
        this.#unsyncedProjectionRoots.delete(root);
      }
    }
  }

  /**
   * Read-path reconciliation. A full pass only runs when the directory
   * signature moved (one readdir plus an lstat per file), so the common case —
   * nothing touched the projection since the last pass — stays O(dir) instead
   * of re-reading and re-parsing every note on every keystroke.
   */
  ensureProjections(): void {
    this.#assertOpen();
    for (const root of this.#projectionRoots) {
      if (
        !this.#unsyncedProjectionRoots.has(root) &&
        this.#projectionSignatures.get(root) === projectionSignature(root)
      ) {
        continue;
      }
      if (this.#syncProjectionRootBestEffort(root)) {
        this.#unsyncedProjectionRoots.delete(root);
      }
    }
  }

  /**
   * Explicit export only. The workspace is not registered as a live target,
   * so later retention continues writing exclusively to Nexus userData.
   *
   * This is also why markdown-as-input does not turn `.nexus-memory/` inside a
   * checkout into a write port for every agent holding a shell: ingestion runs
   * only over *registered* roots, and a checkout is never registered. The copy
   * exported here stays a one-shot dead view.
   */
  exportProjectionsToWorkspace(projectRoot: string): string {
    this.#assertOpen();
    syncCanonicalMemoryProjections(
      projectRoot,
      this.#activeProjectionRecords(),
    );
    return resolveMemoryRoot(projectRoot);
  }

  #activeProjectionRecords(): CanonicalMemoryProjectionInput[] {
    return this.#workspaceDb
      .prepare(
        `SELECT id, content, kind, scope, importance, source,
                created_at, updated_at
         FROM memories
         WHERE scope = 'workspace' AND superseded_by IS NULL
         ORDER BY created_at, id`,
      )
      .all()
      .map((raw) => this.#toProjectionInput(raw));
  }

  #toProjectionInput(raw: unknown): CanonicalMemoryProjectionInput {
    const row = projectionMemoryRowSchema.parse(raw);
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      scope: row.scope,
      importance: row.importance,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #projectionRecord(id: string): CanonicalMemoryProjectionInput | null {
    const raw = this.#workspaceDb
      .prepare(
        `SELECT id, content, kind, scope, importance, source,
                created_at, updated_at
         FROM memories
         WHERE id = ? AND scope = 'workspace' AND superseded_by IS NULL`,
      )
      .get(id);
    return raw ? this.#toProjectionInput(raw) : null;
  }

  #syncProjectionRootBestEffort(root: string): boolean {
    try {
      // Ingest before writing: an operator edit that lands in SQLite must be
      // reflected by the very same pass, or the write below would erase it.
      this.#ingestProjectionEdits(root);
      syncCanonicalMemoryProjections(root, this.#activeProjectionRecords());
      this.#markProjectionSynced(root);
      return true;
    } catch (error) {
      console.warn(
        `[memory] could not sync generated projection for ${path.basename(root)}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Applies the operator edits found on disk. Everything a file may assert is
   * bounded here: only the body of an already-active workspace row, only when
   * the row has not moved since that file was rendered, never a trusted row,
   * and always through the same secret redaction `retain()` uses.
   */
  #ingestProjectionEdits(root: string): number {
    const edits = collectProjectionEdits(root, this.#activeProjectionRecords());
    let applied = 0;
    for (const edit of edits) {
      try {
        if (this.#applyProjectionEdit(edit)) applied += 1;
      } catch (error) {
        console.warn(
          `[memory] could not ingest edited projection ${edit.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return applied;
  }

  #applyProjectionEdit(edit: ProjectionEdit): boolean {
    const db = this.#workspaceDb;
    const row = db
      .prepare(
        `SELECT id, content, source, updated_at
         FROM memories
         WHERE id = ? AND scope = 'workspace' AND superseded_by IS NULL`,
      )
      .get(edit.id) as
      | {
          id: string;
          content: string;
          source: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row || row.updated_at !== edit.baseUpdatedAt) return false;
    if (row.source?.startsWith(TRUSTED_SOURCE_PREFIX)) {
      console.warn(
        `[memory] refused disk edit of trusted memory ${edit.id}; projection repaired`,
      );
      return false;
    }
    if (Buffer.byteLength(edit.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES) {
      console.warn(
        `[memory] refused disk edit of ${edit.id}: exceeds ${MAX_MEMORY_CONTENT_BYTES} bytes`,
      );
      return false;
    }
    const scrubbed = redactMemoryContent(edit.content);
    const content = scrubbed.content.trim();
    if (content.length === 0 || content === row.content) return false;
    const hash = contentHash(content);
    const now = this.#now();

    const applied = db.transaction((): boolean => {
      const clash = db
        .prepare(
          'SELECT id FROM memories WHERE content_hash = ? AND superseded_by IS NULL',
        )
        .get(hash) as { id: string } | undefined;
      if (clash && clash.id !== row.id) {
        console.warn(
          `[memory] refused disk edit of ${edit.id}: duplicates active memory ${clash.id}`,
        );
        return false;
      }
      const result = db
        .prepare(
          `UPDATE memories
           SET content = ?, content_hash = ?, updated_at = ?
           WHERE id = ? AND updated_at = ? AND superseded_by IS NULL`,
        )
        .run(content, hash, now, row.id, edit.baseUpdatedAt);
      return result.changes > 0;
    })();

    if (applied) {
      // The only audit trail a filesystem edit can leave: provenance stays
      // whatever the bank already recorded, so the log is where a body that
      // changed without passing through retain() becomes visible.
      console.info(
        `[memory] ingested disk edit of ${edit.id}` +
          (scrubbed.redacted ? ' (secret redacted)' : ''),
      );
    }
    return applied;
  }

  #markProjectionSynced(root: string): void {
    try {
      this.#projectionSignatures.set(root, projectionSignature(root));
    } catch {
      this.#projectionSignatures.delete(root);
    }
  }

  #writeProjectionBestEffort(id: string): void {
    try {
      const record = this.#projectionRecord(id);
      if (!record) return;
      for (const root of this.#projectionRoots) {
        writeCanonicalMemoryProjection(root, record);
        this.#markProjectionSynced(root);
      }
    } catch (error) {
      console.warn(
        `[memory] could not update generated projection ${id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  #removeProjectionBestEffort(id: string): void {
    for (const root of this.#projectionRoots) {
      try {
        removeCanonicalMemoryProjection(root, id);
        this.#markProjectionSynced(root);
      } catch (error) {
        console.warn(
          `[memory] could not remove generated projection ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /**
   * Persiste (ou renova) uma memória. Conteúdo passa por redação de segredos
   * (mesmo helper do histórico de terminal) antes de tocar o disco; retain de
   * conteúdo idêntico (hash normalizado) só renova updated_at.
   */
  retain(rawInput: RetainInput): RetainResult {
    this.#assertOpen();
    const input = retainInputSchema.parse(rawInput);
    if (Buffer.byteLength(input.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES) {
      throw new Error(
        `memory content exceeds ${MAX_MEMORY_CONTENT_BYTES} bytes`,
      );
    }
    // Redação fail-safe: nunca descarta a memória inteira (denylist vazia),
    // apenas mascara tokens com cara de segredo — padrão do nexus-memory.
    const scrubbed = redactMemoryContent(input.content);
    const content = scrubbed.content.trim();
    if (content.length === 0) {
      throw new Error('memory content is empty after sanitization');
    }
    const hash = contentHash(content);
    const db = this.#dbFor(input.scope);
    const now = this.#now();

    const transactionResult = db.transaction((): {
      readonly result: RetainResult;
      readonly superseded: boolean;
    } => {
      const existing = db
        .prepare(
          'SELECT id FROM memories WHERE content_hash = ? AND superseded_by IS NULL',
        )
        .get(hash) as { id: string } | undefined;
      let id: string;
      let deduped: boolean;
      if (existing) {
        db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(
          now,
          existing.id,
        );
        id = existing.id;
        deduped = true;
      } else {
        id = `mem-${randomUUID()}`;
        db.prepare(
          `INSERT INTO memories (
             id, content, content_hash, kind, scope, importance, source,
             created_at, updated_at, superseded_by, recall_count, last_recalled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
        ).run(
          id,
          content,
          hash,
          input.kind,
          input.scope,
          input.importance,
          redactMemorySource(input.source),
          now,
          now,
        );
        deduped = false;
      }
      const superseded =
        Boolean(input.supersedes) &&
        input.supersedes !== id &&
        this.#markSupersededInScope(
          input.scope,
          input.supersedes!,
          id,
          now,
        );
      return Object.freeze({
        result: Object.freeze({
          id,
          scope: input.scope,
          deduped,
          redacted: scrubbed.redacted,
        }),
        superseded,
      });
    })();
    const result = transactionResult.result;
    if (result.scope === 'workspace') {
      this.#writeProjectionBestEffort(result.id);
    }
    if (
      transactionResult.superseded &&
      input.scope === 'workspace' &&
      input.supersedes
    ) {
      this.#removeProjectionBestEffort(input.supersedes);
    }
    return result;
  }

  /**
   * Agent-facing retention boundary. A worker may only replace an active
   * candidate authored by the same Main-derived physical authority in the
   * same memory bank. Trusted and foreign-origin rows remain immutable.
   */
  retainAgentAuthored(
    rawInput: Omit<RetainInput, 'source'>,
    rawAuthority: AgentAuthoredMemoryAuthority,
  ): RetainResult {
    this.#assertOpen();
    const input = agentAuthoredRetainInputSchema.parse(rawInput);
    const authority = agentAuthoredAuthoritySchema.parse(rawAuthority);
    if (input.supersedes) {
      const db = this.#dbFor(input.scope);
      const target = this.#activeMemoryIdentity(db, input.supersedes);
      if (
        !target ||
        target.scope !== input.scope ||
        target.source !== authority.source
      ) {
        // One message for every denial reason on purpose: telling "no such id"
        // apart from "exists but is not yours" would hand a worker an oracle
        // over the other banks. What it *can* learn is what it already owns.
        throw new Error(
          this.#supersedeDeniedMessage(db, input.supersedes, {
            source: authority.source,
            scope: input.scope,
          }),
        );
      }

      // Prevent a same-authority target from being replaced by a deduplicated
      // row owned by trusted/foreign provenance.
      const scrubbed = redactMemoryContent(input.content);
      const replacement = db
        .prepare(
          `SELECT id, source, scope
           FROM memories
           WHERE content_hash = ? AND superseded_by IS NULL`,
        )
        .get(contentHash(scrubbed.content.trim())) as
        | { id: string; source: string | null; scope: MemoryScope }
        | undefined;
      if (
        replacement &&
        replacement.id !== target.id &&
        replacement.source !== authority.source
      ) {
        throw new Error(
          'memory replacement requires the same agent authority and scope',
        );
      }
    }
    return this.retain({
      ...input,
      source: authority.source,
    });
  }

  /**
   * Busca FTS5 (MATCH + bm25) com re-ranking por importância e recência.
   * Consulta o banco do workspace primeiro; com includeGlobal (default),
   * completa as vagas restantes com o banco global. Incrementa recall_count
   * e last_recalled_at das memórias retornadas.
   */
  recall(rawInput: RecallInput): MemoryRecallHit[] {
    this.#assertOpen();
    const input = recallInputSchema.parse(rawInput);
    const match = buildFtsMatch(input.query);
    if (!match) return [];
    const hits = this.#recallFrom(
      this.#workspaceDb,
      match,
      input.kind,
      input.limit,
      input.trustedOnly,
    );
    if (input.includeGlobal && hits.length < input.limit) {
      hits.push(
        ...this.#recallFrom(
          this.#globalDb,
          match,
          input.kind,
          input.limit - hits.length,
          input.trustedOnly,
        ),
      );
    }
    return hits;
  }

  #recallFrom(
    db: Database.Database,
    match: string,
    kind: MemoryKind | undefined,
    limit: number,
    trustedOnly: boolean,
  ): MemoryRecallHit[] {
    const now = this.#now();
    const kindFilter = kind ? 'AND m.kind = ?' : '';
    const trustedFilter = trustedOnly
      ? "AND m.source LIKE 'trusted:%'"
      : '';
    const params: Array<string | number> = kind
      ? [match, kind, RECALL_CANDIDATE_POOL]
      : [match, RECALL_CANDIDATE_POOL];
    const rawRows = db
      .prepare(
        `SELECT m.id, m.content, m.kind, m.scope, m.importance, m.source,
                m.created_at, m.updated_at, m.recall_count,
                bm25(memories_fts) AS rank
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND m.superseded_by IS NULL
           ${kindFilter}
           ${trustedFilter}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params);
    const rows = rawRows.map((raw) => memoryRowSchema.parse(raw));
    const scored = rows
      .map((row) => ({
        row,
        score: scoreHit(row.rank, row.importance, row.updated_at, now),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.updated_at - a.row.updated_at ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, limit);
    const bump = db.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
    );
    const hits = db.transaction((): MemoryRecallHit[] =>
      scored.map(({ row, score }) => {
        bump.run(now, row.id);
        return Object.freeze({
          id: row.id,
          content: row.content,
          kind: row.kind,
          scope: row.scope,
          importance: row.importance,
          source: row.source,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          recallCount: row.recall_count + 1,
          score,
        });
      }),
    )();
    return hits;
  }

  /**
   * Esquece uma memória marcando superseded_by (tombstone 'forgotten') — o
   * registro sai do recall mas permanece auditável no banco.
   */
  forget(rawId: string): boolean {
    this.#assertOpen();
    const id = z.string().min(1).max(128).parse(rawId);
    const forgotten = this.#markSuperseded(
      id,
      FORGOTTEN_SENTINEL,
      this.#now(),
    );
    if (forgotten) this.#removeProjectionBestEffort(id);
    return forgotten;
  }

  /**
   * Narrow future-proof boundary for any agent-facing forget operation.
   * Operator IPC continues to use forget(), while MCP code must use this
   * provenance-checked variant.
   */
  forgetAgentAuthored(rawInput: ForgetAgentAuthoredInput): boolean {
    this.#assertOpen();
    const input = forgetAgentAuthoredInputSchema.parse(rawInput);
    const db = this.#dbFor(input.scope);
    const result = db
      .prepare(
        `UPDATE memories
         SET superseded_by = ?, updated_at = ?
         WHERE id = ? AND scope = ? AND source = ?
           AND source LIKE 'agent-authored:%'
           AND superseded_by IS NULL`,
      )
      .run(
        FORGOTTEN_SENTINEL,
        this.#now(),
        input.id,
        input.scope,
        // Must match the scrubbed value persisted by retain(), not the raw one.
        redactMemorySource(input.source),
      );
    const forgotten = result.changes > 0;
    if (forgotten && input.scope === 'workspace') {
      this.#removeProjectionBestEffort(input.id);
    }
    return forgotten;
  }

  /**
   * A denial that is actionable: it names up to three memories the caller can
   * actually supersede. Candidates are restricted to the asking authority's
   * own active rows, so the hint never enumerates what other panes retained.
   */
  #supersedeDeniedMessage(
    db: Database.Database,
    id: string,
    owner: { readonly source: string; readonly scope: MemoryScope },
  ): string {
    const rows = db
      .prepare(
        `SELECT id, content
         FROM memories
         WHERE scope = ? AND source = ? AND superseded_by IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(owner.scope, owner.source, NOT_FOUND_SUGGESTIONS) as Array<{
      id: string;
      content: string;
    }>;
    const head =
      `memory supersedes requires the same agent authority and scope: ` +
      `${id} is not an active memory of this authority in scope ${owner.scope}`;
    if (rows.length === 0) {
      return `${head}; this authority has none here yet — retain without supersedes`;
    }
    const candidates = rows
      .map((row) => {
        const title = projectionTitle(row.content, row.id)
          .replace(/[\u0000-\u001F\u007F"]+/g, ' ')
          .trim()
          .slice(0, SUGGESTION_TITLE_MAX);
        return `${row.id} ("${title}")`;
      })
      .join(', ');
    return `${head}; closest candidates: ${candidates}`;
  }

  #activeMemoryIdentity(
    db: Database.Database,
    id: string,
  ): {
    readonly id: string;
    readonly source: string | null;
    readonly scope: MemoryScope;
  } | null {
    const row = db
      .prepare(
        `SELECT id, source, scope
         FROM memories
         WHERE id = ? AND superseded_by IS NULL`,
      )
      .get(id) as
      | { id: string; source: string | null; scope: MemoryScope }
      | undefined;
    return row ?? null;
  }

  #markSupersededInScope(
    scope: MemoryScope,
    id: string,
    supersededBy: string,
    now: number,
  ): boolean {
    const result = this.#dbFor(scope)
      .prepare(
        `UPDATE memories
         SET superseded_by = ?, updated_at = ?
         WHERE id = ? AND scope = ? AND superseded_by IS NULL`,
      )
      .run(supersededBy, now, id, scope);
    return result.changes > 0;
  }

  #markSuperseded(id: string, supersededBy: string, now: number): boolean {
    for (const scope of MEMORY_SCOPES) {
      if (this.#markSupersededInScope(scope, id, supersededBy, now)) {
        return true;
      }
    }
    return false;
  }

  stats(): WorkspaceMemoryStats {
    this.#assertOpen();
    return Object.freeze({
      workspace: this.#statsFor(this.#workspaceDb),
      global: this.#statsFor(this.#globalDb),
      projection: this.#projectionStats(),
    });
  }

  /**
   * Linhas ativas do workspace de uma fonte criadas desde um instante —
   * usado pelo teto diário de gravações automáticas (session digest).
   */
  countActiveSince(source: string, sinceMs: number): number {
    this.#assertOpen();
    const row = this.#workspaceDb
      .prepare(
        `SELECT COUNT(*) AS n
         FROM memories
         WHERE scope = 'workspace' AND source = ?
           AND created_at >= ? AND superseded_by IS NULL`,
      )
      .get(source, sinceMs) as { n: number };
    return row.n;
  }

  /** Counts only, and only from the stat cache when nothing moved on disk. */
  #projectionStats(): ProjectionCounts {
    const root = this.#projectionRoots.values().next().value as
      | string
      | undefined;
    if (!root) return EMPTY_PROJECTION_COUNTS;
    try {
      return projectionCounts(root);
    } catch {
      return EMPTY_PROJECTION_COUNTS;
    }
  }

  #statsFor(db: Database.Database): MemoryBankStats {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(recall_count), 0) AS total_recalls
         FROM memories`,
      )
      .get() as { total: number; active: number; total_recalls: number };
    const kindRows = db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM memories WHERE superseded_by IS NULL GROUP BY kind`,
      )
      .all() as Array<{ kind: MemoryKind; count: number }>;
    const byKind: Record<MemoryKind, number> = {
      fact: 0,
      decision: 0,
      preference: 0,
      note: 0,
    };
    for (const row of kindRows) byKind[row.kind] = row.count;
    return Object.freeze({
      total: totals.total,
      active: totals.active,
      byKind: Object.freeze(byKind),
      totalRecalls: totals.total_recalls,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#workspaceDb.close();
    } finally {
      this.#globalDb.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Resolução de paths + registry por processo (mesma doutrina do
// project-runtime-manager: componentes de path derivados por SHA-256 do id,
// nunca do path bruto do workspace; diretórios 0o700; base em userData).
// ---------------------------------------------------------------------------

export interface WorkspaceMemoryPaths {
  readonly workspaceDbPath: string;
  readonly globalDbPath: string;
  readonly projectionRoot: string;
}

function digestPathComponent(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex');
}

export function resolveWorkspaceMemoryPaths(
  baseDir: string,
  scope: Pick<ProjectExecutionScope, 'projectId'>,
): WorkspaceMemoryPaths {
  if (baseDir.trim().length === 0) throw new Error('baseDir is required');
  if (scope.projectId.length === 0 || scope.projectId.length > 128) {
    throw new Error('invalid projectId');
  }
  const workspaceKey = digestPathComponent('memory-workspace', scope.projectId);
  return Object.freeze({
    workspaceDbPath: path.join(
      path.resolve(baseDir),
      'workspaces',
      `workspace-${workspaceKey}`,
      'memory.sqlite3',
    ),
    globalDbPath: path.join(path.resolve(baseDir), 'memory-global.sqlite3'),
    projectionRoot: path.join(
      path.resolve(baseDir),
      'projections',
      `workspace-${workspaceKey}`,
    ),
  });
}

export interface WorkspaceMemoryRuntimeOptions {
  readonly baseDir: string;
  readonly now?: () => number;
}

let runtimeOptions: WorkspaceMemoryRuntimeOptions | null = null;
const storesByProject = new Map<string, WorkspaceMemoryStore>();

/**
 * Configura a base de armazenamento da memória (testes: tmpdir; produção:
 * bootstrap pode fixar userData). Fecha stores abertos com a base anterior.
 */
export function configureWorkspaceMemory(
  options: WorkspaceMemoryRuntimeOptions,
): void {
  disposeWorkspaceMemoryStores();
  runtimeOptions = options;
}

function defaultRuntimeOptions(): WorkspaceMemoryRuntimeOptions {
  // Require tardio: fora do Electron (vitest) `electron` não expõe `app`;
  // nesses ambientes a base DEVE vir de configureWorkspaceMemory. Tipo
  // estrutural para não depender do namespace global Electron aqui.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as {
    app?: { getPath(name: 'userData'): string };
  };
  if (typeof electron?.app?.getPath !== 'function') {
    throw new Error(
      'workspace memory requires configureWorkspaceMemory({ baseDir }) outside Electron',
    );
  }
  return { baseDir: path.join(electron.app.getPath('userData'), 'agent-memory') };
}

/** Store por workspace (cache por projectId), criando sob demanda. */
export function getWorkspaceMemoryStore(
  scope: Pick<ProjectExecutionScope, 'projectId'> &
    Partial<Omit<ProjectExecutionScope, 'projectId'>>,
): WorkspaceMemoryStore {
  const cached = storesByProject.get(scope.projectId);
  if (cached) return cached;
  runtimeOptions ??= defaultRuntimeOptions();
  const paths = resolveWorkspaceMemoryPaths(runtimeOptions.baseDir, scope);
  fs.mkdirSync(paths.projectionRoot, {
    recursive: true,
    mode: DIRECTORY_MODE,
  });
  const store = new WorkspaceMemoryStore({
    ...paths,
    ...(runtimeOptions.now ? { now: runtimeOptions.now } : {}),
  });
  storesByProject.set(scope.projectId, store);
  return store;
}

/** Fecha e descarta todos os stores abertos (shutdown e testes). */
export function disposeWorkspaceMemoryStores(): void {
  for (const store of storesByProject.values()) {
    try {
      store.close();
    } catch {
      // Fechamento é best-effort; o próximo open recria a conexão.
    }
  }
  storesByProject.clear();
  runtimeOptions = null;
}

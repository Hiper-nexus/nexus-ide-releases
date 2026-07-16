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
import { redactCommandLine } from '../terminal/command-redaction';

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

export interface RetainInput {
  readonly content: string;
  readonly kind?: MemoryKind;
  readonly importance?: number;
  readonly scope?: MemoryScope;
  readonly source?: string;
  /** Id de memória que esta substitui (marcada superseded_by = novo id). */
  readonly supersedes?: string;
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
}

export interface WorkspaceMemoryStoreOptions {
  readonly workspaceDbPath: string;
  readonly globalDbPath: string;
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

const recallInputSchema = z
  .object({
    query: z.string().min(1).max(1_024),
    limit: z.number().int().min(1).max(32).default(8),
    kind: z.enum(MEMORY_KINDS).optional(),
    includeGlobal: z.boolean().default(true),
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

/**
 * Memória agentic durável de um workspace: banco SQLite do workspace + banco
 * global do usuário, ambos com o mesmo schema. Compartilhada por todas as
 * CLIs hospedadas via tools nexus_memory_* (src/main/orch/tools-memory.ts).
 */
export class WorkspaceMemoryStore {
  readonly #workspaceDb: Database.Database;
  readonly #globalDb: Database.Database;
  readonly #now: () => number;
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
    const scrubbed = redactCommandLine(input.content, {
      denylist: [],
      maxLength: MAX_MEMORY_CONTENT_BYTES,
    });
    const content = scrubbed.command.trim();
    if (content.length === 0) {
      throw new Error('memory content is empty after sanitization');
    }
    const hash = contentHash(content);
    const db = this.#dbFor(input.scope);
    const now = this.#now();

    const result = db.transaction((): RetainResult => {
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
          input.source ?? null,
          now,
          now,
        );
        deduped = false;
      }
      if (input.supersedes && input.supersedes !== id) {
        this.#markSuperseded(input.supersedes, id, now);
      }
      return Object.freeze({
        id,
        scope: input.scope,
        deduped,
        redacted: scrubbed.redacted,
      });
    })();
    return result;
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
    );
    if (input.includeGlobal && hits.length < input.limit) {
      hits.push(
        ...this.#recallFrom(
          this.#globalDb,
          match,
          input.kind,
          input.limit - hits.length,
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
  ): MemoryRecallHit[] {
    const now = this.#now();
    const kindFilter = kind ? 'AND m.kind = ?' : '';
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
    return this.#markSuperseded(id, FORGOTTEN_SENTINEL, this.#now());
  }

  #markSuperseded(id: string, supersededBy: string, now: number): boolean {
    for (const db of [this.#workspaceDb, this.#globalDb]) {
      const result = db
        .prepare(
          'UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL',
        )
        .run(supersededBy, now, id);
      if (result.changes > 0) return true;
    }
    return false;
  }

  stats(): WorkspaceMemoryStats {
    this.#assertOpen();
    return Object.freeze({
      workspace: this.#statsFor(this.#workspaceDb),
      global: this.#statsFor(this.#globalDb),
    });
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
  scope: Pick<ProjectExecutionScope, 'projectId'>,
): WorkspaceMemoryStore {
  const cached = storesByProject.get(scope.projectId);
  if (cached) return cached;
  runtimeOptions ??= defaultRuntimeOptions();
  const paths = resolveWorkspaceMemoryPaths(runtimeOptions.baseDir, scope);
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

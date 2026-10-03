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
  exportMemoryVault,
  exportMemoryVaultIncremental,
  projectionCounts,
  projectionKindOf,
  projectionSignature,
  projectionTitle,
  removeCanonicalMemoryProjectionAt,
  resolveMemoryRoot,
  syncCanonicalMemoryProjections,
  writeCanonicalMemoryProjectionAt,
  type CanonicalMemoryProjectionInput,
  type MemoryNote,
  type ProjectionCounts,
  type VaultIndexEntry,
} from './nexus-memory';
import {
  collectProjectionEdits,
  type ProjectionEdit,
} from './nexus-memory-ingest';
import {
  extractMemoryLinkTargets,
  memorySubjectKey,
  MISSION_LINK_PREFIX,
} from './memory-links';

export const MAX_MEMORY_CONTENT_BYTES = 8_192;

/**
 * Marcas de uma linha (F-800/F-808). `quarantine`: gravada por sessão
 * read-only ou exposta à web — nunca entra em brief sem promoção do operador.
 * `promoted`: o operador liberou a nota para o brief. `reverify`: um arquivo
 * citado sumiu do checkout; a nota segue ativa, marcada.
 */
export const MEMORY_FLAGS = ['quarantine', 'promoted', 'reverify'] as const;
export type MemoryFlag = (typeof MEMORY_FLAGS)[number];

/** Alvo derivado da chave de assunto (`# Título`) gravado em memory_links. */
export const SUBJECT_LINK_PREFIX = 'subject:';
/** Versão do índice de arestas: mudar a extração força a reindexação. */
const LINKS_INDEX_VERSION = '1';
const LINKS_INDEX_META_KEY = 'links:index-version';

/**
 * Limite de taxa do retain de agente, por autoridade física (F-807): um
 * agente em loop não pode multiplicar o custo de projeção/exportação. Um
 * worker legítimo grava poucas pegadinhas por tarefa.
 */
export const AGENT_RETAIN_WINDOW_MS = 10 * 60_000;
export const AGENT_RETAIN_MAX_PER_WINDOW = 20;

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
/**
 * Janela de coalescência da projeção (F-764): gravações em rajada no SQLite
 * viram UMA passada por raiz, agendada fora do caminho da gravação.
 */
const PROJECTION_COALESCE_MS = 50;
/**
 * Debounce da exportação para a PASTA DO PROJETO (F-807): é disco do
 * operador, opt-in, e nunca precisa refletir a gravação em tempo real.
 */
export const VAULT_EXPORT_DEBOUNCE_MS = 2_000;

/** Trabalho acumulado para uma raiz até a próxima passada. */
interface ProjectionBatch {
  /**
   * Ids cujo arquivo deve refletir o estado ATUAL da linha no SQLite: ativa
   * → escreve; esquecida ou substituída → remove.
   */
  readonly ids: Set<string>;
  /** Caminho de leitura: reconcilia só se o diretório mexeu. */
  check: boolean;
  /** Reconciliação completa (ingestão de edições, reescrita e colheita). */
  full: boolean;
  /**
   * Vault legível do checkout (F-769/F-806): ids alterados desde a última
   * passada. A primeira passada de uma raiz no processo é completa.
   */
  readonly vaultIds: Set<string>;
  vaultFull: boolean;
}

/** Fila serial de uma raiz: passadas da mesma raiz nunca se cruzam. */
interface ProjectionLane {
  batch: ProjectionBatch | null;
  timer: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
}

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
  /**
   * Id da versão anterior do MESMO assunto (`# Título`, mesma fonte) que esta
   * gravação substituiu (F-800); ausente quando nada foi substituído.
   */
  readonly supersededSubjectId?: string;
}

/**
 * Contexto Main-derived de uma gravação. Nunca vem de argumento do agente:
 * quem conhece a sessão (tools-memory, hook) decide.
 */
export interface RetainOptions {
  /** Arestas extras Main-derived (ex.: `mission:<id>` do pane que gravou). */
  readonly links?: readonly string[];
  /**
   * Motivo categórico de quarentena (sessão read-only, sessão exposta à web):
   * a linha fica fora de todo brief até o operador promover.
   */
  readonly quarantine?: string | null;
  /**
   * False quando a gravação vem de contexto read-only/consulta: a projeção em
   * userData segue normal, mas a exportação para a PASTA DO PROJETO nunca é
   * disparada por ela (F-806).
   */
  readonly vault?: boolean;
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
  /**
   * Contagem persistida. O incremento NÃO acontece no recall: só
   * `markRecalled()` conta, chamado com os ids efetivamente injetados no
   * contexto de um agente (F-769 — contar candidato filtrado depois inflava
   * o número de linhas que nenhum agente viu).
   */
  readonly recallCount: number;
  readonly score: number;
  /** Marcas ativas (quarantine/promoted/reverify); ausente quando não há. */
  readonly flags?: readonly MemoryFlag[];
  /** Detalhe da marca `reverify` (qual arquivo sumiu). */
  readonly reverify?: string;
}

export interface MemoryBankStats {
  readonly total: number;
  readonly active: number;
  readonly byKind: Readonly<Record<MemoryKind, number>>;
  readonly totalRecalls: number;
}

export interface WorkspaceMemoryStats {
  /** Durable write diagnostics; contains no agent text. */
  readonly retention: { readonly skips: Readonly<Record<string, number>>; readonly pending: number };
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
  /**
   * Raiz do checkout do workspace, FIXA na criação (F-806): é a única pasta
   * de projeto que pode receber o vault legível `<root>/.nexus-memory/`, e só
   * quando `vaultExportEnabled()` — a opção "Memória visível no projeto",
   * desligada por padrão.
   */
  readonly workspaceRoot?: string;
  /** Opt-in do operador para o vault na pasta do projeto. Default: Ajustes. */
  readonly vaultExportEnabled?: () => boolean;
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
CREATE TABLE IF NOT EXISTS memory_retention_skips (
  reason TEXT PRIMARY KEY, count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_retention_pending (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_backfill_done (
  key TEXT PRIMARY KEY, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_links (
  memory_id TEXT NOT NULL, target TEXT NOT NULL,
  PRIMARY KEY (memory_id, target)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target);
CREATE TABLE IF NOT EXISTS memory_flags (
  memory_id TEXT NOT NULL, flag TEXT NOT NULL, detail TEXT,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, flag)
) WITHOUT ROWID;
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
  readonly #projectionLanes = new Map<string, ProjectionLane>();
  /** Interrompe a passada em voo quando o store fecha. */
  readonly #projectionAbort = new AbortController();
  /** Raiz do checkout, fixa na criação (F-806): nunca troca em leitura. */
  readonly #workspaceRoot: string | undefined;
  readonly #vaultExportEnabled: () => boolean;
  /** Raízes que já receberam a exportação completa neste processo. */
  readonly #vaultColdExported = new Set<string>();
  /** Limite de taxa do retain de agente, por autoridade (F-807). */
  readonly #agentRetainWindows = new Map<string, number[]>();
  #closed = false;

  constructor(options: WorkspaceMemoryStoreOptions) {
    if (path.resolve(options.workspaceDbPath) === path.resolve(options.globalDbPath)) {
      throw new Error('workspace and global memory databases must be distinct files');
    }
    this.#now = options.now ?? Date.now;
    this.#workspaceRoot = options.workspaceRoot
      ? path.resolve(options.workspaceRoot)
      : undefined;
    this.#vaultExportEnabled = options.vaultExportEnabled ?? defaultVaultExportEnabled;
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
    // Arestas (F-800/F-801): linhas gravadas antes do índice ganham as suas
    // na abertura — uma vez por versão do índice, só nas linhas ativas.
    this.#ensureLinksIndexed(this.#workspaceDb);
    this.#ensureLinksIndexed(this.#globalDb);
    // F-768: retire only recognizable historical receipts with no substance.
    const legacyReceipts = this.#workspaceDb.prepare(`SELECT id, content FROM memories
      WHERE source = 'trusted:accepted-handoff' AND superseded_by IS NULL
      AND (content LIKE '%Summary: Handoff accepted by Nexus Main.%'
        OR content LIKE '%Summary: Handoff acknowledged by the mission orchestrator.%')`)
      .all() as Array<{ id: string; content: string }>;
    for (const row of legacyReceipts) {
      const summaries = row.content.split('\n').filter((line) => line.startsWith('Summary:'))
        .map((line) => line.slice('Summary:'.length).trim());
      if (summaries.every((summary) => /^(?:Handoff accepted by Nexus Main\.|Handoff acknowledged by the mission orchestrator\.)$/.test(summary))) {
        this.forget(row.id);
      }
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
   *
   * F-764: a passada roda na fila da raiz com `fs.promises`; quem precisa do
   * disco pronto aguarda a promessa.
   */
  async syncProjections(): Promise<void> {
    this.#assertOpen();
    await Promise.all(
      [...this.#projectionRoots].map((root) =>
        this.#runProjectionNow(root, (batch) => {
          batch.full = true;
        }),
      ),
    );
  }

  /**
   * Read-path reconciliation. A full pass only runs when the directory
   * signature moved (one readdir plus an lstat per file), so the common case —
   * nothing touched the projection since the last pass — stays O(dir) instead
   * of re-reading and re-parsing every note on every keystroke.
   *
   * F-764: também drena as gravações ainda na janela de coalescência — quem
   * lê a projeção logo depois de gravar enxerga a própria gravação.
   */
  async ensureProjections(): Promise<void> {
    this.#assertOpen();
    await Promise.all(
      [...this.#projectionRoots].map((root) =>
        this.#runProjectionNow(root, (batch) => {
          batch.check = true;
        }),
      ),
    );
  }

  /**
   * Espera a projeção alcançar o SQLite: drena agora os lotes ainda na janela
   * e aguarda as passadas em voo — inclusive as encadeadas enquanto isso.
   * Para testes, leitura logo após gravar e o shutdown; o caminho da gravação
   * nunca espera.
   */
  async flushProjections(): Promise<void> {
    for (;;) {
      const waited = new Map<ProjectionLane, Promise<void>>();
      for (const [root, lane] of this.#projectionLanes) {
        waited.set(lane, this.#drainProjectionLane(root, lane));
      }
      await Promise.all(waited.values());
      const settled =
        waited.size === this.#projectionLanes.size &&
        [...waited].every(
          ([lane, tail]) => lane.tail === tail && !lane.batch && !lane.timer,
        );
      if (settled) return;
    }
  }

  /**
   * Exporta a memória ativa do workspace como vault markdown legível em
   * `<projectRoot>/.nexus-memory/` (F-769): nomes por slug do título, um
   * INDEX por tipo, wikilinks para arquivos citados e `.gitignore` próprio.
   * Visão morta e one-shot, pedida EXPLICITAMENTE (tela Memória / opt-in):
   * o workspace nunca é registrado como raiz viva, então a ingestão de
   * edições segue restrita às projeções em userData. Entra na fila da raiz,
   * atrás de qualquer exportação agendada.
   */
  async exportProjectionsToWorkspace(projectRoot: string): Promise<string> {
    this.#assertOpen();
    const root = path.resolve(projectRoot);
    return this.#onProjectionLane(root, async () => {
      const exported = await exportMemoryVault(
        root,
        this.#activeProjectionRecords(),
        undefined,
        this.#projectionAbort.signal,
      );
      this.#vaultColdExported.add(root);
      return exported;
    });
  }

  /** Raiz do checkout fixada na criação; undefined fora de um workspace. */
  get workspaceRoot(): string | undefined {
    return this.#workspaceRoot;
  }

  /** O vault na pasta do projeto só existe com o opt-in do operador (F-806). */
  vaultExportEnabled(): boolean {
    try {
      return this.#vaultExportEnabled() === true;
    } catch {
      return false;
    }
  }

  /**
   * Exportação best-effort do vault: nunca derruba uma gravação de memória.
   * A primeira passada de uma raiz no processo é completa (reconcilia o que
   * mudou com o app fechado); as seguintes só tocam as notas do lote, os
   * índices dos tipos afetados e os hubs das missões afetadas (F-807).
   */
  async #exportVaultBestEffort(root: string, batch: ProjectionBatch): Promise<void> {
    try {
      if (batch.vaultFull || !this.#vaultColdExported.has(root)) {
        await exportMemoryVault(
          root,
          this.#activeProjectionRecords(),
          undefined,
          this.#projectionAbort.signal,
        );
        this.#vaultColdExported.add(root);
        return;
      }
      if (batch.vaultIds.size === 0) return;
      await exportMemoryVaultIncremental(
        root,
        this.#vaultDeltaFor([...batch.vaultIds]),
        undefined,
        this.#projectionAbort.signal,
      );
    } catch (error) {
      if (this.#closed) return;
      // Raiz não exportada por inteiro: a próxima passada reconcilia tudo.
      this.#vaultColdExported.delete(root);
      console.warn(
        `[memory] could not export readable vault for ${path.basename(root)}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Delta de uma passada incremental: o estado ATUAL de cada id (ativo →
   * escreve; esquecido/substituído → remove, com o nome derivado do conteúdo
   * guardado), mais os índices dos tipos e os hubs das missões afetadas.
   */
  #vaultDeltaFor(ids: readonly string[]): {
    readonly changed: CanonicalMemoryProjectionInput[];
    readonly removed: CanonicalMemoryProjectionInput[];
    readonly indexes: ReadonlyMap<MemoryNote['kind'], readonly VaultIndexEntry[]>;
    readonly hubs: ReadonlyMap<string, readonly VaultIndexEntry[]>;
  } {
    const changed: CanonicalMemoryProjectionInput[] = [];
    const removed: CanonicalMemoryProjectionInput[] = [];
    const kinds = new Set<MemoryNote['kind']>();
    const missions = new Set<string>();
    const anyRow = this.#workspaceDb.prepare(
      `SELECT id, content, kind, scope, importance, source,
              created_at, updated_at, superseded_by
       FROM memories
       WHERE id = ? AND scope = 'workspace'`,
    );
    const missionLinks = this.#workspaceDb.prepare(
      `SELECT target FROM memory_links WHERE memory_id = ? AND target LIKE '${MISSION_LINK_PREFIX}%'`,
    );
    for (const id of ids) {
      const raw = anyRow.get(id) as
        | (Record<string, unknown> & { superseded_by: string | null })
        | undefined;
      if (!raw) continue;
      const { superseded_by: supersededBy, ...rest } = raw;
      const record = this.#toProjectionInput(rest);
      kinds.add(projectionKindOf(record));
      for (const row of missionLinks.all(id) as Array<{ target: string }>) {
        missions.add(row.target.slice(MISSION_LINK_PREFIX.length));
      }
      if (supersededBy === null) changed.push(this.#withReverify(record));
      else removed.push(record);
    }
    const indexes = new Map<MemoryNote['kind'], VaultIndexEntry[]>();
    const hubs = new Map<string, VaultIndexEntry[]>();
    if (kinds.size > 0 || missions.size > 0) {
      for (const kind of kinds) indexes.set(kind, []);
      for (const mission of missions) hubs.set(mission, []);
      const linked = this.#workspaceDb.prepare(
        `SELECT memory_id FROM memory_links WHERE target = ?`,
      );
      const byMission = new Map<string, Set<string>>();
      for (const mission of missions) {
        byMission.set(
          mission,
          new Set(
            (linked.all(`${MISSION_LINK_PREFIX}${mission}`) as Array<{ memory_id: string }>)
              .map((row) => row.memory_id),
          ),
        );
      }
      for (const record of this.#activeProjectionRecords()) {
        const entry = { record } as const;
        const kind = projectionKindOf(record);
        indexes.get(kind)?.push(entry);
        for (const [mission, members] of byMission) {
          if (members.has(record.id)) hubs.get(mission)!.push(entry);
        }
      }
    }
    return { changed, removed, indexes, hubs };
  }

  #activeProjectionRecords(): CanonicalMemoryProjectionInput[] {
    const reverify = this.#reverifyDetails();
    return this.#workspaceDb
      .prepare(
        `SELECT id, content, kind, scope, importance, source,
                created_at, updated_at
         FROM memories
         WHERE scope = 'workspace' AND superseded_by IS NULL
         ORDER BY created_at, id`,
      )
      .all()
      .map((raw) => {
        const record = this.#toProjectionInput(raw);
        const detail = reverify.get(record.id);
        return detail ? { ...record, reverify: detail } : record;
      });
  }

  #reverifyDetails(): Map<string, string> {
    const rows = this.#workspaceDb
      .prepare(`SELECT memory_id, detail FROM memory_flags WHERE flag = 'reverify'`)
      .all() as Array<{ memory_id: string; detail: string | null }>;
    return new Map(rows.map((row) => [row.memory_id, row.detail ?? 'reverify']));
  }

  #withReverify(record: CanonicalMemoryProjectionInput): CanonicalMemoryProjectionInput {
    const row = this.#workspaceDb
      .prepare(`SELECT detail FROM memory_flags WHERE memory_id = ? AND flag = 'reverify'`)
      .get(record.id) as { detail: string | null } | undefined;
    return row ? { ...record, reverify: row.detail ?? 'reverify' } : record;
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
    return raw ? this.#withReverify(this.#toProjectionInput(raw)) : null;
  }

  // -------------------------------------------------------------------------
  // Fila da projeção (F-764). O caminho da gravação só marca o lote da raiz e
  // arma a janela; a passada roda depois, serial por raiz, com fs.promises.
  // -------------------------------------------------------------------------

  #projectionLane(root: string): ProjectionLane {
    let lane = this.#projectionLanes.get(root);
    if (!lane) {
      lane = { batch: null, timer: null, tail: Promise.resolve() };
      this.#projectionLanes.set(root, lane);
    }
    return lane;
  }

  #markProjectionBatch(
    root: string,
    mark: (batch: ProjectionBatch) => void,
  ): ProjectionLane {
    const lane = this.#projectionLane(root);
    lane.batch ??= {
      ids: new Set(),
      check: false,
      full: false,
      vaultIds: new Set(),
      vaultFull: false,
    };
    mark(lane.batch);
    return lane;
  }

  /** Caminho da gravação: nenhum acesso a disco aqui, só a marca e o timer. */
  #scheduleProjection(
    root: string,
    mark: (batch: ProjectionBatch) => void,
    delayMs = PROJECTION_COALESCE_MS,
  ): void {
    if (this.#closed) return;
    const lane = this.#markProjectionBatch(root, mark);
    if (lane.timer) return;
    lane.timer = setTimeout(() => {
      void this.#drainProjectionLane(root, lane);
    }, delayMs);
    lane.timer.unref?.();
  }

  /** Leitura e sync explícito: marca e drena já, sem esperar a janela. */
  #runProjectionNow(
    root: string,
    mark: (batch: ProjectionBatch) => void,
  ): Promise<void> {
    return this.#drainProjectionLane(root, this.#markProjectionBatch(root, mark));
  }

  /** Encadeia o lote pendente na fila da raiz; devolve o fim da fila. */
  #drainProjectionLane(root: string, lane: ProjectionLane): Promise<void> {
    if (lane.timer) {
      clearTimeout(lane.timer);
      lane.timer = null;
    }
    const batch = lane.batch;
    lane.batch = null;
    if (batch) {
      this.#onProjectionLane(root, () =>
        this.#runProjectionBatch(root, batch),
      ).catch(() => undefined);
    }
    return lane.tail;
  }

  /** Roda `task` depois de tudo o que a fila da raiz já tem. */
  #onProjectionLane<T>(root: string, task: () => Promise<T>): Promise<T> {
    const lane = this.#projectionLane(root);
    const run = lane.tail.then(task);
    lane.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Gravação ou remoção de `id` na projeção, coalescida por raiz. */
  #scheduleProjectionSync(id: string): void {
    for (const root of this.#projectionRoots) {
      this.#scheduleProjection(root, (batch) => {
        batch.ids.add(id);
      });
    }
  }

  /**
   * Vault legível do checkout (F-769): só com o opt-in do operador, só na
   * raiz fixada na criação, com debounce de 2 s e incremental (F-806/F-807).
   * A pasta do projeto é disco do operador: a gravação em si nunca espera.
   */
  #scheduleVaultExport(ids: readonly string[]): void {
    const root = this.#workspaceRoot;
    if (!root || !this.vaultExportEnabled()) return;
    this.#scheduleProjection(
      root,
      (batch) => {
        for (const id of ids) batch.vaultIds.add(id);
      },
      VAULT_EXPORT_DEBOUNCE_MS,
    );
  }

  /** Uma passada; best-effort — erro vira warn, nunca rejeita. */
  async #runProjectionBatch(
    root: string,
    batch: ProjectionBatch,
  ): Promise<void> {
    if (this.#closed) return;
    if (
      this.#projectionRoots.has(root) &&
      (batch.full || batch.check || batch.ids.size > 0)
    ) {
      await this.#reconcileProjectionRoot(root, batch);
    }
    if ((batch.vaultFull || batch.vaultIds.size > 0) && !this.#closed) {
      // Opt-in reavaliado na passada: desligado entre a marca e a janela,
      // nada é escrito na pasta do projeto.
      if (root === this.#workspaceRoot && this.vaultExportEnabled()) {
        await this.#exportVaultBestEffort(root, batch);
      }
    }
  }

  /**
   * Passada de uma raiz registrada. Se o diretório mexeu desde a nossa última
   * passada (edição do operador, arquivo apagado) ou a raiz ainda não foi
   * sincronizada, vira reconciliação completa — que ingere ANTES de escrever,
   * para a reescrita não apagar a edição. Senão, só os ids do lote.
   */
  async #reconcileProjectionRoot(
    root: string,
    batch: ProjectionBatch,
  ): Promise<void> {
    const full =
      batch.full ||
      this.#unsyncedProjectionRoots.has(root) ||
      this.#projectionSignatures.get(root) !==
        (await projectionSignature(root));
    if (this.#closed) return;
    if (full) {
      if (await this.#syncProjectionRootBestEffort(root)) {
        this.#unsyncedProjectionRoots.delete(root);
      }
      return;
    }
    if (batch.ids.size === 0) return;
    let memoryRoot: string;
    try {
      // Contenção síncrona, uma vez por lote — nunca uma vez por id.
      memoryRoot = resolveMemoryRoot(root);
    } catch (error) {
      console.warn(
        `[memory] could not update generated projection for ${path.basename(root)}:`,
        error instanceof Error ? error.message : error,
      );
      this.#unsyncedProjectionRoots.add(root);
      return;
    }
    let projected = true;
    for (const id of batch.ids) {
      if (this.#closed) return;
      projected = (await this.#projectIdBestEffort(memoryRoot, id)) && projected;
    }
    if (projected) {
      await this.#markProjectionSynced(root);
    } else {
      // Um arquivo ficou para trás: a próxima passada reconcilia tudo.
      this.#unsyncedProjectionRoots.add(root);
    }
  }

  /**
   * Faz o arquivo de `id` refletir o estado ATUAL da linha. A passada lê o
   * SQLite na hora, não o pedido enfileirado: gravações e remoções do mesmo
   * id convergem na ordem certa mesmo coalescidas no mesmo lote.
   */
  async #projectIdBestEffort(memoryRoot: string, id: string): Promise<boolean> {
    let action = 'update';
    try {
      const record = this.#projectionRecord(id);
      if (record) {
        await writeCanonicalMemoryProjectionAt(
          memoryRoot,
          record,
          this.#projectionAbort.signal,
        );
      } else {
        action = 'remove';
        await removeCanonicalMemoryProjectionAt(memoryRoot, id);
      }
      return true;
    } catch (error) {
      if (!this.#closed) {
        console.warn(
          `[memory] could not ${action} generated projection ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
      return false;
    }
  }

  async #syncProjectionRootBestEffort(root: string): Promise<boolean> {
    try {
      // Ingest before writing: an operator edit that lands in SQLite must be
      // reflected by the very same pass, or the write below would erase it.
      await this.#ingestProjectionEdits(root);
      if (this.#closed) return false;
      await syncCanonicalMemoryProjections(
        root,
        this.#activeProjectionRecords(),
        undefined,
        this.#projectionAbort.signal,
      );
      await this.#markProjectionSynced(root);
      return true;
    } catch (error) {
      if (!this.#closed) {
        console.warn(
          `[memory] could not sync generated projection for ${path.basename(root)}:`,
          error instanceof Error ? error.message : error,
        );
      }
      return false;
    }
  }

  /**
   * Applies the operator edits found on disk. Everything a file may assert is
   * bounded here: only the body of an already-active workspace row, only when
   * the row has not moved since that file was rendered, never a trusted row,
   * and always through the same secret redaction `retain()` uses.
   */
  async #ingestProjectionEdits(root: string): Promise<number> {
    const edits = await collectProjectionEdits(
      root,
      this.#activeProjectionRecords(),
    );
    let applied = 0;
    for (const edit of edits) {
      // The read was asynchronous: the row may have moved meanwhile, which
      // #applyProjectionEdit re-checks against updated_at before writing.
      if (this.#closed) break;
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
      if (result.changes > 0) {
        this.#replaceLinks(db, row.id, content, row.source, []);
      }
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

  async #markProjectionSynced(root: string): Promise<void> {
    try {
      this.#projectionSignatures.set(root, await projectionSignature(root));
    } catch {
      this.#projectionSignatures.delete(root);
    }
  }

  /**
   * Persiste (ou renova) uma memória. Conteúdo passa por redação de segredos
   * (mesmo helper do histórico de terminal) antes de tocar o disco; retain de
   * conteúdo idêntico (hash normalizado) só renova updated_at.
   */
  retain(rawInput: RetainInput, options: RetainOptions = {}): RetainResult {
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
    const source = redactMemorySource(input.source);
    const extraLinks = (options.links ?? []).filter(
      (target) => typeof target === 'string' && target.length > 0 && target.length <= 600,
    );

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
      let supersededSubjectId: string | undefined;
      if (existing) {
        db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(
          now,
          existing.id,
        );
        id = existing.id;
        deduped = true;
        // O mesmo conteúdo gravado de outro contexto só soma arestas (ex.:
        // mais uma missão); a marca de confiança da primeira gravação fica.
        this.#addLinks(db, id, extraLinks);
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
          source,
          now,
          now,
        );
        deduped = false;
        this.#replaceLinks(db, id, content, source, extraLinks);
        if (options.quarantine) {
          db.prepare(
            `INSERT OR REPLACE INTO memory_flags(memory_id, flag, detail, marked_at)
             VALUES (?, 'quarantine', ?, ?)`,
          ).run(id, options.quarantine.slice(0, 120), now);
        }
        // F-800: versão nova do mesmo assunto, da MESMA fonte, substitui a
        // anterior em vez de empilhar. Fonte diferente nunca é substituída
        // por título — a autoridade de cada linha continua intacta.
        if (!input.supersedes && source) {
          const previous = this.#activeSameSubject(db, id, input.scope, source, content);
          if (previous && this.#markSupersededInScope(input.scope, previous, id, now)) {
            supersededSubjectId = previous;
          }
        }
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
          ...(supersededSubjectId ? { supersededSubjectId } : {}),
        }),
        superseded,
      });
    })();
    const result = transactionResult.result;
    // F-764: o SQLite acima é a fonte da verdade e já está gravado; a
    // projeção e o vault só são agendados — nada de fs no caminho da gravação.
    if (result.scope === 'workspace') {
      const touched = [result.id];
      if (result.supersededSubjectId) touched.push(result.supersededSubjectId);
      if (transactionResult.superseded && input.supersedes) touched.push(input.supersedes);
      for (const id of touched) this.#scheduleProjectionSync(id);
      // F-806: contexto read-only/consulta nunca dispara escrita na pasta do
      // projeto; a projeção em userData acima já refletiu a gravação.
      if (options.vault !== false) this.#scheduleVaultExport(touched);
    }
    return result;
  }

  /**
   * Agent-facing retention boundary. A worker may only replace an active
   * candidate authored by the same Main-derived physical authority in the
   * same memory bank. Trusted and foreign-origin rows remain immutable.
   * F-807: limite de taxa por autoridade — um agente em loop para de gravar
   * antes de multiplicar o custo de projeção.
   */
  retainAgentAuthored(
    rawInput: Omit<RetainInput, 'source'>,
    rawAuthority: AgentAuthoredMemoryAuthority,
    options: RetainOptions = {},
  ): RetainResult {
    this.#assertOpen();
    const input = agentAuthoredRetainInputSchema.parse(rawInput);
    const authority = agentAuthoredAuthoritySchema.parse(rawAuthority);
    this.#assertAgentRetainRate(authority.source);
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
    return this.retain(
      {
        ...input,
        source: authority.source,
      },
      options,
    );
  }

  /** Janela deslizante por autoridade; estoura → erro acionável, nada gravado. */
  #assertAgentRetainRate(source: string): void {
    const now = this.#now();
    const floor = now - AGENT_RETAIN_WINDOW_MS;
    const stamps = (this.#agentRetainWindows.get(source) ?? []).filter((at) => at > floor);
    if (stamps.length >= AGENT_RETAIN_MAX_PER_WINDOW) {
      this.#agentRetainWindows.set(source, stamps);
      throw new Error(
        `memory retain rate limit: at most ${AGENT_RETAIN_MAX_PER_WINDOW} retains per ` +
          `${AGENT_RETAIN_WINDOW_MS / 60_000} min for this agent; consolidate what you ` +
          'learned into fewer notes and retry later',
      );
    }
    stamps.push(now);
    this.#agentRetainWindows.set(source, stamps);
    // Autoridades antigas não acumulam para sempre num processo longo.
    if (this.#agentRetainWindows.size > 512) {
      for (const [key, value] of this.#agentRetainWindows) {
        if (value.every((at) => at <= floor)) this.#agentRetainWindows.delete(key);
      }
    }
  }

  /**
   * Linha ativa mais recente da mesma fonte com a mesma chave de assunto
   * (`# Título`), distinta de `id`. Null sem heading ou com título genérico.
   */
  #activeSameSubject(
    db: Database.Database,
    id: string,
    scope: MemoryScope,
    source: string,
    content: string,
  ): string | null {
    const subject = memorySubjectKey(content);
    if (!subject) return null;
    const row = db
      .prepare(
        `SELECT m.id FROM memory_links l
         JOIN memories m ON m.id = l.memory_id
         WHERE l.target = ? AND m.scope = ? AND m.source = ?
           AND m.superseded_by IS NULL AND m.id != ?
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1`,
      )
      .get(`${SUBJECT_LINK_PREFIX}${subject}`, scope, source, id) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Arestas derivadas do conteúdo/fonte + extras Main-derived; substitui as antigas. */
  #replaceLinks(
    db: Database.Database,
    id: string,
    content: string,
    source: string | null,
    extra: readonly string[],
  ): void {
    db.prepare('DELETE FROM memory_links WHERE memory_id = ?').run(id);
    const targets = new Set(extractMemoryLinkTargets(content, source));
    const subject = memorySubjectKey(content);
    if (subject) targets.add(`${SUBJECT_LINK_PREFIX}${subject}`);
    for (const target of extra) targets.add(target);
    this.#addLinks(db, id, [...targets]);
  }

  #addLinks(db: Database.Database, id: string, targets: readonly string[]): void {
    if (targets.length === 0) return;
    const insert = db.prepare(
      'INSERT OR IGNORE INTO memory_links(memory_id, target) VALUES (?, ?)',
    );
    for (const target of targets) insert.run(id, target);
  }

  /**
   * Reindexa as arestas das linhas ativas uma vez por versão do índice: a
   * memória gravada antes do F-800 passa a ter `file:`/`mission:`/`subject:`.
   * Linhas ativas são poucas (centenas); o custo é o de uma abertura.
   */
  #ensureLinksIndexed(db: Database.Database): void {
    const current = db
      .prepare('SELECT value FROM memory_meta WHERE key = ?')
      .get(LINKS_INDEX_META_KEY) as { value: string } | undefined;
    if (current?.value === LINKS_INDEX_VERSION) return;
    db.transaction(() => {
      const rows = db
        .prepare('SELECT id, content, source FROM memories WHERE superseded_by IS NULL')
        .all() as Array<{ id: string; content: string; source: string | null }>;
      for (const row of rows) this.#replaceLinks(db, row.id, row.content, row.source, []);
      db.prepare(
        'INSERT OR REPLACE INTO memory_meta(key, value) VALUES (?, ?)',
      ).run(LINKS_INDEX_META_KEY, LINKS_INDEX_VERSION);
    })();
  }

  /**
   * Busca FTS5 (MATCH + bm25) com re-ranking por importância e recência.
   * Consulta o banco do workspace primeiro; com includeGlobal (default),
   * completa as vagas restantes com o banco global. NÃO incrementa contadores:
   * quem injeta o resultado num contexto marca os ids com `markRecalled()`.
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

  /**
   * Marca como injetadas as memórias que de fato chegaram ao contexto de um
   * agente: incrementa recall_count e last_recalled_at só desses ids, em
   * qualquer um dos dois bancos. Ids desconhecidos são ignorados.
   */
  markRecalled(ids: readonly string[]): void {
    this.#assertOpen();
    if (ids.length === 0) return;
    const now = this.#now();
    const bumpWorkspace = this.#workspaceDb.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
    );
    const bumpGlobal = this.#globalDb.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
    );
    this.#workspaceDb.transaction(() => {
      for (const id of ids) {
        if (bumpWorkspace.run(now, id).changes === 0) {
          bumpGlobal.run(now, id);
        }
      }
    })();
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
    const flags = this.#flagsFor(db, scored.map(({ row }) => row.id));
    return scored.map(({ row, score }) =>
      this.#toHit(row, score, flags.get(row.id)),
    );
  }

  #toHit(
    row: z.infer<typeof memoryRowSchema>,
    score: number,
    flags: ReadonlyArray<{ flag: MemoryFlag; detail: string | null }> | undefined,
  ): MemoryRecallHit {
    const reverify = flags?.find((entry) => entry.flag === 'reverify');
    return Object.freeze({
      id: row.id,
      content: row.content,
      kind: row.kind,
      scope: row.scope,
      importance: row.importance,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recallCount: row.recall_count,
      score,
      ...(flags && flags.length > 0
        ? { flags: Object.freeze(flags.map((entry) => entry.flag)) }
        : {}),
      ...(reverify ? { reverify: reverify.detail ?? 'reverify' } : {}),
    });
  }

  /** Marcas das linhas pedidas, num SELECT só. */
  #flagsFor(
    db: Database.Database,
    ids: readonly string[],
  ): Map<string, Array<{ flag: MemoryFlag; detail: string | null }>> {
    const out = new Map<string, Array<{ flag: MemoryFlag; detail: string | null }>>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT memory_id, flag, detail FROM memory_flags
         WHERE memory_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ memory_id: string; flag: string; detail: string | null }>;
    for (const row of rows) {
      if (!(MEMORY_FLAGS as readonly string[]).includes(row.flag)) continue;
      const list = out.get(row.memory_id) ?? [];
      list.push({ flag: row.flag as MemoryFlag, detail: row.detail });
      out.set(row.memory_id, list);
    }
    return out;
  }

  /**
   * Recall por relação (F-801, "a hora de usar grafo"): as linhas ativas do
   * workspace ligadas a qualquer dos alvos (`file:<caminho>` do raio de
   * impacto, `mission:<id>`), sem consulta textual. Ordem: importância e
   * recência; `excludeIds` tira o que o FTS já trouxe.
   */
  recallLinked(input: {
    readonly targets: readonly string[];
    readonly limit?: number;
    readonly excludeIds?: readonly string[];
    readonly trustedOnly?: boolean;
  }): MemoryRecallHit[] {
    this.#assertOpen();
    const targets = [...new Set(input.targets)].filter(Boolean).slice(0, 128);
    if (targets.length === 0) return [];
    const limit = Math.max(1, Math.min(input.limit ?? 8, 32));
    const exclude = new Set(input.excludeIds ?? []);
    const placeholders = targets.map(() => '?').join(',');
    const trustedFilter = input.trustedOnly ? "AND m.source LIKE 'trusted:%'" : '';
    const rows = (
      this.#workspaceDb
        .prepare(
          `SELECT DISTINCT m.id, m.content, m.kind, m.scope, m.importance, m.source,
                  m.created_at, m.updated_at, m.recall_count, 0 AS rank
           FROM memory_links l
           JOIN memories m ON m.id = l.memory_id
           WHERE l.target IN (${placeholders})
             AND m.scope = 'workspace' AND m.superseded_by IS NULL
             ${trustedFilter}
           ORDER BY m.importance DESC, m.updated_at DESC, m.id ASC
           LIMIT ?`,
        )
        .all(...targets, limit + exclude.size) as unknown[]
    )
      .map((raw) => memoryRowSchema.parse(raw))
      .filter((row) => !exclude.has(row.id))
      .slice(0, limit);
    const flags = this.#flagsFor(this.#workspaceDb, rows.map((row) => row.id));
    return rows.map((row) => this.#toHit(row, row.importance, flags.get(row.id)));
  }

  /** Dos ids dados, quais têm aresta com a missão (F-808: notas da MESMA missão). */
  idsLinkedToMission(ids: readonly string[], missionId: string): Set<string> {
    this.#assertOpen();
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.#workspaceDb
      .prepare(
        `SELECT memory_id FROM memory_links
         WHERE target = ? AND memory_id IN (${placeholders})`,
      )
      .all(`${MISSION_LINK_PREFIX}${missionId}`, ...ids) as Array<{ memory_id: string }>;
    return new Set(rows.map((row) => row.memory_id));
  }

  /** Alvos `file:`/`mission:`/… de uma linha, como gravados. */
  linksOf(id: string): string[] {
    this.#assertOpen();
    const rows = this.#workspaceDb
      .prepare('SELECT target FROM memory_links WHERE memory_id = ? ORDER BY target')
      .all(id) as Array<{ target: string }>;
    return rows.map((row) => row.target);
  }

  // -------------------------------------------------------------------------
  // Marcas (F-800/F-808) e metadados de manutenção.
  // -------------------------------------------------------------------------

  /** Marca uma linha ativa do workspace; substitui o detalhe anterior da mesma marca. */
  flagMemory(id: string, flag: MemoryFlag, detail?: string | null): boolean {
    this.#assertOpen();
    const active = this.#workspaceDb
      .prepare(`SELECT 1 FROM memories WHERE id = ? AND superseded_by IS NULL`)
      .get(id);
    if (!active) return false;
    this.#workspaceDb
      .prepare(
        `INSERT OR REPLACE INTO memory_flags(memory_id, flag, detail, marked_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, flag, detail ? detail.slice(0, 512) : null, this.#now());
    this.#scheduleProjectionSync(id);
    this.#scheduleVaultExport([id]);
    return true;
  }

  unflagMemory(id: string, flag: MemoryFlag): boolean {
    this.#assertOpen();
    const changed =
      this.#workspaceDb
        .prepare('DELETE FROM memory_flags WHERE memory_id = ? AND flag = ?')
        .run(id, flag).changes > 0;
    if (changed) {
      this.#scheduleProjectionSync(id);
      this.#scheduleVaultExport([id]);
    }
    return changed;
  }

  /**
   * Promoção pelo operador (F-808): a nota em quarentena passa a poder entrar
   * no brief de qualquer pane deste projeto. Só a tela Memória chama isto.
   */
  promoteMemory(id: string): boolean {
    this.#assertOpen();
    if (!this.flagMemory(id, 'promoted')) return false;
    this.unflagMemory(id, 'quarantine');
    return true;
  }

  /** Marcas das linhas pedidas (workspace), para a injeção e a tela Memória. */
  flagsOf(ids: readonly string[]): ReadonlyMap<string, readonly MemoryFlag[]> {
    this.#assertOpen();
    const out = new Map<string, readonly MemoryFlag[]>();
    for (const [id, entries] of this.#flagsFor(this.#workspaceDb, ids)) {
      out.set(id, Object.freeze(entries.map((entry) => entry.flag)));
    }
    return out;
  }

  getMeta(key: string): string | null {
    this.#assertOpen();
    const row = this.#workspaceDb
      .prepare('SELECT value FROM memory_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#assertOpen();
    this.#workspaceDb
      .prepare('INSERT OR REPLACE INTO memory_meta(key, value) VALUES (?, ?)')
      .run(key, value);
  }

  isBackfillDone(key: string): boolean {
    this.#assertOpen();
    return Boolean(
      this.#workspaceDb.prepare('SELECT 1 FROM memory_backfill_done WHERE key = ?').get(key),
    );
  }

  markBackfillDone(keys: readonly string[]): void {
    this.#assertOpen();
    if (keys.length === 0) return;
    const now = this.#now();
    const insert = this.#workspaceDb.prepare(
      'INSERT OR IGNORE INTO memory_backfill_done(key, at) VALUES (?, ?)',
    );
    this.#workspaceDb.transaction(() => {
      for (const key of keys) insert.run(key, now);
    })();
  }

  /**
   * Expiração por tipo (F-800): `session-digest` que nunca chegou a um
   * contexto (recall_count = 0) e passou da idade vira tombstone `forgotten`.
   * Devolve os ids esquecidos. Outros tipos não expiram — só são substituídos.
   */
  expireUnrecalledSessionDigests(maxAgeMs: number): string[] {
    this.#assertOpen();
    const now = this.#now();
    const rows = this.#workspaceDb
      .prepare(
        `SELECT id FROM memories
         WHERE scope = 'workspace' AND source = 'trusted:session-digest'
           AND superseded_by IS NULL AND recall_count = 0 AND created_at < ?`,
      )
      .all(now - maxAgeMs) as Array<{ id: string }>;
    const ids = rows.map((row) => row.id);
    for (const id of ids) this.forget(id);
    return ids;
  }

  /**
   * Linhas ativas do workspace com arestas `file:` — a lista que a manutenção
   * confere contra o checkout para marcar "a reverificar" (F-800).
   */
  activeFileLinked(kind?: MemoryKind, limit = 2_000): Array<{ id: string; files: string[] }> {
    this.#assertOpen();
    const kindFilter = kind ? 'AND m.kind = ?' : '';
    const params: Array<string | number> = kind ? [kind, limit] : [limit];
    const rows = this.#workspaceDb
      .prepare(
        `SELECT l.memory_id AS id, l.target AS target
         FROM memory_links l JOIN memories m ON m.id = l.memory_id
         WHERE l.target LIKE 'file:%' AND m.scope = 'workspace'
           AND m.superseded_by IS NULL ${kindFilter}
         ORDER BY m.created_at, l.target
         LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; target: string }>;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const files = grouped.get(row.id) ?? [];
      files.push(row.target.slice('file:'.length));
      grouped.set(row.id, files);
    }
    return [...grouped].map(([id, files]) => ({ id, files }));
  }

  /** Linhas ativas do workspace de uma fonte (id + conteúdo), para reconciliação. */
  activeBySource(source: string): Array<{ id: string; content: string }> {
    this.#assertOpen();
    return this.#workspaceDb
      .prepare(
        `SELECT id, content FROM memories
         WHERE scope = 'workspace' AND source = ? AND superseded_by IS NULL
         ORDER BY created_at, id`,
      )
      .all(source) as Array<{ id: string; content: string }>;
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
    if (forgotten) {
      this.#scheduleProjectionSync(id);
      this.#scheduleVaultExport([id]);
    }
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
      this.#scheduleProjectionSync(input.id);
      this.#scheduleVaultExport([input.id]);
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

  recordRetentionSkip(reason: string): void {
    this.#assertOpen();
    this.#workspaceDb.prepare(`INSERT INTO memory_retention_skips(reason, count) VALUES (?, 1)
      ON CONFLICT(reason) DO UPDATE SET count = count + 1`).run(reason);
  }

  enqueueRetention(payload: string): string {
    this.#assertOpen();
    // Pending text receives the same secret scrub as canonical memory.
    const safePayload = redactSecretText(payload).text;
    const id = createHash('sha256').update(safePayload).digest('hex');
    this.#workspaceDb.prepare(`INSERT OR IGNORE INTO memory_retention_pending(id, payload, created_at)
      VALUES (?, ?, ?)`).run(id, safePayload, this.#now());
    return id;
  }

  pendingRetentions(): Array<{ id: string; payload: string }> {
    this.#assertOpen();
    return this.#workspaceDb.prepare(`SELECT id, payload FROM memory_retention_pending
      ORDER BY created_at, id LIMIT 20`).all() as Array<{ id: string; payload: string }>;
  }

  removePendingRetention(id: string): void {
    this.#assertOpen();
    this.#workspaceDb.prepare('DELETE FROM memory_retention_pending WHERE id = ?').run(id);
  }

  stats(): WorkspaceMemoryStats {
    this.#assertOpen();
    return Object.freeze({
      retention: Object.freeze({
        skips: Object.freeze(Object.fromEntries(
          (this.#workspaceDb.prepare('SELECT reason, count FROM memory_retention_skips').all() as Array<{ reason: string; count: number }>)
            .map((row) => [row.reason, row.count]),
        )),
        pending: (this.#workspaceDb.prepare('SELECT COUNT(*) AS n FROM memory_retention_pending').get() as { n: number }).n,
      }),
      workspace: this.#statsFor(this.#workspaceDb),
      global: this.#statsFor(this.#globalDb),
      projection: this.#projectionStats(),
    });
  }

  /**
   * Linhas do workspace de uma fonte criadas desde um instante, inclusive as
   * já substituídas — o teto diário de gravações automáticas (session digest)
   * conta gravações, não linhas vivas.
   */
  countCreatedSince(source: string, sinceMs: number): number {
    this.#assertOpen();
    const row = this.#workspaceDb
      .prepare(
        `SELECT COUNT(*) AS n
         FROM memories
         WHERE scope = 'workspace' AND source = ? AND created_at >= ?`,
      )
      .get(source, sinceMs) as { n: number };
    return row.n;
  }

  /** Fonte de uma linha ativa do workspace; null se não existe ou já saiu. */
  activeWorkspaceSource(id: string): string | null {
    this.#assertOpen();
    const row = this.#workspaceDb
      .prepare(
        `SELECT source FROM memories
         WHERE id = ? AND scope = 'workspace' AND superseded_by IS NULL`,
      )
      .get(id) as { source: string | null } | undefined;
    return row?.source ?? null;
  }

  /**
   * Linha ativa mais recente do workspace de uma fonte que tem `line` como
   * linha inteira (ex.: `Mission: m-1`) — identidade estruturada, sem FTS.
   */
  latestActiveWithLine(source: string, line: string): string | null {
    this.#assertOpen();
    const row = this.#workspaceDb
      .prepare(
        `SELECT id FROM memories
         WHERE scope = 'workspace' AND source = ? AND superseded_by IS NULL
           AND instr(char(10) || content || char(10), char(10) || ? || char(10)) > 0
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(source, line) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Memórias trusted ativas do workspace por importância e recência, sem
   * consulta textual: o contexto de quem ainda não tem prompt (instructions
   * do MCP do "+ Pane").
   */
  topTrustedWorkspace(limit: number): MemoryRecallHit[] {
    this.#assertOpen();
    const rows = this.#workspaceDb
      .prepare(
        `SELECT id, content, kind, scope, importance, source,
                created_at, updated_at, recall_count, 0 AS rank
         FROM memories
         WHERE scope = 'workspace' AND superseded_by IS NULL
           AND source LIKE 'trusted:%'
         ORDER BY importance DESC, updated_at DESC, id ASC
         LIMIT ?`,
      )
      .all(Math.max(0, Math.min(limit, 32)))
      .map((raw) => memoryRowSchema.parse(raw));
    return rows.map((row) =>
      Object.freeze({
        id: row.id,
        content: row.content,
        kind: row.kind,
        scope: row.scope,
        importance: row.importance,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        recallCount: row.recall_count,
        score: row.importance,
      }),
    );
  }

  /**
   * Índice de provenance das linhas ativas do workspace (id → source/datas),
   * para a tela de Memória mostrar origem e data sem ler a projeção.
   */
  activeWorkspaceMetas(): ReadonlyMap<
    string,
    {
      source: string | null;
      createdAt: number;
      updatedAt: number;
      flags: readonly MemoryFlag[];
      reverify: string | null;
    }
  > {
    this.#assertOpen();
    const rows = this.#workspaceDb
      .prepare(
        `SELECT id, source, created_at, updated_at
         FROM memories
         WHERE scope = 'workspace' AND superseded_by IS NULL`,
      )
      .all() as Array<{
      id: string;
      source: string | null;
      created_at: number;
      updated_at: number;
    }>;
    const flags = this.#flagsFor(this.#workspaceDb, rows.map((row) => row.id));
    return new Map(
      rows.map((row) => {
        const entries = flags.get(row.id) ?? [];
        return [
          row.id,
          {
            source: row.source,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            flags: Object.freeze(entries.map((entry) => entry.flag)),
            reverify: entries.find((entry) => entry.flag === 'reverify')?.detail ?? null,
          },
        ];
      }),
    );
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
    // A passada em voo para no próximo passo e o que ainda estava na janela
    // morre aqui. O SQLite segue a fonte da verdade: a próxima abertura
    // reconcilia a projeção e a próxima gravação reexporta o vault.
    this.#projectionAbort.abort();
    for (const lane of this.#projectionLanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = null;
      lane.batch = null;
    }
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
  /** Opt-in do vault na pasta do projeto; default lê Ajustes (desligado). */
  readonly vaultExportEnabled?: () => boolean;
}

let runtimeOptions: WorkspaceMemoryRuntimeOptions | null = null;
const storesByProject = new Map<string, WorkspaceMemoryStore>();

/**
 * "Memória visível no projeto (abre no Obsidian)" — Ajustes, padrão
 * DESLIGADO (F-806). Fora do Electron/sem settings: desligado.
 */
function defaultVaultExportEnabled(): boolean {
  try {
    // Require tardio: o settings-store carrega `electron` no topo.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const settings = require('../persistence/settings-store') as {
      getOrchSettings?: () => { workspaceMemoryVaultExport?: boolean };
    };
    return settings.getOrchSettings?.().workspaceMemoryVaultExport === true;
  } catch {
    return false;
  }
}

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
  // F-806: a raiz do vault é a do PRIMEIRO escopo que abriu o store neste
  // processo (o workspace aberto); leituras a partir de worktrees de abas
  // nunca a movem.
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
    ...(scope.rootRealPath ? { workspaceRoot: scope.rootRealPath } : {}),
    ...(runtimeOptions.now ? { now: runtimeOptions.now } : {}),
    ...(runtimeOptions.vaultExportEnabled
      ? { vaultExportEnabled: runtimeOptions.vaultExportEnabled }
      : {}),
  });
  storesByProject.set(scope.projectId, store);
  // First open after boot is a retry opportunity, independently of new handoffs.
  if (store.pendingRetentions().length > 0) {
    void import('./trusted-memory').then(({ retryPendingMemoryRetentions }) =>
      retryPendingMemoryRetentions(scope as ProjectExecutionScope),
    ).catch(() => { console.warn('[memory] pending retention replay unavailable'); });
  }
  return store;
}

/**
 * Shutdown (F-764): a projeção anda fora do caminho da gravação. Antes de
 * sair, dá às passadas pendentes de todos os stores um teto curto para
 * alcançar o SQLite. Nunca rejeita e nunca segura o quit além do teto.
 */
export async function flushWorkspaceMemoryProjections(
  timeoutMs = 2_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        [...storesByProject.values()].map((store) =>
          store.flushProjections().catch(() => undefined),
        ),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

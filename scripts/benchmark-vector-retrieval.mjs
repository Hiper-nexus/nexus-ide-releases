#!/usr/bin/env node
/**
 * Vector retrieval scale benchmark — decides whether memory recall needs a
 * vector index extension, with measurements instead of intuition.
 *
 *   node scripts/benchmark-vector-retrieval.mjs
 *   VECTOR_BENCH_ROWS=50000 VECTOR_BENCH_DIM=384 node scripts/benchmark-vector-retrieval.mjs
 *
 * It builds a throwaway SQLite database carrying the REAL schema from
 * src/main/memory/workspace-memory.ts (memories + external-content memories_fts
 * plus the ai/ad/au triggers), fills it with synthetic memories at the real
 * MAX_MEMORY_CONTENT_BYTES ceiling, and times the real recall query. Then it
 * times brute-force cosine top-k over a packed Float32Array at k equal to the
 * real RECALL_CANDIDATE_POOL. Both numbers come from the same row count, so the
 * comparison is the one that matters: what a vector channel would ADD to a
 * recall that already costs what the bm25 column says.
 *
 * Why this script exists rather than just a decision
 * --------------------------------------------------
 * The plan for semantic memory search assumed sqlite-vec. That assumption is
 * load-bearing and cheap to get wrong in either direction: adding a native
 * loadable extension puts a per-platform binary, a loadExtension call at every
 * database open, and a new startup failure mode into the rebuild:electron path,
 * while NOT adding it means recall degrades at some row count nobody measured.
 * So the crossover is measured and committed. Re-run this before revisiting the
 * decision; docs/qa/items/F-506.md records the conclusion and its evidence.
 *
 * Requires better-sqlite3 built for Node, not for Electron. If the require
 * fails with an ABI error, run `npm run rebuild:node` first — that is what
 * scripts/check-node-natives.mjs guards in pretest.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Values taken from src/main/memory/workspace-memory.ts so the benchmark cannot
// silently drift away from the thing it is measuring.
const MAX_MEMORY_CONTENT_BYTES = 8_192; // workspace-memory.ts:42
const RECALL_CANDIDATE_POOL = 64; // workspace-memory.ts:56
const DIRECTORY_MODE = 0o700; // workspace-memory.ts:53
const DATABASE_MODE = 0o600; // workspace-memory.ts:54

const ROWS = Number(process.env.VECTOR_BENCH_ROWS ?? 10_000);
const DIM = Number(process.env.VECTOR_BENCH_DIM ?? 384);
const QUERY_RUNS = Number(process.env.VECTOR_BENCH_RUNS ?? 20);
/** Perceptibility budget for the whole vector channel, not just the scan. */
const VECTOR_BUDGET_MS = Number(process.env.VECTOR_BENCH_BUDGET_MS ?? 16);
const CONTENT_BYTES = Number(
  process.env.VECTOR_BENCH_CONTENT_BYTES ?? Math.min(MAX_MEMORY_CONTENT_BYTES, 1_200),
);

const KINDS = ['fact', 'decision', 'preference', 'note'];

/**
 * Vocabulary size is a benchmark parameter, not a detail: FTS5 cost is driven by
 * posting-list length, so a 24-word corpus makes every term common and inflates
 * MATCH far beyond what real memory text costs. 2000 distinct terms with a
 * Zipf-ish skew is the realistic shape — a few hot words, a long tail — and is
 * what the committed baseline uses. Lowering it makes the lexical channel look
 * worse than it is; the vector channel is unaffected either way.
 */
const VOCAB_SIZE = Number(process.env.VECTOR_BENCH_VOCAB ?? 2_000);
/** Seeds that must stay present so a query always matches something. */
const ANCHOR_TERMS = [
  'worktree', 'missão', 'agente', 'terminal', 'diff', 'revisão', 'token', 'custo',
  'sandbox', 'hook', 'pane', 'handoff', 'orquestrador', 'pty', 'commit', 'branch',
];

function buildVocabulary(size) {
  const words = [...ANCHOR_TERMS];
  for (let i = words.length; i < size; i += 1) words.push(`termo${i}`);
  return words;
}

/**
 * Zipf-ish draw: index 0 is hottest. Keeps a few high-frequency terms (which is
 * what makes an FTS5 posting list long) without making every term one.
 */
function pickVocabularyIndex(rng, size) {
  const u = rng();
  return Math.min(size - 1, Math.floor(size * u * u * u));
}

function makeVocabularySentence(rng, vocabulary) {
  const words = [];
  const length = 6 + Math.floor(rng() * 10);
  for (let i = 0; i < length; i += 1) {
    words.push(vocabulary[pickVocabularyIndex(rng, vocabulary.length)]);
  }
  return words.join(' ');
}

/** Deterministic PRNG so a re-run compares against the previous run. */
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeContent(rng, index, vocabulary) {
  const sentences = [];
  let bytes = 0;
  while (bytes < CONTENT_BYTES) {
    const sentence = makeVocabularySentence(rng, vocabulary);
    sentences.push(sentence);
    bytes += Buffer.byteLength(sentence, 'utf8') + 1;
  }
  return `memória ${index}: ${sentences.join('. ')}`.slice(0, MAX_MEMORY_CONTENT_BYTES);
}

async function loadBetterSqlite3() {
  try {
    // Dynamic so an ABI mismatch becomes this script's message rather than an
    // unhandled rejection at import time.
    const module = await import('better-sqlite3');
    const Database = module.default ?? module;
    if (typeof Database !== 'function') {
      throw new Error('better-sqlite3 did not export a database constructor');
    }
    return Database;
  } catch (error) {
    throw new Error(
      `cannot load better-sqlite3 under Node (${error.message}). ` +
        'Run `npm run rebuild:node` if it is currently built for Electron.',
      { cause: error },
    );
  }
}

async function buildDatabase(directory, rows, rng) {
  const Database = await loadBetterSqlite3();
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const dbPath = path.join(directory, 'benchmark.db');
  const db = new Database(dbPath, { timeout: 5_000 });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  fs.chmodSync(dbPath, DATABASE_MODE);

  // Verbatim from workspace-memory.ts SCHEMA, minus the superseded/trusted
  // columns the benchmark does not exercise.
  db.exec(`
    CREATE TABLE memories (
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
    CREATE UNIQUE INDEX idx_memories_hash_active
      ON memories(content_hash) WHERE superseded_by IS NULL;
    CREATE INDEX idx_memories_kind_active
      ON memories(kind) WHERE superseded_by IS NULL;
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, content='memories', content_rowid='rowid'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  const insert = db.prepare(
    `INSERT INTO memories
       (id, content, content_hash, kind, scope, importance, source, created_at, updated_at)
     VALUES (@id, @content, @hash, @kind, 'workspace', @importance, 'benchmark', @now, @now)`,
  );
  const now = Date.now();
  const insertAll = db.transaction((entries) => {
    for (const entry of entries) insert.run(entry);
  });

  const entries = [];
  const vocabulary = buildVocabulary(VOCAB_SIZE);
  for (let i = 0; i < rows; i += 1) {
    entries.push({
      id: `mem-${i}`,
      content: makeContent(rng, i, vocabulary),
      hash: `hash-${i}`,
      kind: KINDS[i % KINDS.length],
      importance: 1 + (i % 5),
      now,
    });
  }
  const buildStarted = process.hrtime.bigint();
  insertAll(entries);
  const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;

  return { db, dbPath, buildMs };
}

/** The real recall query, shape and pool size taken from workspace-memory.ts. */
function timeBm25Recall(db, queries) {
  const statement = db.prepare(
    `SELECT m.id, m.content, m.kind, m.scope, m.importance, m.source,
            m.created_at, m.updated_at, m.recall_count,
            bm25(memories_fts) AS rank
     FROM memories_fts
     JOIN memories m ON m.rowid = memories_fts.rowid
     WHERE memories_fts MATCH ?
       AND m.superseded_by IS NULL
     ORDER BY rank
     LIMIT ?`,
  );
  // Warm once so the first-run page-cache cost is not what gets reported.
  statement.get(queries[0], RECALL_CANDIDATE_POOL);
  const samples = [];
  for (let run = 0; run < QUERY_RUNS; run += 1) {
    const query = queries[run % queries.length];
    const started = process.hrtime.bigint();
    const rows = statement.all(query, RECALL_CANDIDATE_POOL);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (rows.length === 0 && run === 0) {
      throw new Error(`bm25 recall matched nothing for "${query}"; corpus is not lexical`);
    }
  }
  return samples;
}

/**
 * Min-heap of size k over (score, index), so top-k costs O(n log k) rather than
 * a full O(n log n) sort. Without this the selection, not the dot products,
 * would dominate the measurement at large n.
 */
function cosineTopK(vectors, dim, query, k) {
  const heapScore = new Float64Array(k);
  const heapIndex = new Int32Array(k);
  let size = 0;

  const siftDown = (start) => {
    let i = start;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= size) return;
      const right = left + 1;
      let smallest = left;
      if (right < size && heapScore[right] < heapScore[left]) smallest = right;
      if (heapScore[smallest] >= heapScore[i]) return;
      const s = heapScore[i];
      heapScore[i] = heapScore[smallest];
      heapScore[smallest] = s;
      const x = heapIndex[i];
      heapIndex[i] = heapIndex[smallest];
      heapIndex[smallest] = x;
      i = smallest;
    }
  };

  const count = vectors.length / dim;
  for (let v = 0; v < count; v += 1) {
    const offset = v * dim;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += vectors[offset + i] * query[i];
    if (size < k) {
      heapScore[size] = dot;
      heapIndex[size] = v;
      size += 1;
      for (let i = size - 1; i > 0; ) {
        const parent = (i - 1) >> 1;
        if (heapScore[parent] <= heapScore[i]) break;
        const s = heapScore[parent];
        heapScore[parent] = heapScore[i];
        heapScore[i] = s;
        const x = heapIndex[parent];
        heapIndex[parent] = heapIndex[i];
        heapIndex[i] = x;
        i = parent;
      }
    } else if (dot > heapScore[0]) {
      heapScore[0] = dot;
      heapIndex[0] = v;
      siftDown(0);
    }
  }

  const out = [];
  for (let i = 0; i < size; i += 1) out.push({ index: heapIndex[i], score: heapScore[i] });
  return out.sort((a, b) => b.score - a.score);
}

function timeCosine(rows, dim, rng) {
  const vectors = new Float32Array(rows * dim);
  for (let i = 0; i < vectors.length; i += 1) vectors[i] = rng() * 2 - 1;
  // Normalise so a dot product is a cosine, which is what a real store does at
  // write time rather than per query.
  for (let v = 0; v < rows; v += 1) {
    const offset = v * dim;
    let sum = 0;
    for (let i = 0; i < dim; i += 1) sum += vectors[offset + i] * vectors[offset + i];
    const inverse = 1 / Math.sqrt(sum);
    for (let i = 0; i < dim; i += 1) vectors[offset + i] *= inverse;
  }

  const query = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i += 1) {
    query[i] = rng() * 2 - 1;
    sum += query[i] * query[i];
  }
  const inverse = 1 / Math.sqrt(sum);
  for (let i = 0; i < dim; i += 1) query[i] *= inverse;

  cosineTopK(vectors, dim, query, RECALL_CANDIDATE_POOL); // warm
  const samples = [];
  for (let run = 0; run < QUERY_RUNS; run += 1) {
    const started = process.hrtime.bigint();
    cosineTopK(vectors, dim, query, RECALL_CANDIDATE_POOL);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { samples, vectorBytes: vectors.byteLength };
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

async function main() {
  const rng = makeRng(0x5eed);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vector-bench-'));
  let db;
  // process.exit inside try would skip the finally and leak the temp database,
  // so the code is decided here and exited with after cleanup.
  let exitCode = 0;

  // The two halves are deliberately independent. The decision this script
  // exists to support — does memory recall need a vector index extension? — is
  // answered by the cosine half alone, which is pure JS. The lexical half needs
  // better-sqlite3, whose ABI legitimately flips between Node and Electron
  // during normal development (rebuild:node vs rebuild:electron), so a mismatch
  // must not take the vector measurement down with it.
  let lexical;
  try {
    const built = await buildDatabase(directory, ROWS, rng);
    db = built.db;

    const queries = [];
    for (let i = 0; i < 8; i += 1) {
      // Anchor terms only: they are guaranteed present in the corpus, so a
      // zero-match run means the query is broken rather than the term absent.
      queries.push(
        `${ANCHOR_TERMS[i % ANCHOR_TERMS.length]} ${ANCHOR_TERMS[(i * 7 + 3) % ANCHOR_TERMS.length]}`,
      );
    }

    const bm25 = timeBm25Recall(db, queries);
    lexical = {
      sqlite: db.prepare('select sqlite_version() v').get().v,
      corpusBuildMs: Number(built.buildMs.toFixed(1)),
      bm25RecallMs: {
        p50: Number(percentile(bm25, 50).toFixed(3)),
        p95: Number(percentile(bm25, 95).toFixed(3)),
        max: Number(Math.max(...bm25).toFixed(3)),
      },
    };
  } catch (error) {
    lexical = {
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const cosine = timeCosine(ROWS, DIM, rng);
    const cosineP50 = percentile(cosine.samples, 50);
    const withinBudget = cosineP50 <= VECTOR_BUDGET_MS;
    const report = {
      rows: ROWS,
      dim: DIM,
      topK: RECALL_CANDIDATE_POOL,
      contentBytesTarget: CONTENT_BYTES,
      vocabSize: VOCAB_SIZE,
      runs: QUERY_RUNS,
      budgetMs: VECTOR_BUDGET_MS,
      lexical,
      cosineTopKMs: {
        p50: Number(cosineP50.toFixed(3)),
        p95: Number(percentile(cosine.samples, 95).toFixed(3)),
        max: Number(Math.max(...cosine.samples).toFixed(3)),
      },
      vectorStoreBytes: cosine.vectorBytes,
      verdict: {
        bruteForceWithinBudget: withinBudget,
        needsVectorIndexExtension: !withinBudget,
        note: withinBudget
          ? `brute-force cosine top-${RECALL_CANDIDATE_POOL} fits in ${VECTOR_BUDGET_MS}ms at ${ROWS} rows; an index extension would add a native binary and a startup failure mode to buy nothing`
          : `brute-force cosine top-${RECALL_CANDIDATE_POOL} exceeds ${VECTOR_BUDGET_MS}ms at ${ROWS} rows; revisit an index extension`,
      },
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        { ok: false, rows: ROWS, dim: DIM, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
    );
    exitCode = 1;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

void main();

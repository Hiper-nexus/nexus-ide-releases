import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MEMORY_CONTENT_BYTES,
  resolveWorkspaceMemoryPaths,
  WorkspaceMemoryStore,
} from './workspace-memory';

const dirs: string[] = [];
const stores: WorkspaceMemoryStore[] = [];

function makeStore(now?: () => number): WorkspaceMemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-'));
  dirs.push(root);
  const store = new WorkspaceMemoryStore({
    workspaceDbPath: path.join(root, 'workspace', 'memory.sqlite3'),
    globalDbPath: path.join(root, 'memory-global.sqlite3'),
    ...(now ? { now } : {}),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // já fechado pelo próprio teste
    }
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace memory engine (FTS5)', () => {
  it('canário: better-sqlite3 do repo cria tabela virtual FTS5', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (
      file: string,
    ) => import('better-sqlite3').Database;
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE canary USING fts5(content)');
      db.prepare('INSERT INTO canary(content) VALUES (?)').run('fts five ok');
      const row = db
        .prepare("SELECT content FROM canary WHERE canary MATCH 'five'")
        .get() as { content: string };
      expect(row.content).toBe('fts five ok');
    } finally {
      db.close();
    }
  });

  it('faz roundtrip retain+recall com ranking: match completo > parcial', () => {
    const store = makeStore();
    store.retain({
      content: 'deploy pipeline uses docker swarm on staging',
      kind: 'fact',
    });
    store.retain({
      content: 'docker desktop is flaky on the intel mac',
      kind: 'fact',
    });
    const hits = store.recall({ query: 'docker swarm staging' });
    expect(hits.length).toBe(2);
    expect(hits[0].content).toContain('docker swarm on staging');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('desempata por importância: 5 vence 1 com o mesmo match', () => {
    const store = makeStore();
    store.retain({
      content: 'prefer tabs over spaces alpha',
      kind: 'preference',
      importance: 1,
    });
    store.retain({
      content: 'prefer tabs over spaces bravo',
      kind: 'preference',
      importance: 5,
    });
    const hits = store.recall({ query: 'prefer tabs spaces' });
    expect(hits.length).toBe(2);
    expect(hits[0].importance).toBe(5);
    expect(hits[0].content).toContain('bravo');
  });

  it('deduplica retain idêntico renovando updated_at em vez de duplicar', () => {
    let clock = 1_000_000;
    const store = makeStore(() => clock);
    const first = store.retain({ content: 'Node 22 is the build baseline' });
    clock = 2_000_000;
    // Mesmo conteúdo após normalização (caixa + espaços) → dedupe.
    const second = store.retain({
      content: '  node 22   is the BUILD baseline ',
    });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    const hits = store.recall({ query: 'node build baseline' });
    expect(hits.length).toBe(1);
    expect(hits[0].updatedAt).toBe(2_000_000);
    expect(store.stats().workspace.total).toBe(1);
  });

  it('forget marca superseded e a memória some do recall', () => {
    const store = makeStore();
    const { id } = store.retain({ content: 'the API key rotation is monthly' });
    expect(store.recall({ query: 'rotation monthly' }).length).toBe(1);
    expect(store.forget(id)).toBe(true);
    expect(store.recall({ query: 'rotation monthly' }).length).toBe(0);
    // Tombstone permanece auditável nas contagens totais.
    const stats = store.stats();
    expect(stats.workspace.total).toBe(1);
    expect(stats.workspace.active).toBe(0);
    // Esquecer duas vezes é no-op.
    expect(store.forget(id)).toBe(false);
  });

  it('retain com supersedes substitui a memória antiga no recall', () => {
    const store = makeStore();
    const old = store.retain({ content: 'staging database lives on host alpha' });
    store.retain({
      content: 'staging database lives on host bravo',
      supersedes: old.id,
    });
    const hits = store.recall({ query: 'staging database host' });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('bravo');
  });

  it('escopa workspace vs global: recall consulta workspace primeiro e completa com global', () => {
    const store = makeStore();
    store.retain({ content: 'release checklist includes smoke tests', scope: 'global' });
    store.retain({ content: 'release branch cut happens on fridays' });
    const hits = store.recall({ query: 'release' });
    expect(hits.length).toBe(2);
    // Workspace vem antes mesmo que o global tenha match igual ou melhor.
    expect(hits[0].scope).toBe('workspace');
    expect(hits[1].scope).toBe('global');
    const localOnly = store.recall({ query: 'release', includeGlobal: false });
    expect(localOnly.length).toBe(1);
    expect(localOnly[0].scope).toBe('workspace');
  });

  it('filtra por kind no recall', () => {
    const store = makeStore();
    store.retain({ content: 'linting decision: eslint strict profile', kind: 'decision' });
    store.retain({ content: 'eslint autofix breaks generated files', kind: 'fact' });
    const hits = store.recall({ query: 'eslint', kind: 'decision' });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('decision');
  });

  it('rejeita conteúdo acima de 8KB', () => {
    const store = makeStore();
    const oversized = 'x'.repeat(MAX_MEMORY_CONTENT_BYTES + 1);
    expect(() => store.retain({ content: oversized })).toThrow(/8192 bytes/);
  });

  it('redige segredos antes de persistir', () => {
    const store = makeStore();
    const result = store.retain({
      content: 'ci deploy uses token ghp_abcdefghijklmnop1234 for github',
    });
    expect(result.redacted).toBe(true);
    const hits = store.recall({ query: 'ci deploy github' });
    expect(hits.length).toBe(1);
    expect(hits[0].content).not.toContain('ghp_abcdefghijklmnop1234');
    expect(hits[0].content).toContain('[REDACTED]');
  });

  it('incrementa recall_count a cada recall', () => {
    const store = makeStore();
    store.retain({ content: 'vitest workers are capped at four' });
    const first = store.recall({ query: 'vitest workers' });
    expect(first[0].recallCount).toBe(1);
    const second = store.recall({ query: 'vitest workers' });
    expect(second[0].recallCount).toBe(2);
    expect(store.stats().workspace.totalRecalls).toBe(2);
  });

  it('valida entradas: importance fora de 1..5 e query vazia', () => {
    const store = makeStore();
    expect(() =>
      store.retain({ content: 'ok', importance: 9 }),
    ).toThrow();
    expect(store.recall({ query: '!!! ???' })).toEqual([]);
  });

  it('resolveWorkspaceMemoryPaths deriva paths por digest, nunca pelo path bruto', () => {
    const paths = resolveWorkspaceMemoryPaths('/tmp/base', {
      projectId: 'proj-a',
    });
    const other = resolveWorkspaceMemoryPaths('/tmp/base', {
      projectId: 'proj-b',
    });
    expect(paths.workspaceDbPath).not.toContain('proj-a');
    expect(paths.workspaceDbPath).not.toBe(other.workspaceDbPath);
    expect(paths.globalDbPath).toBe(other.globalDbPath);
  });
});

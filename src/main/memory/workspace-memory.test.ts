import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
  MAX_MEMORY_CONTENT_BYTES,
  resolveWorkspaceMemoryPaths,
  WorkspaceMemoryStore,
} from './workspace-memory';

const dirs: string[] = [];
const stores: WorkspaceMemoryStore[] = [];

function makeStore(
  now?: () => number,
  options: {
    readonly projectionRoot?: string;
    readonly workspaceRoot?: string;
    /** F-806: o vault na pasta do projeto é opt-in; os testes do vault ligam. */
    readonly vaultExportEnabled?: () => boolean;
  } = {},
): WorkspaceMemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-'));
  dirs.push(root);
  const store = new WorkspaceMemoryStore({
    workspaceDbPath: path.join(root, 'workspace', 'memory.sqlite3'),
    globalDbPath: path.join(root, 'memory-global.sqlite3'),
    ...(options.projectionRoot
      ? { projectionRoot: options.projectionRoot }
      : {}),
    ...(options.workspaceRoot
      ? { workspaceRoot: options.workspaceRoot }
      : {}),
    ...(options.vaultExportEnabled
      ? { vaultExportEnabled: options.vaultExportEnabled }
      : {}),
    ...(now ? { now } : {}),
  });
  stores.push(store);
  return store;
}

const vaultOn = () => true;

afterEach(() => {
  disposeWorkspaceMemoryStores();
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- carregado dentro do canário: binário nativo com ABI errado derruba só este teste, não o arquivo
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

  it('F-1349: identificador hifenado casa como frase — recall("F-1301") não traz o F-918', () => {
    const store = makeStore();
    store.retain({ content: 'F-918 corrigido: recibo de entrega do pane duplicado', kind: 'fact' });
    store.retain({ content: 'F-1301 corrigido: WIP alheio anterior à missão não bloqueia a conclusão', kind: 'fact' });
    store.retain({ content: 'porta 1301 reservada para o preview local', kind: 'fact' });
    const hits = store.recall({ query: 'F-1301' });
    expect(hits.map((hit) => hit.content.slice(0, 6))).toEqual(['F-1301']);
    // Token de 1 caractere sozinho não vira consulta que casa tudo.
    expect(store.recall({ query: 'F' })).toEqual([]);
    // Frase + palavra solta continuam combinando por OR.
    expect(store.recall({ query: 'F-918 preview' }).map((hit) => hit.content.slice(0, 5)).sort())
      .toEqual(['F-918', 'porta']);
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

  it('projeta a fonte SQLite em Markdown determinístico e remove ao esquecer', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-wm-projection-'),
    );
    dirs.push(projectRoot);
    const store = makeStore(undefined, { projectionRoot: projectRoot });

    const retained = store.retain({
      content: '# Regra de arquitetura\n\nNão duplicar serviços de domínio.',
      kind: 'decision',
      importance: 5,
      source: 'operator:decision',
    });
    const projectionPath = path.join(
      projectRoot,
      '.nexus-memory',
      `${retained.id}.md`,
    );

    // F-764: a projeção é agendada fora do caminho da gravação.
    await store.flushProjections();
    expect(fs.readFileSync(projectionPath, 'utf8')).toMatch(
      /canonical: sqlite-fts5/,
    );
    expect(fs.readFileSync(projectionPath, 'utf8')).toContain(
      'Não duplicar serviços de domínio.',
    );

    // A projeção nunca vira segunda autoridade: uma nova sincronização
    // sobrescreve edição manual com o conteúdo canônico do SQLite.
    fs.writeFileSync(projectionPath, '# conteúdo adulterado');
    await store.syncProjections();
    expect(fs.readFileSync(projectionPath, 'utf8')).not.toContain(
      'conteúdo adulterado',
    );

    expect(store.forget(retained.id)).toBe(true);
    await store.flushProjections();
    expect(fs.existsSync(projectionPath)).toBe(false);
  });

  it('não projeta memórias globais em um workspace específico', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-wm-global-projection-'),
    );
    dirs.push(projectRoot);
    const store = makeStore(undefined, { projectionRoot: projectRoot });
    const retained = store.retain({
      content: 'Preferência global do operador',
      kind: 'preference',
      scope: 'global',
    });
    await store.flushProjections();

    expect(
      fs.existsSync(
        path.join(projectRoot, '.nexus-memory', `${retained.id}.md`),
      ),
    ).toBe(false);
  });

  it('F-806: projeta em userData sempre; a pasta do projeto só recebe o vault com o opt-in', async () => {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-wm-runtime-base-'),
    );
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-wm-clean-checkout-'),
    );
    dirs.push(baseDir, projectRoot);
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    const scope = {
      version: 1 as const,
      installationId: 'installation-a',
      projectId: 'project-clean-checkout',
      checkoutId: 'checkout-a',
      rootRealPath: projectRoot,
      identitySource: 'manifest' as const,
    };

    // Padrão (opt-in desligado): a gravação nunca cria nada no checkout.
    configureWorkspaceMemory({ baseDir });
    const silent = getWorkspaceMemoryStore(scope);
    const retained = silent.retain({
      content: '# Decisão\n\nUsar uma única camada de domínio.',
      kind: 'decision',
      source: 'trusted:operator-decision',
    });
    await silent.flushProjections();
    const exported = path.join(fs.realpathSync(projectRoot), '.nexus-memory');
    expect(fs.existsSync(exported)).toBe(false);
    expect(silent.projectionRoot).toContain(path.join(baseDir, 'projections'));
    expect(
      fs.existsSync(path.join(silent.projectionRoot, '.nexus-memory', `${retained.id}.md`)),
    ).toBe(true);

    // Opt-in ligado ("Memória visível no projeto"): o vault vai para o
    // checkout, fora do git — agendado fora do caminho da gravação (F-764).
    configureWorkspaceMemory({ baseDir, vaultExportEnabled: vaultOn, coordinationScopeFor: () => ({ rootRealPath: projectRoot }) });
    const store = getWorkspaceMemoryStore(scope);
    store.retain({
      content: '# Decisão\n\nUsar uma única camada de domínio.',
      kind: 'decision',
      source: 'trusted:operator-decision',
    });
    await store.flushProjections();
    expect(fs.existsSync(exported)).toBe(true);
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }),
    ).toBe('');

    // O vault usa nomes legíveis; a exportação explícita devolve a mesma raiz.
    expect(await store.exportProjectionsToWorkspace(projectRoot)).toBe(exported);
    const vaultNames = fs.readdirSync(exported);
    expect(
      vaultNames.some((name) => name.startsWith('decisao-') && name.endsWith('.md')),
    ).toBe(true);
    expect(vaultNames).toContain('.gitignore');

    const retainedAfterExport = store.retain({
      content: 'Novo fato automático depois do snapshot explícito.',
      kind: 'fact',
      source: 'trusted:accepted-handoff',
    });
    await store.flushProjections();
    expect(
      fs.existsSync(
        path.join(
          store.projectionRoot,
          '.nexus-memory',
          `${retainedAfterExport.id}.md`,
        ),
      ),
    ).toBe(true);
  });

  it('F-806: a raiz do vault é fixa na criação — acesso por outra raiz não a move', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-fixed-root-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-fixed-main-'));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-fixed-worktree-'));
    dirs.push(baseDir, projectRoot, worktree);
    configureWorkspaceMemory({ baseDir, vaultExportEnabled: vaultOn, coordinationScopeFor: () => ({ rootRealPath: projectRoot }) });
    const base = {
      version: 1 as const,
      installationId: 'installation-a',
      projectId: 'project-fixed-root',
      checkoutId: 'checkout-a',
      identitySource: 'manifest' as const,
    };
    const store = getWorkspaceMemoryStore({ ...base, rootRealPath: projectRoot });
    // Leitura/gravação a partir da worktree de uma aba: mesmo store, mesma raiz.
    const viaWorktree = getWorkspaceMemoryStore({ ...base, rootRealPath: worktree });
    expect(viaWorktree).toBe(store);
    expect(store.workspaceRoot).toBe(path.resolve(projectRoot));
    viaWorktree.retain({ content: '# Fixa\n\ncorpo', source: 'operator:note' });
    await store.flushProjections();
    expect(fs.existsSync(path.join(fs.realpathSync(projectRoot), '.nexus-memory'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.nexus-memory'))).toBe(false);
  });

  it('F-806: gravação de contexto read-only/consulta nunca dispara o vault, mesmo com o opt-in', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-readonly-vault-'));
    dirs.push(workspace);
    const store = makeStore(undefined, { workspaceRoot: workspace, vaultExportEnabled: vaultOn });
    store.retainAgentAuthored(
      { content: '# Achado do revisor\n\ncorpo' },
      { source: `agent-authored:pane:${'a'.repeat(64)}` },
      { vault: false, quarantine: 'read-only session' },
    );
    await store.flushProjections();
    expect(fs.existsSync(path.join(workspace, '.nexus-memory'))).toBe(false);
    // A projeção canônica (userData) e o recall seguem normais.
    expect(store.recall({ query: 'revisor achado' })).toHaveLength(1);
    expect(store.recall({ query: 'revisor achado' })[0].flags).toEqual(['quarantine']);
  });

  it('F-807: a exportação para a pasta do projeto espera 2 s de debounce', async () => {
    vi.useFakeTimers();
    try {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-debounce-'));
      dirs.push(workspace);
      const store = makeStore(undefined, { workspaceRoot: workspace, vaultExportEnabled: vaultOn });
      store.retain({ content: '# Lenta\n\ncorpo', source: 'operator:note' });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fs.existsSync(path.join(workspace, '.nexus-memory'))).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      await store.flushProjections();
      expect(fs.existsSync(path.join(fs.realpathSync(workspace), '.nexus-memory'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-807: depois da primeira exportação, cada gravação toca só a nota, o índice e o hub (incremental)', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-incremental-'));
    dirs.push(workspace);
    const store = makeStore(undefined, { workspaceRoot: workspace, vaultExportEnabled: vaultOn });
    for (let i = 0; i < 30; i += 1) {
      store.retain({ content: `# Nota ${i}\n\ncorpo ${i}`, source: 'operator:note' });
    }
    await store.flushProjections();
    const vaultRoot = path.join(fs.realpathSync(workspace), '.nexus-memory');
    expect(fs.readdirSync(vaultRoot).filter((n) => n.endsWith('.md'))).toHaveLength(31);

    const readFile = vi.spyOn(fs.promises, 'readFile');
    const lstat = vi.spyOn(fs.promises, 'lstat');
    try {
      store.retain({ content: '# Nota nova\n\ncorpo novo', source: 'operator:note' });
      await store.flushProjections();
      // Exportação completa relia as 30 notas + índices a cada passada; a
      // incremental lê só .gitignore, a nota nova e o índice do tipo dela.
      const vaultReads = readFile.mock.calls.filter(([file]) =>
        String(file).startsWith(vaultRoot),
      );
      expect(vaultReads.length).toBeLessThanOrEqual(4);
      expect(lstat.mock.calls.filter(([file]) => String(file).startsWith(vaultRoot)).length)
        .toBeLessThanOrEqual(4);
    } finally {
      readFile.mockRestore();
      lstat.mockRestore();
    }
    expect(fs.readdirSync(vaultRoot).filter((n) => n.endsWith('.md'))).toHaveLength(32);
    expect(fs.readFileSync(path.join(vaultRoot, 'INDEX-note.md'), 'utf8')).toContain('Nota nova');
  });

  it('F-807: retain de agente tem limite de taxa por autoridade (20 por 10 min)', () => {
    let clock = 1_000_000;
    const store = makeStore(() => clock);
    const authority = { source: `agent-authored:pane:${'b'.repeat(64)}` };
    for (let i = 0; i < 20; i += 1) {
      store.retainAgentAuthored({ content: `nota ${i} do agente em loop` }, authority);
    }
    expect(() =>
      store.retainAgentAuthored({ content: 'a vigésima primeira' }, authority),
    ).toThrow(/rate limit/);
    // Outra autoridade não é afetada; a janela libera depois de 10 min.
    expect(
      store.retainAgentAuthored(
        { content: 'outro agente grava normalmente' },
        { source: `agent-authored:pane:${'c'.repeat(64)}` },
      ).deduped,
    ).toBe(false);
    clock += 10 * 60_000 + 1;
    expect(store.retainAgentAuthored({ content: 'a vigésima primeira' }, authority).deduped).toBe(false);
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

  it('agent-authored só supersede memória ativa da mesma origem e escopo', () => {
    const store = makeStore();
    const trusted = store.retain({
      content: 'PREVC must stay enabled before final promotion',
      source: 'trusted:architecture-rule',
      kind: 'decision',
    });
    const owned = store.retainAgentAuthored(
      { content: 'worker hypothesis alpha' },
      { source: `agent-authored:mission:${'a'.repeat(64)}` },
    );

    expect(() =>
      store.retainAgentAuthored(
        {
          content: 'poisoned replacement for trusted authority',
          supersedes: trusted.id,
        },
        { source: `agent-authored:mission:${'a'.repeat(64)}` },
      ),
    ).toThrow(/same agent authority and scope/);
    expect(() =>
      store.retainAgentAuthored(
        {
          content: 'foreign worker replacement',
          supersedes: owned.id,
        },
        { source: `agent-authored:mission:${'b'.repeat(64)}` },
      ),
    ).toThrow(/same agent authority and scope/);
    expect(() =>
      store.retainAgentAuthored(
        {
          content: 'cross-scope replacement',
          scope: 'global',
          supersedes: owned.id,
        },
        { source: `agent-authored:mission:${'a'.repeat(64)}` },
      ),
    ).toThrow(/same agent authority and scope/);

    store.retainAgentAuthored(
      {
        content: 'worker hypothesis corrected',
        supersedes: owned.id,
      },
      { source: `agent-authored:mission:${'a'.repeat(64)}` },
    );

    expect(store.recall({ query: 'PREVC final promotion' })).toHaveLength(1);
    const agentHits = store.recall({ query: 'worker hypothesis' });
    expect(agentHits).toHaveLength(1);
    expect(agentHits[0].content).toContain('corrected');
  });

  it('agent-authored forget cannot tombstone trusted or foreign provenance', () => {
    const store = makeStore();
    const sourceA = `agent-authored:pane:${'a'.repeat(64)}`;
    const sourceB = `agent-authored:pane:${'b'.repeat(64)}`;
    const trusted = store.retain({
      content: 'trusted release decision',
      source: 'trusted:operator-decision',
    });
    const owned = store.retainAgentAuthored(
      { content: 'temporary worker note' },
      { source: sourceA },
    );

    expect(
      store.forgetAgentAuthored({
        id: trusted.id,
        scope: 'workspace',
        source: sourceA,
      }),
    ).toBe(false);
    expect(
      store.forgetAgentAuthored({
        id: owned.id,
        scope: 'workspace',
        source: sourceB,
      }),
    ).toBe(false);
    expect(
      store.forgetAgentAuthored({
        id: owned.id,
        scope: 'workspace',
        source: sourceA,
      }),
    ).toBe(true);

    expect(store.recall({ query: 'trusted release decision' })).toHaveLength(1);
    expect(store.recall({ query: 'temporary worker note' })).toEqual([]);
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

  it('recall não incrementa: markRecalled conta só o que foi injetado (F-769)', () => {
    const store = makeStore();
    store.retain({ content: 'vitest workers are capped at four' });
    const first = store.recall({ query: 'vitest workers' });
    expect(first[0].recallCount).toBe(0);
    expect(store.stats().workspace.totalRecalls).toBe(0);
    store.markRecalled(first.map((hit) => hit.id));
    const second = store.recall({ query: 'vitest workers' });
    expect(second[0].recallCount).toBe(1);
    expect(store.stats().workspace.totalRecalls).toBe(1);
    store.markRecalled(['mem-id-que-nao-existe']);
    expect(store.stats().workspace.totalRecalls).toBe(1);
  });

  it('gravação exporta o vault legível .nexus-memory/ no workspace com o opt-in (F-769/F-806)', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-vault-'));
    dirs.push(workspace);
    const store = makeStore(undefined, { workspaceRoot: workspace, vaultExportEnabled: vaultOn });
    const retained = store.retain({
      content: '# Regra do pool\n\nO pool vive em src/main/db/pool.ts.',
      kind: 'decision',
      importance: 4,
      source: 'trusted:architecture-rule',
    });

    const vaultRoot = path.join(fs.realpathSync(workspace), '.nexus-memory');
    // A própria gravação exporta (agendada, F-764) — antes da exportação explícita.
    await store.flushProjections();
    expect(fs.readdirSync(vaultRoot)).toContain('INDEX-decision.md');
    expect(await store.exportProjectionsToWorkspace(workspace)).toBe(vaultRoot);
    expect(fs.readFileSync(path.join(vaultRoot, '.gitignore'), 'utf8')).toBe('*\n');
    const names = fs.readdirSync(vaultRoot);
    const noteName = names.find(
      (name) => name.startsWith('regra-do-pool-') && name.endsWith('.md'),
    );
    expect(noteName).toBeDefined();
    expect(fs.readFileSync(path.join(vaultRoot, noteName!), 'utf8')).toContain(
      '[[src/main/db/pool.ts]]',
    );
    expect(names).toContain('INDEX-decision.md');

    // Esquecer remove a nota do vault; o índice vazio é colhido junto.
    expect(store.forget(retained.id)).toBe(true);
    await store.flushProjections();
    expect(fs.existsSync(path.join(vaultRoot, noteName!))).toBe(false);
    const indexPath = path.join(vaultRoot, 'INDEX-decision.md');
    if (fs.existsSync(indexPath)) {
      expect(fs.readFileSync(indexPath, 'utf8')).not.toContain('regra-do-pool');
    }
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
    expect(paths.projectionRoot).not.toContain('proj-a');
    expect(paths.projectionRoot).not.toBe(other.projectionRoot);
    expect(paths.projectionRoot).toContain(path.join('base', 'projections'));
  });
});

describe('projeção fora do caminho da gravação (F-764)', () => {
  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function projectionFile(projectRoot: string, id: string): string {
    return path.join(projectRoot, '.nexus-memory', `${id}.md`);
  }

  it('retain e forget não fazem nenhuma chamada síncrona de fs', async () => {
    const projectRoot = tempDir('nexus-wm-nosync-projection-');
    const workspace = tempDir('nexus-wm-nosync-vault-');
    const store = makeStore(undefined, {
      projectionRoot: projectRoot,
      workspaceRoot: workspace,
      vaultExportEnabled: vaultOn,
    });
    // A primeira passada (reconciliação completa) fica fora da medição.
    store.retain({ content: '# Base\n\ncorpo base' });
    await store.flushProjections();

    const blocking = [
      vi.spyOn(fs, 'readdirSync'),
      vi.spyOn(fs, 'lstatSync'),
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs, 'mkdirSync'),
      vi.spyOn(fs, 'realpathSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'renameSync'),
      vi.spyOn(fs, 'unlinkSync'),
    ];
    const touched: string[] = [];
    try {
      const first = store.retain({ content: '# Nova\n\ncorpo novo', kind: 'decision' });
      const second = store.retain({
        content: '# Substituta\n\ncorpo substituto',
        supersedes: first.id,
      });
      store.forget(second.id);
      touched.push(first.id, second.id);
      for (const spy of blocking) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of blocking) spy.mockRestore();
    }

    // E o disco alcança o SQLite depois, fora do caminho da gravação.
    await store.flushProjections();
    for (const id of touched) {
      expect(fs.existsSync(projectionFile(projectRoot, id))).toBe(false);
    }
    expect(
      fs
        .readdirSync(path.join(fs.realpathSync(workspace), '.nexus-memory'))
        .filter((name) => name.endsWith('.md') && !name.startsWith('INDEX-')),
    ).toEqual([expect.stringMatching(/^base-/)]);
  });

  it('muitas gravações seguidas viram poucas varreduras (coalescência por raiz)', async () => {
    const projectRoot = tempDir('nexus-wm-burst-projection-');
    const workspace = tempDir('nexus-wm-burst-vault-');
    const store = makeStore(undefined, {
      projectionRoot: projectRoot,
      workspaceRoot: workspace,
      vaultExportEnabled: vaultOn,
    });
    store.retain({ content: '# Base\n\ncorpo base' });
    await store.flushProjections();

    const readdir = vi.spyOn(fs.promises, 'readdir');
    try {
      for (let i = 0; i < 40; i += 1) {
        store.retain({ content: `# Nota ${i}\n\ncorpo ${i}` });
      }
      expect(readdir).not.toHaveBeenCalled();
      await store.flushProjections();
      // Antes: duas varreduras síncronas POR gravação (assinatura da projeção
      // + exportação do vault) = 80. Agora: uma passada por raiz.
      expect(readdir.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      readdir.mockRestore();
    }
    expect(
      fs
        .readdirSync(path.join(projectRoot, '.nexus-memory'))
        .filter((name) => name.endsWith('.md')),
    ).toHaveLength(41);
    expect(
      fs
        .readdirSync(path.join(fs.realpathSync(workspace), '.nexus-memory'))
        .filter((name) => name.endsWith('.md') && !name.startsWith('INDEX-')),
    ).toHaveLength(41);
  });

  it('gravação e remoção do mesmo id na mesma janela convergem na ordem certa', async () => {
    const projectRoot = tempDir('nexus-wm-order-');
    let clock = 1_000;
    const store = makeStore(() => clock, { projectionRoot: projectRoot });
    const kept = store.retain({ content: '# Fica\n\ncorpo que fica' });
    const gone = store.retain({ content: '# Sai\n\ncorpo que sai' });
    expect(store.forget(gone.id)).toBe(true);
    clock = 2_000;
    // Dedupe renova updated_at na mesma janela: vale a versão mais nova.
    expect(store.retain({ content: '# Fica\n\ncorpo que fica' }).id).toBe(kept.id);
    await store.flushProjections();

    expect(fs.existsSync(projectionFile(projectRoot, gone.id))).toBe(false);
    expect(fs.readFileSync(projectionFile(projectRoot, kept.id), 'utf8')).toContain(
      'updatedAt: 2000',
    );

    // Em janelas separadas, a remoção que chega depois também vence.
    expect(store.forget(kept.id)).toBe(true);
    await store.flushProjections();
    expect(fs.existsSync(projectionFile(projectRoot, kept.id))).toBe(false);
  });

  it('falha na projeção vira warn e nunca derruba a gravação', async () => {
    const workspace = tempDir('nexus-wm-besteffort-');
    // `.nexus-memory` ocupado por um arquivo: a exportação do vault falha.
    fs.writeFileSync(path.join(workspace, '.nexus-memory'), 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = makeStore(undefined, { workspaceRoot: workspace, vaultExportEnabled: vaultOn });
      const retained = store.retain({ content: 'fato que precisa sobreviver' });
      await store.flushProjections();

      expect(store.recall({ query: 'sobreviver' }).map((hit) => hit.id)).toEqual([
        retained.id,
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not export readable vault'),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('edição do operador é ingerida antes da passada de uma gravação posterior', async () => {
    const projectRoot = tempDir('nexus-wm-edit-then-write-');
    let clock = 1_000;
    const store = makeStore(() => clock, { projectionRoot: projectRoot });
    const edited = store.retain({
      content: '# Nota\n\ncorpo original',
      source: 'operator:note',
    });
    await store.flushProjections();
    const file = projectionFile(projectRoot, edited.id);
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace('corpo original', 'corpo editado pelo operador'),
    );
    // Temporário órfão de um crash entre open() e rename().
    const orphan = `${file}.0123456789abcdef.tmp`;
    fs.writeFileSync(orphan, 'partial write');
    clock = 2_000;

    // Outra gravação qualquer: a passada dela vê o diretório mexido e ingere
    // ANTES de escrever — a edição não é apagada nem absorvida.
    store.retain({ content: '# Outra\n\noutro corpo', source: 'operator:note' });
    await store.flushProjections();

    expect(store.recall({ query: 'editado' }).map((hit) => hit.id)).toEqual([
      edited.id,
    ]);
    expect(fs.readFileSync(file, 'utf8')).toContain('corpo editado pelo operador');
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('close() derruba o que ainda estava na janela sem warn nem gravação', async () => {
    const projectRoot = tempDir('nexus-wm-close-');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = makeStore(undefined, { projectionRoot: projectRoot });
      const retained = store.retain({ content: '# Na janela\n\ncorpo' });
      store.close();
      await store.flushProjections();
      expect(fs.existsSync(projectionFile(projectRoot, retained.id))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

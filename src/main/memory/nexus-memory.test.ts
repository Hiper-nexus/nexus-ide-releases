import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backlinks,
  exportMemoryVault,
  exportMemoryVaultIncremental,
  extractWikilinks,
  linkifyFilePaths,
  listMemoryNotes,
  removeCanonicalMemoryProjection,
  resolveMemoryRoot,
  searchMemory,
  syncCanonicalMemoryProjections,
  wikilinkCompletions,
  writeCanonicalMemoryProjection,
} from './nexus-memory';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('nexus memory', () => {
  it('does not follow a pre-planted canonical note symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-create-link-'));
    dirs.push(root);
    const memoryRoot = path.join(root, '.nexus-memory');
    const outside = path.join(root, 'outside.txt');
    fs.mkdirSync(memoryRoot);
    fs.writeFileSync(outside, 'DO NOT REPLACE');
    const id = 'mem-11111111-1111-4111-8111-111111111111';
    fs.symlinkSync(
      outside,
      path.join(memoryRoot, `${id}.md`),
    );

    const note = await writeCanonicalMemoryProjection(root, {
      id,
      content: '# Same\n\nsafe',
      kind: 'note',
      scope: 'workspace',
      importance: 3,
      source: null,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(fs.readFileSync(outside, 'utf8')).toBe('DO NOT REPLACE');
    expect(fs.readFileSync(note.path, 'utf8')).toContain('safe');
  });

  it('rejects memory dirname that escapes project (startsWith trap)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-scope-'));
    dirs.push(base);
    const project = path.join(base, 'proj');
    const sibling = path.join(base, 'proj2');
    fs.mkdirSync(project);
    fs.mkdirSync(sibling);
    // Sibling path that would pass naive startsWith('/tmp/proj') for /tmp/proj2
    expect(() => resolveMemoryRoot(project, '../proj2')).toThrow(/escape|must not/i);
    expect(() => resolveMemoryRoot(project, '/etc')).toThrow(/relative/i);
    expect(() => resolveMemoryRoot(project, '..')).toThrow();
    // Legitimate subdir still works
    expect(resolveMemoryRoot(project, '.nexus-memory')).toBe(
      path.join(fs.realpathSync(project), '.nexus-memory'),
    );

    fs.symlinkSync(
      sibling,
      path.join(project, '.nexus-memory'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => resolveMemoryRoot(project, '.nexus-memory')).toThrow(/escape/i);
  });

  it('does not index a markdown symlink outside the memory directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-link-'));
    dirs.push(root);
    const memoryRoot = path.join(root, '.nexus-memory');
    fs.mkdirSync(memoryRoot);
    const secret = path.join(root, 'secret.md');
    fs.writeFileSync(secret, '# Outside\n\nsecret');
    fs.symlinkSync(secret, path.join(memoryRoot, 'leak.md'));

    expect(listMemoryNotes(root)).toEqual([]);
  });

  it('projects canonical markdown, resolves wikilinks, searches, backlinks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-'));
    dirs.push(root);

    expect(extractWikilinks('See [[Decision Auth]] and [[Foo]]')).toEqual([
      'Decision Auth',
      'Foo',
    ]);

    const note = await writeCanonicalMemoryProjection(root, {
      id: 'mem-decision-auth',
      content: '# Decision Auth\n\nWe chose JWT. Related [[Mission Alpha]].',
      kind: 'decision',
      scope: 'workspace',
      importance: 5,
      source: 'operator:mission:m1',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(fs.existsSync(note.path)).toBe(true);
    expect(note.wikilinks).toContain('Mission Alpha');

    await writeCanonicalMemoryProjection(root, {
      id: 'mem-mission-alpha',
      content: '# Mission Alpha\n\nDepends on [[Decision Auth]].',
      kind: 'fact',
      scope: 'workspace',
      importance: 4,
      // Forma canônica de atribuição. Antes bastava um `source` CONTENDO
      // `mission:` para a nota entrar na busca de missões — o chamador escolhia
      // sozinho a que missão pertencia (ver mission-id).
      source: 'operator:mission:m1',
      createdAt: 3,
      updatedAt: 4,
    });

    expect(searchMemory(root, 'JWT').length).toBeGreaterThan(0);
    expect(backlinks(root, 'Decision Auth').some((n) => n.title === 'Mission Alpha')).toBe(
      true,
    );
    expect(wikilinkCompletions(root, 'Dec')).toContain('Decision Auth');

    // Frontmatter kind must round-trip (mission search depends on it).
    const listed = listMemoryNotes(root);
    expect(listed.find((n) => n.title === 'Mission Alpha')?.kind).toBe('mission');
    expect(listed.find((n) => n.title === 'Decision Auth')?.kind).toBe('decision');
    expect(listed.filter((n) => n.kind === 'mission')).toHaveLength(1);
  });

  it('sync rewrites canonical projections and removes only stale generated files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-sync-'));
    dirs.push(root);
    const memoryRoot = path.join(root, '.nexus-memory');
    fs.mkdirSync(memoryRoot);
    const legacyPath = path.join(memoryRoot, 'human-note.md');
    fs.writeFileSync(legacyPath, '# Human note\n\nDo not delete.');

    await writeCanonicalMemoryProjection(root, {
      id: 'mem-stale',
      content: '# Stale\n\nOld canonical content.',
      kind: 'note',
      scope: 'workspace',
      importance: 1,
      source: null,
      createdAt: 1,
      updatedAt: 1,
    });

    await syncCanonicalMemoryProjections(root, [
      {
        id: 'mem-current',
        content: '# Current\n\nSQLite wins.',
        kind: 'decision',
        scope: 'workspace',
        importance: 5,
        source: 'operator:decision',
        createdAt: 2,
        updatedAt: 3,
      },
    ]);

    expect(fs.existsSync(path.join(memoryRoot, 'mem-stale.md'))).toBe(false);
    expect(fs.readFileSync(legacyPath, 'utf8')).toContain('Do not delete');
    expect(listMemoryNotes(root).map((note) => note.id)).toEqual([
      'mem-current',
    ]);
    expect(await removeCanonicalMemoryProjection(root, 'mem-current')).toBe(true);
    expect(await removeCanonicalMemoryProjection(root, 'mem-current')).toBe(false);
  });
});

describe('exportMemoryVault — vault markdown legível (F-769)', () => {
  const input = (
    id: string,
    content: string,
    kind: 'fact' | 'decision' | 'preference' | 'note',
    source: string | null,
  ) => ({
    id,
    content,
    kind,
    scope: 'workspace' as const,
    importance: 3,
    source,
    createdAt: 1,
    updatedAt: 1,
  });

  it('gera nomes legíveis, INDEX por tipo, .gitignore e wikilinks de arquivo', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-'));
    dirs.push(root);

    const vaultRoot = await exportMemoryVault(root, [
      input(
        'mem-aaaa1111-1111-4111-8111-111111111111',
        '# Regra do pool do PostgreSQL\n\nO pool vive em src/main/db/pool.ts e esgota com 9 panes.',
        'decision',
        'trusted:architecture-rule',
      ),
      input(
        'mem-bbbb2222-2222-4222-8222-222222222222',
        '# Preferência do operador\n\nSempre Redis local, ver docs/cache.md.',
        'preference',
        'operator:note',
      ),
    ]);

    expect(vaultRoot).toBe(path.join(fs.realpathSync(root), '.nexus-memory'));
    expect(fs.readFileSync(path.join(vaultRoot, '.gitignore'), 'utf8')).toBe(
      '*\n',
    );
    const files = fs.readdirSync(vaultRoot).filter((n) => n.endsWith('.md')).sort();
    expect(files).toEqual([
      'INDEX-decision.md',
      'INDEX-note.md',
      'preferencia-do-operador-bbbb22.md',
      'regra-do-pool-do-postgresql-aaaa11.md',
    ]);
    const note = fs.readFileSync(
      path.join(vaultRoot, 'regra-do-pool-do-postgresql-aaaa11.md'),
      'utf8',
    );
    expect(note).toContain('[[src/main/db/pool.ts]]');
    const index = fs.readFileSync(path.join(vaultRoot, 'INDEX-decision.md'), 'utf8');
    expect(index).toContain('# Índice — Decisões');
    expect(index).toContain(
      '[[regra-do-pool-do-postgresql-aaaa11|Regra do pool do PostgreSQL]]',
    );
    // A projeção da preferência também recebe wikilink no caminho citado.
    const pref = fs.readFileSync(
      path.join(vaultRoot, 'preferencia-do-operador-bbbb22.md'),
      'utf8',
    );
    expect(pref).toContain('[[docs/cache.md]]');
  });

  it('colhe arquivos gerados que saíram do conjunto e preserva markdown humano', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-reap-'));
    dirs.push(root);
    const first = input(
      'mem-aaaa1111-1111-4111-8111-111111111111',
      '# Nota viva\n\ncorpo',
      'note',
      'operator:note',
    );
    const second = input(
      'mem-bbbb2222-2222-4222-8222-222222222222',
      '# Nota efêmera\n\ncorpo',
      'note',
      'operator:note',
    );
    const vaultRoot = await exportMemoryVault(root, [first, second]);
    fs.writeFileSync(path.join(vaultRoot, 'minha-nota.md'), '# Minha\n\nmanual');

    await exportMemoryVault(root, [first]);

    const names = fs.readdirSync(vaultRoot).sort();
    expect(names).toContain('minha-nota.md');
    expect(names).not.toContain('nota-efemera-bbbb22.md');
    expect(names).toContain('nota-viva-aaaa11.md');
    expect(names).toContain('INDEX-note.md');
  });

  it('linkifyFilePaths não toca wikilinks nem URLs', () => {
    expect(linkifyFilePaths('ver src/a.ts e [[src/b.ts]]')).toBe(
      'ver [[src/a.ts]] e [[src/b.ts]]',
    );
    expect(linkifyFilePaths('em https://exemplo.com/x/y.ts nada')).toBe(
      'em https://exemplo.com/x/y.ts nada',
    );
    expect(linkifyFilePaths('src/main/foo.ts:42 quebrou')).toBe(
      '[[src/main/foo.ts]]:42 quebrou',
    );
  });
});

describe('vault: hub de missão e exportação incremental (F-801/F-807)', () => {
  const input = (
    id: string,
    content: string,
    kind: 'fact' | 'decision' | 'preference' | 'note',
    source: string | null,
    extra: Partial<{ reverify: string }> = {},
  ) => ({
    id,
    content,
    kind,
    scope: 'workspace' as const,
    importance: 3,
    source,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });

  it('a linha Mission: vira wikilink para o hub da missão, que lista as notas dela', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-hub-'));
    dirs.push(root);
    const vaultRoot = await exportMemoryVault(root, [
      input(
        'mem-aaaa1111-1111-4111-8111-111111111111',
        '# Delivered handoff\n\nSummary: parser aceita fuso.\nMission: m-42\nHandoff: h-1',
        'fact',
        'trusted:accepted-handoff',
      ),
      input(
        'mem-bbbb2222-2222-4222-8222-222222222222',
        '# Nota da missão\n\ncorpo',
        'note',
        'operator:mission:m-42',
      ),
      input('mem-cccc3333-3333-4333-8333-333333333333', '# Solta\n\ncorpo', 'note', 'operator:note'),
    ]);
    const names = fs.readdirSync(vaultRoot).sort();
    expect(names).toContain('missao-m-42.md');
    const hub = fs.readFileSync(path.join(vaultRoot, 'missao-m-42.md'), 'utf8');
    expect(hub).toContain('# Missão m-42');
    expect(hub).toContain('[[delivered-handoff-aaaa11|Delivered handoff]]');
    expect(hub).toContain('[[nota-da-missao-bbbb22|Nota da missão]]');
    expect(hub).not.toContain('solta');
    const handoff = fs.readFileSync(path.join(vaultRoot, 'delivered-handoff-aaaa11.md'), 'utf8');
    expect(handoff).toContain('Mission: [[missao-m-42|m-42]]');
    const operatorNote = fs.readFileSync(path.join(vaultRoot, 'nota-da-missao-bbbb22.md'), 'utf8');
    expect(operatorNote).toContain('Missão: [[missao-m-42|m-42]]');

    // Sem notas da missão, o hub é colhido como qualquer arquivo gerado.
    await exportMemoryVault(root, [
      input('mem-cccc3333-3333-4333-8333-333333333333', '# Solta\n\ncorpo', 'note', 'operator:note'),
    ]);
    expect(fs.readdirSync(vaultRoot)).not.toContain('missao-m-42.md');
  });

  it('exportação incremental escreve/remove só o lote e reescreve índice e hub afetados', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-incremental-'));
    dirs.push(root);
    const kept = input('mem-aaaa1111-1111-4111-8111-111111111111', '# Fica\n\ncorpo', 'note', 'operator:note');
    const gone = input('mem-bbbb2222-2222-4222-8222-222222222222', '# Sai\n\ncorpo', 'note', 'operator:note');
    const vaultRoot = await exportMemoryVault(root, [kept, gone]);
    fs.writeFileSync(path.join(vaultRoot, 'minha-nota.md'), '# Minha\n\nmanual');

    const added = input(
      'mem-dddd4444-4444-4444-8444-444444444444',
      '# Entrega\n\nSummary: ok.\nMission: m-9',
      'fact',
      'trusted:accepted-handoff',
      { reverify: 'src/x.ts não existe mais' },
    );
    await exportMemoryVaultIncremental(root, {
      changed: [added],
      removed: [gone],
      indexes: new Map([
        ['note', [{ record: kept }]],
        ['mission', []],
        ['decision', []],
      ]),
      hubs: new Map([['m-9', [{ record: added }]]]),
    });

    const names = fs.readdirSync(vaultRoot).sort();
    expect(names).toContain('fica-aaaa11.md');
    expect(names).not.toContain('sai-bbbb22.md');
    expect(names).toContain('entrega-dddd44.md');
    expect(names).toContain('missao-m-9.md');
    expect(names).toContain('minha-nota.md');
    expect(names).not.toContain('INDEX-mission.md');
    expect(fs.readFileSync(path.join(vaultRoot, 'INDEX-note.md'), 'utf8')).not.toContain('Sai');
    const entrega = fs.readFileSync(path.join(vaultRoot, 'entrega-dddd44.md'), 'utf8');
    expect(entrega).toContain('reverify: "src/x.ts não existe mais"');
    expect(entrega).toContain('Mission: [[missao-m-9|m-9]]');
  });
});

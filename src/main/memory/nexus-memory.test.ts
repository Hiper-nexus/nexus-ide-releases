import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backlinks,
  extractWikilinks,
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
  it('does not follow a pre-planted canonical note symlink', () => {
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

    const note = writeCanonicalMemoryProjection(root, {
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

  it('projects canonical markdown, resolves wikilinks, searches, backlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-'));
    dirs.push(root);

    expect(extractWikilinks('See [[Decision Auth]] and [[Foo]]')).toEqual([
      'Decision Auth',
      'Foo',
    ]);

    const note = writeCanonicalMemoryProjection(root, {
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

    writeCanonicalMemoryProjection(root, {
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

  it('sync rewrites canonical projections and removes only stale generated files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-sync-'));
    dirs.push(root);
    const memoryRoot = path.join(root, '.nexus-memory');
    fs.mkdirSync(memoryRoot);
    const legacyPath = path.join(memoryRoot, 'human-note.md');
    fs.writeFileSync(legacyPath, '# Human note\n\nDo not delete.');

    writeCanonicalMemoryProjection(root, {
      id: 'mem-stale',
      content: '# Stale\n\nOld canonical content.',
      kind: 'note',
      scope: 'workspace',
      importance: 1,
      source: null,
      createdAt: 1,
      updatedAt: 1,
    });

    syncCanonicalMemoryProjections(root, [
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
    expect(removeCanonicalMemoryProjection(root, 'mem-current')).toBe(true);
    expect(removeCanonicalMemoryProjection(root, 'mem-current')).toBe(false);
  });
});

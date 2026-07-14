import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  backlinks,
  extractWikilinks,
  listMemoryNotes,
  rememberMarkdown,
  resolveMemoryRoot,
  searchMemory,
  wikilinkCompletions,
} from './nexus-memory';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('nexus memory', () => {
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

  it('writes markdown, resolves wikilinks, searches, backlinks', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.nexusMemory, true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-'));
    dirs.push(root);

    expect(extractWikilinks('See [[Decision Auth]] and [[Foo]]')).toEqual([
      'Decision Auth',
      'Foo',
    ]);

    const note = rememberMarkdown(root, {
      title: 'Decision Auth',
      body: 'We chose JWT. Related [[Mission Alpha]].',
      kind: 'decision',
      missionId: 'm1',
    });
    expect(fs.existsSync(note.path)).toBe(true);
    expect(note.wikilinks).toContain('Mission Alpha');

    rememberMarkdown(root, {
      title: 'Mission Alpha',
      body: 'Depends on [[Decision Auth]].',
      kind: 'mission',
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
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  backlinks,
  extractWikilinks,
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
    const project = '/tmp/proj';
    // Sibling path that would pass naive startsWith('/tmp/proj') for /tmp/proj2
    expect(() => resolveMemoryRoot(project, '../proj2')).toThrow(/escape|must not/i);
    expect(() => resolveMemoryRoot(project, '/etc')).toThrow(/relative/i);
    expect(() => resolveMemoryRoot(project, '..')).toThrow();
    // Legitimate subdir still works
    expect(resolveMemoryRoot(project, '.nexus-memory')).toBe(
      path.resolve(project, '.nexus-memory'),
    );
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
  });
});

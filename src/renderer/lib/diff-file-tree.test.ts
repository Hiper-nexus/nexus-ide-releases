// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: directory/position cases from
// apps/web/src/components/diffs/diffFileTree.logic.test.ts; row, refresh and keyboard cases
// for the Nexus React tree.
import { describe, expect, it } from 'vitest';
import {
  ancestorDirectories,
  buildDiffFileTreeRows,
  collectDirectoryPaths,
  diffFileTreeKeyMove,
  diffFileTreePositions,
  retainCollapsedDirectories,
} from './diff-file-tree';

const PATHS = [
  'src/renderer/components/GitPanelBody.tsx',
  'src/renderer/components/diffs/DiffFileTree.tsx',
  'README.md',
  'src/renderer/lib/diff-rendering.ts',
  'package.json',
];

function outline(paths: readonly string[], collapsed: Iterable<string> = []) {
  return buildDiffFileTreeRows(paths, new Set(collapsed)).map(
    (row) => `${'  '.repeat(row.depth)}${row.kind === 'directory' ? `${row.name}/` : row.name}`,
  );
}

describe('directory ids and positions', () => {
  it('registers every ancestor with a trailing slash, parents first', () => {
    expect(collectDirectoryPaths(['a/b/c.ts', 'a/d.ts', 'e.ts'])).toEqual(['a/', 'a/b/']);
    expect(ancestorDirectories('a/b/c.ts')).toEqual(['a/', 'a/b/']);
  });

  it('places a folder at its first file in the diff', () => {
    const positions = diffFileTreePositions(['z/one.ts', 'a.ts', 'z/two.ts']);
    expect(positions.get('z/')).toBe(0);
    expect(positions.get('a.ts')).toBe(1);
    expect(positions.get('z/two.ts')).toBe(2);
  });
});

describe('buildDiffFileTreeRows', () => {
  it('keeps the diff order and flattens single-folder chains', () => {
    expect(outline(PATHS)).toEqual([
      'src/renderer/',
      '  components/',
      '    GitPanelBody.tsx',
      '    diffs/',
      '      DiffFileTree.tsx',
      '  lib/',
      '    diff-rendering.ts',
      'README.md',
      'package.json',
    ]);
  });

  it('hides the files of a closed folder and keeps its row', () => {
    const rows = buildDiffFileTreeRows(PATHS, new Set(['src/renderer/components/']));
    expect(rows.map((row) => row.path)).toEqual([
      'src/renderer/',
      'src/renderer/components/',
      'src/renderer/lib/',
      'src/renderer/lib/diff-rendering.ts',
      'README.md',
      'package.json',
    ]);
    expect(rows[1]).toMatchObject({ kind: 'directory', expanded: false, parentPath: 'src/renderer/' });
  });

  it('keeps the folders the reader closed across a refresh that adds and removes files', () => {
    const collapsed = new Set(['src/renderer/lib/', 'gone/']);
    const refreshed = [...PATHS, 'src/renderer/lib/new.ts'];
    const retained = retainCollapsedDirectories(collapsed, refreshed);
    expect([...retained]).toEqual(['src/renderer/lib/']);
    expect(outline(refreshed, retained)).toContain('  lib/');
    expect(outline(refreshed, retained)).not.toContain('    new.ts');
  });
});

describe('diffFileTreeKeyMove', () => {
  const rows = buildDiffFileTreeRows(PATHS, new Set());

  it('moves through visible rows with arrows, Home and End', () => {
    expect(diffFileTreeKeyMove(rows, 'src/renderer/', 'ArrowDown')).toEqual({
      type: 'focus',
      path: 'src/renderer/components/',
    });
    expect(diffFileTreeKeyMove(rows, 'README.md', 'ArrowUp')).toEqual({
      type: 'focus',
      path: 'src/renderer/lib/diff-rendering.ts',
    });
    expect(diffFileTreeKeyMove(rows, 'README.md', 'Home')).toEqual({ type: 'focus', path: 'src/renderer/' });
    expect(diffFileTreeKeyMove(rows, 'README.md', 'End')).toEqual({ type: 'focus', path: 'package.json' });
    expect(diffFileTreeKeyMove(rows, 'package.json', 'ArrowDown')).toBeNull();
  });

  it('opens, enters, closes and leaves folders with Right and Left', () => {
    const closed = buildDiffFileTreeRows(PATHS, new Set(['src/renderer/lib/']));
    expect(diffFileTreeKeyMove(closed, 'src/renderer/lib/', 'ArrowRight')).toEqual({
      type: 'toggle',
      path: 'src/renderer/lib/',
    });
    expect(diffFileTreeKeyMove(rows, 'src/renderer/lib/', 'ArrowRight')).toEqual({
      type: 'focus',
      path: 'src/renderer/lib/diff-rendering.ts',
    });
    expect(diffFileTreeKeyMove(rows, 'src/renderer/lib/', 'ArrowLeft')).toEqual({
      type: 'toggle',
      path: 'src/renderer/lib/',
    });
    expect(diffFileTreeKeyMove(rows, 'src/renderer/lib/diff-rendering.ts', 'ArrowLeft')).toEqual({
      type: 'focus',
      path: 'src/renderer/lib/',
    });
    expect(diffFileTreeKeyMove(rows, 'README.md', 'ArrowLeft')).toBeNull();
  });
});

/** @vitest-environment jsdom */
// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: cache-key and compaction cases from
// apps/web/src/lib/diffRendering.test.ts; Nexus fallback, large-patch and range cases added.
import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import {
  buildFileDiffContentVersion,
  buildPatchCacheKey,
  diffSelectionTarget,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from './diff-rendering';

function filesOf(patch: string, options = {}): FileDiffMetadata[] {
  const parsed = getRenderablePatch(patch, 'test', options);
  if (parsed?.kind !== 'files') throw new Error(`expected files, got ${parsed?.kind}`);
  return parsed.files;
}

function lineStat(files: ReadonlyArray<FileDiffMetadata>) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }
  return { additions, deletions };
}

const TWO_HUNKS = [
  'diff --git a/example.ts b/example.ts',
  'index 1111111..2222222 100644',
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -48,4 +48,4 @@',
  ' context 48',
  '-before',
  '+after',
  ' context 50',
  ' context 51',
  '@@ -80,3 +80,5 @@',
  ' context 80',
  '+added 81',
  '+added 82',
  ' context 83',
  ' context 84',
].join('\n');

describe('buildPatchCacheKey', () => {
  it('normalizes outer whitespace and changes with content and scope', () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
    expect(buildPatchCacheKey(`${patch} world`)).not.toBe(buildPatchCacheKey(patch));
    expect(buildPatchCacheKey(patch, 'git-panel:a')).not.toBe(buildPatchCacheKey(patch, 'git-panel:b'));
  });
});

describe('getRenderablePatch', () => {
  it('parses additions, deletions and file kinds with their repository paths', () => {
    const files = filesOf(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,2 +1,2 @@',
        '-const old = 1;',
        '+const next = 2;',
        ' const keep = 3;',
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b',
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n'),
    );
    expect(files.map((file) => [resolveFileDiffPath(file), file.type])).toEqual([
      ['src/app.ts', 'change'],
      ['src/new.ts', 'new'],
      ['src/gone.ts', 'deleted'],
    ]);
    expect(lineStat(files)).toEqual({ additions: 3, deletions: 2 });
  });

  it('keeps a large multi-file patch whole and in order', () => {
    const fileCount = 400;
    const linesPerFile = 30;
    const patch = Array.from({ length: fileCount }, (_, fileIndex) =>
      [
        `diff --git a/src/f${fileIndex}.ts b/src/f${fileIndex}.ts`,
        `--- a/src/f${fileIndex}.ts`,
        `+++ b/src/f${fileIndex}.ts`,
        `@@ -1,${linesPerFile} +1,${linesPerFile} @@`,
        ...Array.from({ length: linesPerFile }, (_, line) => `-old ${fileIndex}.${line}`),
        ...Array.from({ length: linesPerFile }, (_, line) => `+new ${fileIndex}.${line}`),
      ].join('\n'),
    ).join('\n');

    const files = filesOf(patch, { compactPartialHunkOffsets: true });
    expect(files).toHaveLength(fileCount);
    expect(resolveFileDiffPath(files[fileCount - 1]!)).toBe(`src/f${fileCount - 1}.ts`);
    expect(lineStat(files)).toEqual({
      additions: fileCount * linesPerFile,
      deletions: fileCount * linesPerFile,
    });
  });

  it('compacts partial hunk render offsets for the virtualized viewer', () => {
    const file = filesOf(TWO_HUNKS, { compactPartialHunkOffsets: true })[0]!;
    expect(file.hunks[0]?.collapsedBefore).toBe(47);
    expect(file.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file.hunks[1]?.unifiedLineStart).toBe(file.hunks[0]?.unifiedLineCount);
    expect(file.unifiedLineCount).toBe(
      file.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
    expect(filesOf(TWO_HUNKS)[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });

  it('reads a patch without the git header under its real path', () => {
    const [file] = filesOf(
      '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const old = 1;\n+const next = 2;\n const keep = 3;\n',
    );
    expect(resolveFileDiffPath(file!)).toBe('src/app.ts');
    expect(file!.type).toBe('change');
  });

  it('falls back to text for binary files, invalid patches and store notices', () => {
    const binary = getRenderablePatch(
      'diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ\n',
    );
    expect(binary).toMatchObject({ kind: 'raw', reason: expect.stringContaining('binário') });

    const invalid = getRenderablePatch('--- a/x.ts\n+++ b/x.ts\nnot a hunk at all');
    expect(invalid?.kind).toBe('raw');
    expect(invalid?.kind === 'raw' && invalid.reason).toBeTruthy();

    expect(getRenderablePatch('(arquivo não rastreado)\nsrc/new.ts')).toEqual({
      kind: 'raw',
      text: '(arquivo não rastreado)\nsrc/new.ts',
      reason: '',
    });
    expect(getRenderablePatch('   \n')).toBeNull();
  });

  it('strips the truncation marker and flags the cut', () => {
    const parsed = getRenderablePatch(`${TWO_HUNKS}\n\n… [diff truncado para proteção da UI]`);
    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;
    expect(parsed.truncated).toBe(true);
    expect(parsed.files[0]!.additionLines.join('')).not.toContain('truncado');
  });
});

describe('diffSelectionTarget', () => {
  const file = () => filesOf(TWO_HUNKS, { compactPartialHunkOffsets: true })[0]!;

  it('targets the new line for an addition and the old line for a deletion', () => {
    expect(diffSelectionTarget(file(), { start: 49, side: 'additions', end: 49 })).toEqual({
      line: 49,
      anchor: { side: 'additions', lineNumber: 49 },
      rangeLabel: '+49',
      snippet: 'after',
    });
    expect(diffSelectionTarget(file(), { start: 49, side: 'deletions', end: 49 })).toEqual({
      line: 49,
      anchor: { side: 'deletions', lineNumber: 49 },
      rangeLabel: '-49',
      snippet: 'before',
    });
  });

  it('resolves a range in a later hunk to its source lines after compaction', () => {
    const target = diffSelectionTarget(file(), {
      start: 80,
      side: 'additions',
      end: 82,
      endSide: 'additions',
    });
    expect(target).toEqual({
      line: 80,
      anchor: { side: 'additions', lineNumber: 82 },
      rangeLabel: '80 a 82',
      snippet: 'context 80\nadded 81\nadded 82',
    });
  });

  it('rejects lines outside the hunks', () => {
    expect(diffSelectionTarget(file(), { start: 10, side: 'additions', end: 10 })).toBeNull();
  });
});

describe('content version and theme', () => {
  it('versions by content, not by cache scope', () => {
    const a = getRenderablePatch(TWO_HUNKS, 'scope-a');
    const b = getRenderablePatch(TWO_HUNKS, 'scope-b');
    const c = getRenderablePatch(TWO_HUNKS.replace('added 82', 'added 82!'), 'scope-a');
    if (a?.kind !== 'files' || b?.kind !== 'files' || c?.kind !== 'files') throw new Error('parse');
    expect(buildFileDiffContentVersion(a.files[0]!)).toBe(buildFileDiffContentVersion(b.files[0]!));
    expect(buildFileDiffContentVersion(a.files[0]!)).not.toBe(
      buildFileDiffContentVersion(c.files[0]!),
    );
  });

  it('maps the Nexus color scheme to Pierre themes', () => {
    expect(resolveDiffThemeName('light')).toBe('pierre-light');
    expect(resolveDiffThemeName('dark')).toBe('pierre-dark');
  });
});

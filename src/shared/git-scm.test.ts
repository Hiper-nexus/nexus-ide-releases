import { describe, expect, it } from 'vitest';
import {
  assertSafeGitPathspec,
  parseGitLogOneline,
  parsePorcelainV1,
  porcelainZToLf,
  truncateDiff,
  unquotePorcelainPath,
  GIT_SCM_MAX_DIFF_CHARS,
} from './git-scm';

describe('parsePorcelainV1 (LF)', () => {
  it('splits staged, unstaged, and untracked', () => {
    const raw = [
      'M  src/a.ts',
      ' M src/b.ts',
      'MM src/c.ts',
      '?? notes.txt',
      'R  old.ts -> new.ts',
    ].join('\n');

    const snap = parsePorcelainV1(raw);
    expect(snap.clean).toBe(false);
    expect(snap.staged.map((f) => f.path)).toEqual([
      'src/a.ts',
      'src/c.ts',
      'new.ts',
    ]);
    expect(snap.staged.find((f) => f.path === 'new.ts')?.originalPath).toBe(
      'old.ts',
    );
    expect(snap.unstaged.map((f) => f.path)).toEqual(['src/b.ts', 'src/c.ts']);
    expect(snap.untracked).toEqual([{ path: 'notes.txt', status: '?' }]);
  });

  it('decodes C-quoted paths', () => {
    const snap = parsePorcelainV1('?? "foo bar.txt"\n');
    expect(snap.untracked[0]?.path).toBe('foo bar.txt');
  });

  it('reports clean for empty porcelain', () => {
    expect(parsePorcelainV1('').clean).toBe(true);
  });
});

describe('parsePorcelainV1 (-z)', () => {
  it('parses NUL entries and renames', () => {
    const raw = [
      'M  src/a.ts',
      '?? notes.txt',
      'R  new.ts',
      'old.ts',
      '',
    ].join('\0');
    const snap = parsePorcelainV1(raw);
    expect(snap.staged.map((f) => f.path)).toEqual(['src/a.ts', 'new.ts']);
    expect(snap.staged.find((f) => f.path === 'new.ts')?.originalPath).toBe(
      'old.ts',
    );
    expect(snap.untracked.map((f) => f.path)).toEqual(['notes.txt']);
  });
});

describe('porcelainZToLf', () => {
  it('round-trips rename lines for legacy status', () => {
    const raw = ['R  new.ts', 'old.ts', ''].join('\0');
    expect(porcelainZToLf(raw)).toBe('R  old.ts -> new.ts');
  });
});

describe('unquotePorcelainPath', () => {
  it('handles escapes', () => {
    expect(unquotePorcelainPath('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquotePorcelainPath('plain')).toBe('plain');
  });
});

describe('parseGitLogOneline', () => {
  it('parses hash and subject', () => {
    expect(parseGitLogOneline('abc1234 fix: thing\ndef5678 chore: x')).toEqual([
      { hash: 'abc1234', subject: 'fix: thing' },
      { hash: 'def5678', subject: 'chore: x' },
    ]);
  });
});

describe('truncateDiff', () => {
  it('truncates huge diffs within the soft cap', () => {
    const huge = 'x'.repeat(GIT_SCM_MAX_DIFF_CHARS + 10);
    const r = truncateDiff(huge);
    expect(r.truncated).toBe(true);
    expect(r.diff.length).toBeLessThanOrEqual(GIT_SCM_MAX_DIFF_CHARS);
    expect(r.diff).toContain('truncado');
  });
});

describe('assertSafeGitPathspec', () => {
  it('allows relative paths and dot', () => {
    expect(() => assertSafeGitPathspec('.')).not.toThrow();
    expect(() => assertSafeGitPathspec('src/a.ts')).not.toThrow();
  });

  it('rejects traversal, absolute paths, whitespace, and flags', () => {
    expect(() => assertSafeGitPathspec('../x')).toThrow();
    expect(() => assertSafeGitPathspec('foo/../../etc')).toThrow();
    expect(() => assertSafeGitPathspec('foo\\..\\bar')).toThrow();
    expect(() => assertSafeGitPathspec('/etc/passwd')).toThrow();
    expect(() => assertSafeGitPathspec('-rf')).toThrow();
    expect(() => assertSafeGitPathspec(' spaced')).toThrow();
  });
});

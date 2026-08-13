import { describe, expect, it } from 'vitest';
import { diffLineCommentTarget, parseDiffViewLines } from './git-diff-view';

const SAMPLE = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' keep',
  '-old',
  '+new',
  '+extra',
  ' tail',
].join('\n');

describe('parseDiffViewLines', () => {
  it('numbers new and old lines from the hunk header', () => {
    const rows = parseDiffViewLines(SAMPLE);
    const keep = rows.find((r) => r.text === ' keep');
    const added = rows.filter((r) => r.kind === 'add');
    const deleted = rows.find((r) => r.kind === 'del');
    expect(keep).toMatchObject({ kind: 'ctx', newLine: 1 });
    expect(deleted).toMatchObject({ kind: 'del', oldLine: 2 });
    expect(added[0]).toMatchObject({ kind: 'add', newLine: 2, text: '+new' });
    expect(added[1]).toMatchObject({ kind: 'add', newLine: 3, text: '+extra' });
  });
});

describe('diffLineCommentTarget', () => {
  it('returns the file line for add/ctx and ignores hunks', () => {
    const rows = parseDiffViewLines(SAMPLE);
    const add = rows.find((r) => r.text === '+new');
    const hunk = rows.find((r) => r.kind === 'hunk');
    expect(add && diffLineCommentTarget(add)).toEqual({
      line: 2,
      snippet: 'new',
    });
    expect(hunk && diffLineCommentTarget(hunk)).toBeNull();
  });
});

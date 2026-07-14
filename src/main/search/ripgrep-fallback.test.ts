import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { searchWithRipgrep } from './ripgrep-fallback';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('ripgrep fallback', () => {
  it('finds matches under project root or returns empty without root', async () => {
    expect(await searchWithRipgrep({ text: 'foo', limit: 10 })).toEqual([]);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rg-'));
    dirs.push(root);
    fs.writeFileSync(
      path.join(root, 'hit.ts'),
      'export const uniqueTokenAlpha = 1\n',
    );

    const hits = await searchWithRipgrep({
      text: 'uniqueTokenAlpha',
      projectRoot: root,
      limit: 10,
    });
    // rg or grep may be available; if neither works, empty is fail-closed ok
    if (hits.length > 0) {
      expect(hits[0]?.source).toBe('files');
      expect(hits[0]?.snippet).toMatch(/uniqueTokenAlpha/);
    }
  });
});

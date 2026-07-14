import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRipgrepSearchProvider,
  searchWithRipgrep,
} from './ripgrep-fallback';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ripgrep search fallback', () => {
  it('fails closed without an authorized project root', async () => {
    expect(await searchWithRipgrep({ text: 'foo', limit: 10 })).toEqual([]);
  });

  it('waits for grep when ripgrep cannot be spawned', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'match.txt'), 'needle from grep\n');
    const hits = await searchWithRipgrep(
      { text: 'needle', projectRoot: root, limit: 10 },
      { rgPath: path.join(root, 'missing-rg'), allowedRoots: [root] },
    );
    expect(hits.some((hit) => hit.meta?.via === 'grep')).toBe(true);
  });

  it('terminates the child search promptly when its generation is cancelled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-'));
    roots.push(root);
    const slowRg = path.join(root, 'slow-rg.sh');
    fs.writeFileSync(slowRg, '#!/bin/sh\nsleep 10\n');
    fs.chmodSync(slowRg, 0o700);
    const controller = new AbortController();
    const provider = createRipgrepSearchProvider({
      rgPath: slowRg,
      timeoutMs: 20_000,
      allowedRoots: [root],
    });
    const started = Date.now();
    const pending = provider.search(
      { text: 'needle', projectRoot: root, limit: 10 },
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('denies an absolute project root outside the canonical allowlist', async () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-allowed-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-outside-'));
    roots.push(allowed, outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle outside scope\n');

    await expect(
      searchWithRipgrep(
        { text: 'needle', projectRoot: outside, limit: 10 },
        { allowedRoots: [allowed] },
      ),
    ).resolves.toEqual([]);
  });
});

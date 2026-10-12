import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentGateContext } from './gate';
import { buildFileTools } from './tools-files';

interface SearchResult {
  count: number;
  files: string[];
  truncated: boolean;
  stoppedBy: 'maxResults' | 'maxFiles' | 'maxDirectories' | 'timeout' | null;
  scanned: {
    files: number;
    directories: number;
    elapsedMs: number;
  };
  limits: {
    maxResults: number;
    maxFiles: number;
    maxDirectories: number;
    timeoutMs: number;
  };
}

let root: string;

function context(): AgentGateContext {
  return {
    token: 'search-budget-token',
    label: 'search-budget-agent',
    role: 'worker',
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: Object.freeze({
      version: 1,
      installationId: 'installation-search',
      projectId: 'project-search',
      checkoutId: 'checkout-search',
      rootRealPath: fs.realpathSync(root),
      identitySource: 'manifest',
    }),
  };
}

function searchTool() {
  return buildFileTools().find((tool) => tool.name === 'nexus_file_search')!;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-budget-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nexus_file_search budgets', () => {
  it('yields to the event loop before walking the workspace', async () => {
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export {};');
    let settled = false;

    const pending = searchTool()
      .handler({ pattern: '*.ts' }, context())
      .finally(() => {
        settled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    await pending;
  });

  it('stops at the file budget even when maxResults has room', async () => {
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(root, `${index}.ts`), 'export {};');
    }

    const result = (await searchTool().handler(
      {
        pattern: '*.ts',
        maxResults: 100,
        maxFiles: 2,
        maxDirectories: 20,
        timeoutMs: 5_000,
      },
      context(),
    )) as SearchResult;

    expect(result).toMatchObject({
      count: 2,
      truncated: true,
      stoppedBy: 'maxFiles',
      scanned: { files: 2, directories: 1 },
    });
  });

  it('bounds directory traversal independently from files', async () => {
    for (let index = 0; index < 3; index += 1) {
      const nested = path.join(root, `dir-${index}`);
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'entry.ts'), 'export {};');
    }

    const result = (await searchTool().handler(
      {
        pattern: '*.ts',
        maxResults: 100,
        maxFiles: 100,
        maxDirectories: 1,
        timeoutMs: 5_000,
      },
      context(),
    )) as SearchResult;

    expect(result).toMatchObject({
      count: 0,
      truncated: true,
      stoppedBy: 'maxDirectories',
      scanned: { files: 0, directories: 1 },
    });
  });

  it('honors an immediate time budget without scanning', async () => {
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export {};');

    const result = (await searchTool().handler(
      { pattern: '*.ts', timeoutMs: 0 },
      context(),
    )) as SearchResult;

    expect(result).toMatchObject({
      count: 0,
      files: [],
      truncated: true,
      stoppedBy: 'timeout',
      scanned: { files: 0, directories: 0 },
    });
  });

  it('keeps maxResults as an independent result cap', async () => {
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(root, `${index}.ts`), 'export {};');
    }

    const result = (await searchTool().handler(
      {
        pattern: '*.ts',
        maxResults: 2,
        maxFiles: 100,
        maxDirectories: 20,
        timeoutMs: 5_000,
      },
      context(),
    )) as SearchResult;

    expect(result).toMatchObject({
      count: 2,
      truncated: true,
      stoppedBy: 'maxResults',
    });
  });

  it('F-1231: começa no prefixo literal do glob — árvore grande fora dele não gasta orçamento', async () => {
    for (let index = 0; index < 200; index += 1) {
      fs.writeFileSync(path.join(root, `noise-${index}.ts`), 'export {};');
    }
    for (let index = 0; index < 20; index += 1) {
      const noise = path.join(root, `aaa-${index}`, 'main');
      fs.mkdirSync(noise, { recursive: true });
      fs.writeFileSync(path.join(noise, 'updater.ts'), 'export {};');
    }
    fs.mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'renderer'));
    for (const name of ['updater.ts', 'updater-ipc.ts', 'other.ts']) {
      fs.writeFileSync(path.join(root, 'src', 'main', name), 'export {};');
    }
    fs.writeFileSync(path.join(root, 'src', 'renderer', 'updater.ts'), 'export {};');

    const result = (await searchTool().handler(
      { pattern: 'src/main/updater*.ts', maxFiles: 10, maxDirectories: 10, timeoutMs: 5_000 },
      context(),
    )) as SearchResult;

    expect([...result.files].sort()).toEqual(['src/main/updater-ipc.ts', 'src/main/updater.ts']);
    expect(result).toMatchObject({
      truncated: false,
      stoppedBy: null,
      scanned: { files: 3, directories: 3 },
    });
  });

  it('F-1231: o prefixo literal não sai do escopo nem segue symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-outside-'));
    try {
      fs.mkdirSync(path.join(outside, 'main'));
      fs.writeFileSync(path.join(outside, 'main', 'updater.ts'), 'export {};');
      fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');

      for (const pattern of [
        'linked/main/updater*.ts',
        `../${path.basename(outside)}/main/*.ts`,
        `${outside}/main/*.ts`,
      ]) {
        const result = (await searchTool().handler(
          { pattern, timeoutMs: 5_000 },
          context(),
        )) as SearchResult;
        expect(result).toMatchObject({ count: 0, files: [], scanned: { directories: 1 } });
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('F-1251: a/**/b casa a/b e a/x/y/b com poda por prefixo literal', async () => {
    for (let index = 0; index < 20; index += 1) {
      const noise = path.join(root, `noise-${index}`, 'sub');
      fs.mkdirSync(noise, { recursive: true });
      fs.writeFileSync(path.join(noise, 'target.ts'), 'export {};');
    }
    const a = path.join(root, 'a');
    const axy = path.join(root, 'a', 'x', 'y');
    fs.mkdirSync(axy, { recursive: true });
    fs.writeFileSync(path.join(a, 'target.ts'), 'export {};');
    fs.writeFileSync(path.join(a, 'other.ts'), 'export {};');
    fs.writeFileSync(path.join(a, 'x', 'target.ts'), 'export {};');
    fs.writeFileSync(path.join(axy, 'target.ts'), 'export {};');

    const result = (await searchTool().handler(
      { pattern: 'a/**/target.ts', maxFiles: 10, maxDirectories: 10, timeoutMs: 5_000 },
      context(),
    )) as SearchResult;

    expect([...result.files].sort()).toEqual([
      'a/target.ts',
      'a/x/target.ts',
      'a/x/y/target.ts',
    ]);
    expect(result).toMatchObject({
      truncated: false,
      stoppedBy: null,
      scanned: { files: 4, directories: 4 },
    });
  });

  it('F-1325: glob iniciado por ./ acha o mesmo que sem o prefixo', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'lib.ts'), 'export {};');
    fs.writeFileSync(path.join(root, 'src', 'other.ts'), 'export {};');

    for (const pattern of ['./src/lib.ts', '././src/lib.ts']) {
      const result = (await searchTool().handler(
        { pattern, timeoutMs: 5_000 },
        context(),
      )) as SearchResult;
      expect(result.files).toEqual(['src/lib.ts']);
      expect(result.truncated).toBe(false);
    }

    const globbed = (await searchTool().handler(
      { pattern: './src/**/*.ts', timeoutMs: 5_000 },
      context(),
    )) as SearchResult;
    expect([...globbed.files].sort()).toEqual(['src/lib.ts', 'src/other.ts']);
    expect(globbed.truncated).toBe(false);
  });

  it('clamps caller-provided budgets to process-safe hard ceilings', async () => {
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export {};');

    const result = (await searchTool().handler(
      {
        pattern: '*.ts',
        maxResults: Number.MAX_SAFE_INTEGER,
        maxFiles: Number.MAX_SAFE_INTEGER,
        maxDirectories: Number.MAX_SAFE_INTEGER,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      },
      context(),
    )) as SearchResult;

    expect(result.limits).toEqual({
      maxResults: 1_000,
      maxFiles: 100_000,
      maxDirectories: 20_000,
      timeoutMs: 10_000,
    });
  });
});

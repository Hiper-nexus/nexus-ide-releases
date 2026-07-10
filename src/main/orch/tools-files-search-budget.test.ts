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

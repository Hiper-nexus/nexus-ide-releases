import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROJECT_EXECUTION_SCOPE_CACHE_TTL_MS,
  PROJECT_MANIFEST_PATH,
  ProjectIdentityQuarantineError,
  clearProjectExecutionScopeCache,
  resolveProjectExecutionScopeCached,
} from './project-identity';
import type { ProjectGitRunner } from './project-git-lineage';

const PROJECT_ID = '018f6f5e-c2e8-7a59-8d75-3f7e5ab87c91';

function options(root: string) {
  return {
    installationId: 'installation-cache',
    checkoutRegistryFile: path.join(root, 'checkouts-cache.json'),
  };
}

describe('resolveProjectExecutionScopeCached', () => {
  let root: string;

  beforeEach(() => {
    clearProjectExecutionScopeCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-scope-cache-'));
  });

  afterEach(() => {
    clearProjectExecutionScopeCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reuses the same scope object within TTL', () => {
    const workspace = path.join(root, 'provisional');
    fs.mkdirSync(workspace, { recursive: true });
    const opts = options(root);
    const first = resolveProjectExecutionScopeCached(workspace, opts, 0);
    expect(first.identitySource).toBe('provisional');
    const second = resolveProjectExecutionScopeCached(
      workspace,
      opts,
      PROJECT_EXECUTION_SCOPE_CACHE_TTL_MS - 1,
    );
    expect(second).toBe(first);
    const afterTtl = resolveProjectExecutionScopeCached(
      workspace,
      opts,
      PROJECT_EXECUTION_SCOPE_CACHE_TTL_MS,
    );
    expect(afterTtl).not.toBe(first);
    expect(afterTtl.checkoutId).toBe(first.checkoutId);
  });

  it('does not re-run git within TTL after a failed resolve', () => {
    const repository = path.join(root, 'cached-err');
    fs.mkdirSync(path.join(repository, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, PROJECT_MANIFEST_PATH),
      `${JSON.stringify({
        schemaVersion: 2,
        projectId: PROJECT_ID,
        name: 'Nexus',
        repository: {
          vcs: 'git',
          originHashes: [`origin-sha256-${'a'.repeat(64)}`],
          rootCommits: ['b'.repeat(40)],
          anchorCommits: ['c'.repeat(40)],
        },
      })}\n`,
    );
    let runs = 0;
    const gitRunner: ProjectGitRunner = {
      run() {
        runs += 1;
        return { status: 1, stdout: '', stderr: 'ETIMEDOUT' };
      },
    };
    const opts = { ...options(root), gitRunner };
    expect(() =>
      resolveProjectExecutionScopeCached(repository, opts, 0),
    ).toThrow(ProjectIdentityQuarantineError);
    const afterFirst = runs;
    expect(afterFirst).toBeGreaterThan(0);
    expect(() =>
      resolveProjectExecutionScopeCached(repository, opts, 1_000),
    ).toThrow(ProjectIdentityQuarantineError);
    expect(runs).toBe(afterFirst);
    expect(() =>
      resolveProjectExecutionScopeCached(
        repository,
        opts,
        PROJECT_EXECUTION_SCOPE_CACHE_TTL_MS,
      ),
    ).toThrow(ProjectIdentityQuarantineError);
    expect(runs).toBeGreaterThan(afterFirst);
  });
});

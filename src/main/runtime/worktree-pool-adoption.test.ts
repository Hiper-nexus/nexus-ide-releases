import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AsyncProcessGitRunner,
  WorktreeManager,
  WorktreeStateConflictError,
  materializeGitWorktree,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from './worktree-manager';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

class MemoryWorktreeStateStore implements WorktreeStateStore {
  readonly #states = new Map<string, WorktreeStateSnapshot>();
  read(scopeKey: string): WorktreeStateSnapshot {
    return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
  }
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, { revision: current.revision + 1, records: structuredClone(records) });
    return true;
  }
}

let tempDir = '';
let root = '';
let runtimeRoot = '';
let worktreesRoot = '';
let stateStore: MemoryWorktreeStateStore;
let manager: WorktreeManager;
let asyncGit: AsyncProcessGitRunner;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function headSha(): string {
  return git(root, 'rev-parse', 'HEAD');
}

function scope(): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-test',
    projectId: PROJECT_ID,
    checkoutId: 'checkout-pool-test',
    rootRealPath: fs.realpathSync(root),
    identitySource: 'manifest',
  };
}

/** Materializa uma worktree do pool real (branch + caminho sob worktreesRoot/pool). */
async function materializePooled(name: string, atSha?: string) {
  const worktreePath = path.join(worktreesRoot, 'pool', name);
  const branchRef = `refs/heads/nexus-pool/${name}`;
  await materializeGitWorktree({
    repositoryRoot: root,
    worktreePath,
    branchRef,
    headSha: atSha ?? headSha(),
    git: asyncGit,
  });
  return { worktreePath: fs.realpathSync(worktreePath), branchRef };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pool-adoption-'));
  root = path.join(tempDir, 'repo');
  runtimeRoot = path.join(tempDir, 'runtime');
  worktreesRoot = path.join(runtimeRoot, 'worktrees.noindex');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(worktreesRoot, 'pool'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  stateStore = new MemoryWorktreeStateStore();
  asyncGit = new AsyncProcessGitRunner();
  manager = new WorktreeManager({
    runtimeRoot,
    worktreesRoot,
    stateStore,
    asyncGitRunner: asyncGit,
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('WorktreeManager pooled worktree adoption (A1)', () => {
  it('claims a valid pooled worktree as a ready pane writer', async () => {
    const base = headSha();
    const { worktreePath, branchRef } = await materializePooled('valid');

    const record = await manager.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath,
      branchRef,
      baseSha: base,
    });

    expect(record.status).toBe('ready');
    expect(record.pooled).toBe(true);
    expect(record.ownerKind).toBe('pane');
    expect(record.worktreePath).toBe(worktreePath);
    expect(record.branchRef).toBe(branchRef);
    expect(record.baseSha).toBe(base);
    expect(record.taskId).toMatch(/^pane-worker-1$/);

    // Registro durável: a mesma worktree é encontrável depois.
    const durable = manager.get(scope(), 'operator-hand', record.taskId);
    expect(durable).toBeDefined();
    expect(durable?.pooled).toBe(true);
    expect(durable?.worktreePath).toBe(worktreePath);

    // A worktree física permanece intacta e na branch do pool.
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);
    expect(git(worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(branchRef);
  });

  it('rejects a pooled worktree whose HEAD diverged from the claimed base', async () => {
    const { worktreePath, branchRef } = await materializePooled('stale-head');
    const original = headSha();
    // Move o checkout para um commit novo; a base da pré-alocação ficou obsoleta.
    fs.writeFileSync(path.join(root, 'README.md'), '# Moved\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'moved');
    const moved = headSha();
    expect(moved).not.toBe(original);

    // Reivindicar com a base antiga é recusado: o HEAD da worktree é o original,
    // que difere da base pedida (moved) — defesa em profundidade do claim.
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath,
        branchRef,
        baseSha: moved,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
  });

  it('rejects a pooled worktree outside the managed pool root', async () => {
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath: outside,
        branchRef: 'refs/heads/nexus-pool/outside',
        baseSha: headSha(),
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
  });

  it('rejects a pooled worktree whose branch is not a pool branch', async () => {
    const { worktreePath } = await materializePooled('bad-branch');
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath,
        branchRef: 'refs/heads/nexus/not-a-pool',
        baseSha: headSha(),
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
  });

  it('removes a pooled worktree that was never adopted', async () => {
    const { worktreePath, branchRef } = await materializePooled('discard');
    expect(fs.existsSync(worktreePath)).toBe(true);

    await manager.removePooledWorktree(scope(), { worktreePath, branchRef });

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, 'branch', '--list', 'nexus-pool/discard')).toBe('');
  });
});

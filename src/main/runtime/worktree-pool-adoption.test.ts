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
  worktreeBranchRef,
  worktreeTaskKey,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from './worktree-manager';
import { managedWorktreeRelativePath } from './managed-worktree-layout';
import { ISOLATED_WRITER_BRANCH_PREFIX } from '../orch/isolated-writer-policy';

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

/** Identidade CANÔNICA que create() derivaria para este worker (branch + caminho). */
function derivedIdentity(missionId: string, workerId: string) {
  const taskId = `pane-${workerId}`;
  const taskKey = worktreeTaskKey(missionId, taskId);
  const branchRef = worktreeBranchRef({
    ownerKind: 'pane',
    projectId: PROJECT_ID,
    missionId,
    taskId,
    workerId,
  });
  const worktreePath = path.join(
    // O manager resolve o caminho real (macOS: /var → /private/var); derive da
    // MESMA raiz que o claim usa.
    manager.worktreesRoot,
    managedWorktreeRelativePath(PROJECT_ID, 'checkout-pool-test', taskKey),
  );
  return { taskId, taskKey, branchRef, worktreePath };
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
  it('claims a valid pooled worktree, converting it to the canonical writer identity', async () => {
    const base = headSha();
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('valid');
    const derived = derivedIdentity('operator-hand', 'worker-1');

    const record = await manager.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath: poolPath,
      branchRef: poolBranch,
      baseSha: base,
    });

    // Registro NORMAL: identidade derivada, sem marca de pool.
    expect(record.status).toBe('ready');
    expect(record.ownerKind).toBe('pane');
    expect(record.worktreePath).toBe(derived.worktreePath);
    expect(record.branchRef).toBe(derived.branchRef);
    expect(record.baseSha).toBe(base);
    expect(record.taskId).toMatch(/^pane-worker-1$/);
    expect('pooled' in record).toBe(false);

    // Registro durável aponta para a identidade derivada.
    const durable = manager.get(scope(), 'operator-hand', record.taskId);
    expect(durable?.worktreePath).toBe(derived.worktreePath);
    expect(durable?.branchRef).toBe(derived.branchRef);

    // A worktree física MOVEU para o caminho derivado e trocou de branch.
    expect(fs.existsSync(path.join(derived.worktreePath, 'README.md'))).toBe(true);
    expect(fs.existsSync(poolPath)).toBe(false);
    expect(git(derived.worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(derived.branchRef);
    // A branch de pool foi renomeada (não sobra).
    expect(git(root, 'branch', '--list', 'nexus-pool/valid')).toBe('');
  });

  it('adopts with a branch in the isolated-writer namespace (salvage/tools-git identity)', async () => {
    const base = headSha();
    const { worktreePath, branchRef } = await materializePooled('namespace');
    const record = await manager.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath,
      branchRef,
      baseSha: base,
    });
    // F-794/ferramentas git: a branch precisa estar no namespace derivado `nexus/…`.
    expect(record.branchRef.startsWith(ISOLATED_WRITER_BRANCH_PREFIX)).toBe(true);
    expect(record.branchRef).toBe(worktreeBranchRef({
      ownerKind: 'pane', projectId: PROJECT_ID, missionId: 'operator-hand',
      taskId: record.taskId, workerId: record.workerId,
    }));
  });

  it('reverts the rename and throws when the worktree move fails (fail-closed)', async () => {
    const base = headSha();
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('move-fail');
    const derived = derivedIdentity('operator-hand', 'worker-1');
    // Trava a worktree: o `git worktree move` recusa (exit 128).
    git(root, 'worktree', 'lock', poolPath);

    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath: poolPath,
        branchRef: poolBranch,
        baseSha: base,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);

    // Rename revertido: a worktree segue no pool, na branch de pool, sem registro.
    expect(git(poolPath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(poolBranch);
    expect(git(root, 'branch', '--list', 'nexus-pool/move-fail')).toContain('nexus-pool/move-fail');
    expect(manager.get(scope(), 'operator-hand', derived.taskId)).toBeNull();

    // Depois de destravar, o descarte limpo continua funcionando.
    git(root, 'worktree', 'unlock', poolPath);
    await manager.removePooledWorktree(scope(), { worktreePath: poolPath, branchRef: poolBranch });
    expect(fs.existsSync(poolPath)).toBe(false);
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

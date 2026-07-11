import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  OwnershipOverlapError,
  OwnershipViolationError,
  ProcessGitRunner,
  WorktreeManager,
  WorktreeWorkerConflictError,
  type GitRunOptions,
  type GitRunner,
  type GitResult,
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
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
    return true;
  }

  overwrite(scopeKey: string, records: readonly WorktreeRecord[]): void {
    const current = this.read(scopeKey);
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
  }
}

class RecordingGitRunner implements GitRunner {
  readonly calls: Array<{ cwd: string; args: readonly string[] }> = [];
  readonly #delegate = new ProcessGitRunner();

  run(cwd: string, args: readonly string[], options?: GitRunOptions): GitResult {
    this.calls.push({ cwd, args: [...args] });
    return this.#delegate.run(cwd, args, options);
  }
}

let tempDir = '';
let root = '';
let runtimeRoot = '';
let stateStore: MemoryWorktreeStateStore;
let gitRunner: RecordingGitRunner;
let manager: WorktreeManager;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(relativePath: string, content: string, cwd: string = root): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function projectScope(
  rootRealPath: string = fs.realpathSync(root),
): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-test',
    projectId: PROJECT_ID,
    checkoutId: 'checkout-worktree-test',
    rootRealPath,
    identitySource: 'manifest',
  };
}

function makeManager(): WorktreeManager {
  return new WorktreeManager({
    runtimeRoot,
    stateStore,
    gitRunner,
    now: () => 1_700_000_000_000,
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-worktree-manager-'));
  root = path.join(tempDir, 'repo');
  runtimeRoot = path.join(tempDir, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  write('src/shared.ts', 'export const base = 1;\n');
  write('README.md', '# Test\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  stateStore = new MemoryWorktreeStateStore();
  gitRunner = new RecordingGitRunner();
  manager = makeManager();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('never delegates versioned context authority to executor worktrees', () => {
    expect(() => manager.create({
      scope: projectScope(),
      missionId: 'mission-context',
      taskId: 'task-context',
      workerId: 'worker-context',
      ownership: {
        files: ['.context/docs/business-model.md'],
        symbols: [],
        domains: [],
      },
    })).toThrow(/context authority/i);
  });

  it('freezes the canonical base SHA and gives every task a distinct hashed worktree', () => {
    const initialHead = git(root, 'rev-parse', 'HEAD');
    const hostileMission = 'mission/../../$(touch PWNED)';
    const first = manager.create({
      scope: projectScope(),
      missionId: hostileMission,
      taskId: 'task; touch PWNED-2',
      workerId: 'worker-a',
      ownership: { files: ['src/a.ts'], symbols: ['A'], domains: ['billing'] },
    });
    const second = manager.create({
      scope: projectScope(),
      missionId: hostileMission,
      taskId: 'task-b',
      workerId: 'worker-b',
      ownership: { files: ['src/b.ts'], symbols: ['B'], domains: ['catalog'] },
    });

    expect(first.baseSha).toBe(initialHead);
    expect(git(first.worktreePath, 'rev-parse', 'HEAD')).toBe(initialHead);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.branchRef).not.toBe(second.branchRef);
    expect(first.worktreePath.startsWith(fs.realpathSync(runtimeRoot))).toBe(true);
    expect(first.worktreePath).not.toContain(hostileMission);
    expect(first.worktreePath).not.toContain('task; touch');
    expect(first.branchRef).toMatch(/^refs\/heads\/nexus\/[a-f0-9/]+$/);
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'PWNED-2'))).toBe(false);
    expect(
      gitRunner.calls.flatMap((call) => call.args).some((arg) => arg.includes('touch PWNED')),
    ).toBe(false);
  });

  it('rejects a dirty primary checkout before reserving a task', () => {
    write('dirty.txt', 'not committed\n');

    expect(() =>
      manager.create({
        scope: projectScope(),
        missionId: 'mission-a',
        taskId: 'task-a',
        workerId: 'worker-a',
        ownership: { files: ['dirty.txt'], symbols: [], domains: [] },
      }),
    ).toThrow(/clean/i);
    expect(stateStore.read(manager.scopeKey(projectScope())).records).toEqual([]);
  });

  it('requires the scope root to be the canonical Git top-level', () => {
    const nested = path.join(root, 'src');

    expect(() =>
      manager.create({
        scope: projectScope(fs.realpathSync(nested)),
        missionId: 'mission-a',
        taskId: 'task-a',
        workerId: 'worker-a',
        ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      }),
    ).toThrow(/Git top-level|canonical/i);
  });

  it('rejects a lexically non-canonical scope even when it resolves to the repository', () => {
    const canonicalRoot = fs.realpathSync(root);
    const nonCanonical = `${canonicalRoot}${path.sep}src${path.sep}..`;
    expect(nonCanonical).not.toBe(canonicalRoot);
    expect(fs.realpathSync(nonCanonical)).toBe(canonicalRoot);

    expect(() =>
      manager.create({
        scope: projectScope(nonCanonical),
        missionId: 'mission-a',
        taskId: 'task-a',
        workerId: 'worker-a',
        ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      }),
    ).toThrow(/canonical/i);
  });

  it.skipIf(process.platform === 'win32')(
    'disables repository hooks while materializing a worker worktree',
    () => {
      const marker = path.join(tempDir, 'hook-executed');
      const hook = path.join(root, '.git', 'hooks', 'post-checkout');
      fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8');
      fs.chmodSync(hook, 0o700);

      manager.create({
        scope: projectScope(),
        missionId: 'mission-hook',
        taskId: 'task-hook',
        workerId: 'worker-hook',
        ownership: { files: ['hook-safe.txt'], symbols: [], domains: [] },
      });

      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  it('rejects repository-local filters or merge drivers that could execute commands', () => {
    git(root, 'config', 'filter.evil.smudge', 'sh -c "touch escaped"');

    expect(() =>
      manager.create({
        scope: projectScope(),
        missionId: 'mission-filter',
        taskId: 'task-filter',
        workerId: 'worker-filter',
        ownership: { files: ['filter-safe.txt'], symbols: [], domains: [] },
      }),
    ).toThrow(/executable Git config/i);
    expect(fs.existsSync(path.join(root, 'escaped'))).toBe(false);
  });

  it('never assigns the same mission task worktree to another worker', () => {
    const input = {
      scope: projectScope(),
      missionId: 'mission-a',
      taskId: 'task-a',
      ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
    } as const;
    manager.create({ ...input, workerId: 'worker-a' });

    expect(() => manager.create({ ...input, workerId: 'worker-b' })).toThrow(
      WorktreeWorkerConflictError,
    );
    expect(() =>
      manager.create({
        ...input,
        workerId: 'worker-a',
        ownership: { files: ['src/redefined.ts'], symbols: [], domains: [] },
      }),
    ).toThrow(/immutable/i);
  });

  it('blocks overlapping ownership unless the existing task is an explicit dependency', () => {
    manager.create({
      scope: projectScope(),
      missionId: 'mission-a',
      taskId: 'task-a',
      workerId: 'worker-a',
      ownership: {
        files: ['src/shared.ts'],
        symbols: ['SharedService'],
        domains: ['billing'],
      },
    });

    expect(() =>
      manager.create({
        scope: projectScope(),
        missionId: 'mission-a',
        taskId: 'task-b',
        workerId: 'worker-b',
        ownership: {
          files: ['src/shared.ts'],
          symbols: ['AnotherSymbol'],
          domains: ['catalog'],
        },
      }),
    ).toThrow(OwnershipOverlapError);

    const dependent = manager.create({
      scope: projectScope(),
      missionId: 'mission-a',
      taskId: 'task-dependent',
      workerId: 'worker-dependent',
      ownership: {
        files: ['src/other.ts'],
        symbols: ['SharedService'],
        domains: ['billing'],
      },
      dependsOn: [{ missionId: 'mission-a', taskId: 'task-a' }],
    });
    expect(dependent.dependencies).toHaveLength(1);
  });

  it('rejects committed files outside the declared ownership before integration', () => {
    const assignment = manager.create({
      scope: projectScope(),
      missionId: 'mission-a',
      taskId: 'task-a',
      workerId: 'worker-a',
      ownership: { files: ['src/owned.ts'], symbols: [], domains: [] },
    });
    write('src/not-owned.ts', 'export const escaped = true;\n', assignment.worktreePath);
    git(assignment.worktreePath, 'add', '.');
    git(assignment.worktreePath, 'commit', '-m', 'edit undeclared file');

    expect(() =>
      manager.prepareIntegration(projectScope(), 'mission-a', 'task-a'),
    ).toThrow(OwnershipViolationError);
  });

  it('fails closed when persisted state redirects a task to another path', () => {
    const assignment = manager.create({
      scope: projectScope(),
      missionId: 'mission-state',
      taskId: 'task-state',
      workerId: 'worker-state',
      ownership: { files: ['state.txt'], symbols: [], domains: [] },
    });
    const scopeKey = manager.scopeKey(projectScope());
    stateStore.overwrite(scopeKey, [
      { ...assignment, worktreePath: fs.realpathSync(root) },
    ]);

    expect(() =>
      manager.get(projectScope(), 'mission-state', 'task-state'),
    ).toThrow(/invalid worktree state/i);
  });

  it('requires an injected persistence store instead of falling back silently', () => {
    expect(() =>
      new WorktreeManager({
        runtimeRoot,
        stateStore: undefined as unknown as WorktreeStateStore,
      }),
    ).toThrow(/state store/i);
  });
});

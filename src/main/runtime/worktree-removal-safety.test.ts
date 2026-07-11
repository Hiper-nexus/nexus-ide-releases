// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// (src/main/worktree-removal-safety.test.ts)
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: ORCA WorktreeMeta
// provenance cases replaced by WorktreeRecord-based Nexus provenance; local
// RegisteredWorktreeInfo instead of GitWorktreeInfo; statement style.

import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import {
  canCleanupUnregisteredNexusLeftoverDirectory,
  canCleanupUnregisteredNexusWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  getRegisteredDeletableWorktree,
  type NexusWorktreeProvenance,
  type RegisteredWorktreeInfo,
} from './worktree-removal-safety';

function makeRegisteredWorktree(path: string, isMainWorktree = false): RegisteredWorktreeInfo {
  return { path, isMainWorktree };
}

function missingPath(path: string): Error & { code: string } {
  return Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
}

function makeStatPath(filePaths: readonly string[], directoryPaths: readonly string[] = []) {
  const files = new Set(filePaths);
  const directories = new Set(directoryPaths);
  return async (path: string) => {
    if (files.has(path)) {
      return { type: 'file' };
    }
    if (directories.has(path)) {
      return { type: 'directory' };
    }
    throw missingPath(path);
  };
}

function makeReadPath(entries: readonly (readonly [string, unknown])[]) {
  const files = new Map(entries);
  return async (path: string) => {
    if (!files.has(path)) {
      throw missingPath(path);
    }
    return files.get(path);
  };
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await callback();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  }
}

describe('getRegisteredDeletableWorktree', () => {
  it('rejects deleting a worktree that contains another registered worktree', () => {
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeRegisteredWorktree('/repo', true),
        makeRegisteredWorktree('/workspaces/parent'),
        makeRegisteredWorktree('/workspaces/parent/child'),
      ]),
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/child',
    );
  });

  it('does not reject sibling worktree paths that only share a prefix', () => {
    expect(
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeRegisteredWorktree('/repo', true),
        makeRegisteredWorktree('/workspaces/parent'),
        makeRegisteredWorktree('/workspaces/parent-copy'),
      ]),
    ).toMatchObject({ path: '/workspaces/parent' });
  });

  it('rejects deleting a worktree that contains another registered worktree in a dotdot-prefixed child', () => {
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeRegisteredWorktree('/repo', true),
        makeRegisteredWorktree('/workspaces/parent'),
        makeRegisteredWorktree('/workspaces/parent/..child'),
      ]),
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/..child',
    );
  });

  it('rejects the main worktree and unregistered paths', () => {
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/repo', [makeRegisteredWorktree('/repo', true)]),
    ).toThrow('Refusing to delete protected worktree path: /repo');
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/workspaces/ghost', [
        makeRegisteredWorktree('/repo', true),
      ]),
    ).toThrow('Refusing to delete unregistered worktree path: /workspaces/ghost');
  });
});

describe('canSafelyRemoveOrphanedWorktreeDirectory', () => {
  it('accepts a linked worktree .git file that points at this repo worktrees entry', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n'],
          ['/repo/.git/worktrees/orphan/gitdir', '/workspaces/orphan/.git\n'],
        ]),
      ),
    ).resolves.toBe(true);
  });

  it('accepts repo worktree admin entries with dotdot-prefixed directory names', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/..orphan\n'],
          ['/repo/.git/worktrees/..orphan/gitdir', '/workspaces/orphan/.git\n'],
        ]),
      ),
    ).resolves.toBe(true);
  });

  it('accepts remote filesystem provider readFile results for linked worktree .git files', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          [
            '/workspaces/orphan/.git',
            { isBinary: false, content: 'gitdir: /repo/.git/worktrees/orphan\n' },
          ],
          [
            '/repo/.git/worktrees/orphan/gitdir',
            { isBinary: false, content: '/workspaces/orphan/.git\n' },
          ],
        ]),
      ),
    ).resolves.toBe(true);
  });

  it('preserves forward-slash UNC roots when probing linked worktree .git files', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '//Server/Share/orphan',
        '//Server/Repo',
        makeStatPath(['\\\\Server\\Share\\orphan\\.git'], ['\\\\Server\\Repo\\.git']),
        makeReadPath([
          ['\\\\Server\\Share\\orphan\\.git', 'gitdir: //Server/Repo/.git/worktrees/orphan\n'],
          ['\\\\Server\\Repo\\.git\\worktrees\\orphan\\gitdir', '//Server/Share/orphan/.git\n'],
        ]),
      ),
    ).resolves.toBe(true);
  });

  it('rejects a plain .git directory for unregistered cleanup', async () => {
    const readPath = vi.fn();

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        async () => ({ type: 'directory' }),
        readPath,
      ),
    ).resolves.toBe(false);

    expect(readPath).not.toHaveBeenCalled();
  });

  it('rejects a gitdir file that points outside this repo worktrees directory', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          [
            '/workspaces/orphan/.git',
            { isBinary: false, content: 'gitdir: /other/.git/worktrees/orphan\n' },
          ],
        ]),
      ),
    ).resolves.toBe(false);
  });

  it('rejects a copied .git file when the admin entry points at another candidate path', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/reused',
        '/repo',
        makeStatPath(['/workspaces/reused/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/reused/.git', 'gitdir: /repo/.git/worktrees/other\n'],
          ['/repo/.git/worktrees/other/gitdir', '/workspaces/other/.git\n'],
        ]),
      ),
    ).resolves.toBe(false);
  });

  it('rejects POSIX admin backlinks that differ only by case', async () => {
    await withProcessPlatform('win32', async () => {
      await expect(
        canSafelyRemoveOrphanedWorktreeDirectory(
          '/workspaces/reused',
          '/repo',
          makeStatPath(['/workspaces/reused/.git'], ['/repo/.git']),
          makeReadPath([
            ['/workspaces/reused/.git', 'gitdir: /repo/.git/worktrees/reused\n'],
            ['/repo/.git/worktrees/reused/gitdir', '/workspaces/Reused/.git\n'],
          ]),
        ),
      ).resolves.toBe(false);
    });
  });

  it('accepts a pruned admin entry when the candidate .git points under this repo worktrees dir', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n']]),
      ),
    ).resolves.toBe(true);
  });

  it('rejects existing admin entries with a missing gitdir backlink', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(
          ['/workspaces/orphan/.git'],
          ['/repo/.git', '/repo/.git/worktrees/orphan'],
        ),
        makeReadPath([['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n']]),
      ),
    ).resolves.toBe(false);
  });

  it('rejects symlink .git entries from remote lstat-shaped providers', async () => {
    const readPath = vi.fn();

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        async () => ({ type: 'symlink' }),
        readPath,
      ),
    ).resolves.toBe(false);

    expect(readPath).not.toHaveBeenCalled();
  });

  it('rejects separate-git-dir sibling repos when the admin gitdir is missing', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git', '/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /git/other.git\n'],
          ['/repo/.git', 'gitdir: /git/repo.git\n'],
        ]),
      ),
    ).resolves.toBe(false);
  });

  it('rejects separate git dirs under worktrees when the admin gitdir is missing', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/reused',
        '/repo',
        makeStatPath(['/workspaces/reused/.git', '/repo/.git']),
        makeReadPath([
          ['/workspaces/reused/.git', 'gitdir: /git/worktrees/other.git\n'],
          ['/repo/.git', 'gitdir: /git/worktrees/repo.git\n'],
        ]),
      ),
    ).resolves.toBe(false);
  });

  it('accepts a repo path that is itself a linked worktree', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repos/main-linked',
        makeStatPath(['/workspaces/orphan/.git', '/repos/main-linked/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /common/.git/worktrees/orphan\n'],
          ['/repos/main-linked/.git', 'gitdir: /common/.git/worktrees/main-linked\n'],
          ['/common/.git/worktrees/main-linked/gitdir', '/repos/main-linked/.git\n'],
          ['/common/.git/worktrees/orphan/gitdir', '/workspaces/orphan/.git\n'],
        ]),
      ),
    ).resolves.toBe(true);
  });

  it('rejects POSIX home directories even when host homedir has a different path shape', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/home/dev',
        '/repos/main',
        makeStatPath(['/home/dev/.git'], ['/repos/main/.git']),
        makeReadPath([
          ['/home/dev/.git', 'gitdir: /repos/main/.git/worktrees/dev\n'],
          ['/repos/main/.git/worktrees/dev/gitdir', '/home/dev/.git\n'],
        ]),
      ),
    ).resolves.toBe(false);
  });
});

describe('canCleanupUnregisteredNexusWorktreeDirectory', () => {
  const ownedRecord: NexusWorktreeProvenance = {
    createdAt: 1,
    missionId: 'mission-a',
    taskId: 'task-a',
    workerId: 'worker-a',
  };

  it('accepts durable Nexus creation provenance', () => {
    expect(canCleanupUnregisteredNexusWorktreeDirectory({ record: ownedRecord })).toBe(true);
  });

  it('rejects missing or incomplete provenance', () => {
    expect(canCleanupUnregisteredNexusWorktreeDirectory({ record: undefined })).toBe(false);
    expect(canCleanupUnregisteredNexusWorktreeDirectory({ record: null })).toBe(false);
    expect(
      canCleanupUnregisteredNexusWorktreeDirectory({
        record: { ...ownedRecord, missionId: '' },
      }),
    ).toBe(false);
    expect(
      canCleanupUnregisteredNexusWorktreeDirectory({
        record: { ...ownedRecord, createdAt: Number.NaN },
      }),
    ).toBe(false);
  });
});

describe('canCleanupUnregisteredNexusLeftoverDirectory', () => {
  const repoPath = '/repos/main';
  const ownedRecord: NexusWorktreeProvenance = {
    createdAt: 1,
    missionId: 'mission-a',
    taskId: 'task-a',
    workerId: 'worker-a',
  };
  const baseArgs = {
    record: ownedRecord,
    worktreePath: '/workspaces/nexus-owned',
    runtimeWorktreePath: '/workspaces/nexus-owned',
    repoPath,
    runtimeRepoPath: repoPath,
    registeredWorktrees: [makeRegisteredWorktree(repoPath, true)],
  };

  it('rejects unregistered existing targets that are files or symlinks', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        statPath: makeStatPath(['/workspaces/nexus-owned']),
        isGitRepository,
      }),
    ).resolves.toBe(false);
    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        statPath: async (path) => {
          if (path === '/workspaces/nexus-owned') {
            return { type: 'symlink' };
          }
          throw missingPath(path);
        },
        isGitRepository,
      }),
    ).resolves.toBe(false);

    expect(isGitRepository).not.toHaveBeenCalled();
  });

  it('rejects unregistered leftover directories with a .git marker', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        statPath: makeStatPath(['/workspaces/nexus-owned/.git'], ['/workspaces/nexus-owned']),
        isGitRepository,
      }),
    ).resolves.toBe(false);

    expect(isGitRepository).not.toHaveBeenCalled();
  });

  it('rejects no-marker cleanup when only the Nexus path shape matches', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        record: undefined,
        statPath: makeStatPath([], ['/workspaces/nexus-owned']),
        isGitRepository,
      }),
    ).resolves.toBe(false);

    expect(isGitRepository).not.toHaveBeenCalled();
  });

  it('checks dangerous paths in the original path space before runtime translation', async () => {
    const homePath = homedir();
    const runtimeHomePath = homePath
      .replace(/^([A-Za-z]):/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`)
      .replace(/\\/g, '/');
    const isGitRepository = vi.fn().mockResolvedValue(false);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        worktreePath: homePath,
        runtimeWorktreePath: runtimeHomePath,
        repoPath: 'C:\\repos\\main',
        runtimeRepoPath: '/mnt/c/repos/main',
        registeredWorktrees: [makeRegisteredWorktree('C:\\repos\\main', true)],
        statPath: makeStatPath([], [runtimeHomePath]),
        isGitRepository,
      }),
    ).resolves.toBe(false);

    expect(isGitRepository).not.toHaveBeenCalled();
  });

  it('checks dangerous POSIX runtime home paths before no-marker cleanup', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        worktreePath: '/home/dev',
        runtimeWorktreePath: '/home/dev',
        repoPath: '/repos/main',
        runtimeRepoPath: '/repos/main',
        registeredWorktrees: [makeRegisteredWorktree('/repos/main', true)],
        statPath: makeStatPath([], ['/home/dev']),
        isGitRepository,
      }),
    ).resolves.toBe(false);

    expect(isGitRepository).not.toHaveBeenCalled();
  });

  it('rejects unregistered leftover directories that still answer git status', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(true);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        statPath: makeStatPath([], ['/workspaces/nexus-owned']),
        isGitRepository,
      }),
    ).resolves.toBe(false);

    expect(isGitRepository).toHaveBeenCalledWith('/workspaces/nexus-owned');
  });

  it('rejects unregistered leftover directories that contain a registered child worktree', async () => {
    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        registeredWorktrees: [
          makeRegisteredWorktree(repoPath, true),
          makeRegisteredWorktree('/workspaces/nexus-owned/child'),
        ],
        statPath: makeStatPath([], ['/workspaces/nexus-owned']),
        isGitRepository: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/nexus-owned/child',
    );
  });

  it('uses runtime paths for filesystem proof and original paths for nested worktree checks', async () => {
    const statPath = vi.fn(async (path: string) => {
      if (path === '/mnt/c/workspaces/nexus-owned') {
        return { type: 'directory' };
      }
      throw missingPath(path);
    });
    const isGitRepository = vi.fn().mockResolvedValue(false);

    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        worktreePath: 'C:\\workspaces\\nexus-owned',
        runtimeWorktreePath: '/mnt/c/workspaces/nexus-owned',
        repoPath: 'C:\\repos\\main',
        runtimeRepoPath: '/mnt/c/repos/main',
        registeredWorktrees: [
          makeRegisteredWorktree('C:\\repos\\main', true),
          makeRegisteredWorktree('C:\\workspaces\\nexus-owned-sibling'),
        ],
        statPath,
        isGitRepository,
      }),
    ).resolves.toBe(true);

    expect(statPath).toHaveBeenCalledWith('/mnt/c/workspaces/nexus-owned');
    expect(statPath).toHaveBeenCalledWith('/mnt/c/workspaces/nexus-owned/.git');
    expect(statPath).not.toHaveBeenCalledWith('C:\\workspaces\\nexus-owned');
    expect(isGitRepository).toHaveBeenCalledWith('/mnt/c/workspaces/nexus-owned');
  });

  it('rejects translated-runtime cleanup when original path contains a registered child', async () => {
    await expect(
      canCleanupUnregisteredNexusLeftoverDirectory({
        ...baseArgs,
        worktreePath: 'C:\\workspaces\\nexus-owned',
        runtimeWorktreePath: '/mnt/c/workspaces/nexus-owned',
        repoPath: 'C:\\repos\\main',
        runtimeRepoPath: '/mnt/c/repos/main',
        registeredWorktrees: [
          makeRegisteredWorktree('C:\\repos\\main', true),
          makeRegisteredWorktree('C:\\workspaces\\nexus-owned\\child'),
        ],
        statPath: makeStatPath([], ['/mnt/c/workspaces/nexus-owned']),
        isGitRepository: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow(
      'Refusing to delete worktree because it contains another registered worktree: C:\\workspaces\\nexus-owned\\child',
    );
  });
});

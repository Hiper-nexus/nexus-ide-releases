import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentGateContext } from '../orch/gate';
import { buildGitTools } from '../orch/tools-git';
import {
  createDetachedReviewWorktree,
  type DetachedReviewWorktree,
} from './detached-review-worktree';
import type { ReviewBinding } from './review-council';

const execFileAsync = promisify(execFile);
const roots = new Set<string>();

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  return result.stdout;
}

async function repositoryFixture(): Promise<{
  readonly root: string;
  readonly binding: ReviewBinding;
}> {
  const created = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'nexus-detached-review-test-'),
  );
  const root = await fs.promises.realpath(created);
  roots.add(root);
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Nexus Test']);
  await git(root, ['config', 'user.email', 'nexus@example.test']);
  await fs.promises.writeFile(path.join(root, 'feature.txt'), 'base\n', 'utf8');
  await git(root, ['add', 'feature.txt']);
  await git(root, ['commit', '-m', 'base']);
  const baseSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await fs.promises.writeFile(
    path.join(root, 'feature.txt'),
    'base\ncandidate\n',
    'utf8',
  );
  await git(root, ['add', 'feature.txt']);
  await git(root, ['commit', '-m', 'candidate']);
  const headSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const diff = await git(root, [
    'diff',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    `${baseSha}...${headSha}`,
    '--',
  ]);
  return {
    root,
    binding: {
      projectId: 'project-test',
      checkoutId: 'checkout-test',
      missionId: 'mission-test',
      contractHash: 'a'.repeat(64),
      contextHash: 'b'.repeat(64),
      baseSha,
      headSha,
      diffHash: createHash('sha256').update(diff).digest('hex'),
    },
  };
}

async function addSiblingCommit(
  root: string,
  binding: ReviewBinding,
): Promise<string> {
  await git(root, ['checkout', '--quiet', '-b', 'sibling', binding.baseSha]);
  await fs.promises.writeFile(
    path.join(root, 'sibling-secret.txt'),
    'must not cross the review binding\n',
    'utf8',
  );
  await git(root, ['add', 'sibling-secret.txt']);
  await git(root, ['commit', '--quiet', '-m', 'unrelated sibling']);
  const siblingSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['checkout', '--quiet', 'main']);
  return siblingSha;
}

function reviewContext(checkoutPath: string): AgentGateContext {
  return {
    token: 'detached-review-test',
    label: 'PREVC reviewer',
    role: 'worker',
    readOnly: true,
    scope: {
      version: 1,
      installationId: 'installation-test',
      projectId: 'project-test',
      checkoutId: 'checkout-test',
      rootRealPath: checkoutPath,
      identitySource: 'manifest',
    },
    allowedTools: [
      'nexus_git_status',
      'nexus_git_diff',
      'nexus_git_log',
    ],
    allowedSkills: [],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

async function configureExecutableSourceGitDrivers(
  root: string,
): Promise<readonly string[]> {
  const hookDirectory = path.join(root, 'source-hooks');
  const hookMarker = path.join(root, 'source-hook-ran');
  const filterMarker = path.join(root, 'source-filter-ran');
  const filterScript = path.join(root, 'source-filter');
  await fs.promises.mkdir(hookDirectory);
  await fs.promises.writeFile(
    path.join(hookDirectory, 'post-checkout'),
    `#!/bin/sh\nprintf leaked > ${JSON.stringify(hookMarker)}\n`,
    { encoding: 'utf8', mode: 0o700 },
  );
  await fs.promises.writeFile(
    filterScript,
    `#!/bin/sh\nprintf leaked > ${JSON.stringify(filterMarker)}\ncat\n`,
    { encoding: 'utf8', mode: 0o700 },
  );

  await git(root, ['config', '--local', 'core.hooksPath', hookDirectory]);
  await git(root, [
    'config',
    '--local',
    'filter.nexus-review.clean',
    filterScript,
  ]);
  await git(root, [
    'config',
    '--local',
    'filter.nexus-review.smudge',
    filterScript,
  ]);
  await git(root, [
    'config',
    '--local',
    'diff.nexus-review.command',
    filterScript,
  ]);
  await git(root, [
    'config',
    '--local',
    'merge.nexus-review.driver',
    `${filterScript} %O %A %B`,
  ]);
  return [hookMarker, filterMarker];
}

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) =>
      fs.promises.rm(root, { recursive: true, force: true }),
    ),
  );
  roots.clear();
});

describe('detached PREVC review clone', () => {
  it('materializes an exact independent clone without remotes or alternates', async () => {
    const { root, binding } = await repositoryFixture();
    let worktree: DetachedReviewWorktree | null = null;
    try {
      worktree = await createDetachedReviewWorktree({
        repositoryRoot: root,
        binding,
      });

      expect(worktree.checkoutPath).not.toBe(root);
      expect(await fs.promises.realpath(worktree.checkoutPath)).toBe(
        worktree.checkoutPath,
      );
      expect(
        (await git(worktree.checkoutPath, ['rev-parse', 'HEAD'])).trim(),
      ).toBe(binding.headSha);
      expect((await git(worktree.checkoutPath, ['remote'])).trim()).toBe('');
      expect(
        (
          await git(worktree.checkoutPath, [
            'reflog',
            'show',
            '--all',
            '--format=%gs',
          ])
        ).trim(),
      ).toBe('');
      const commonDir = (
        await git(worktree.checkoutPath, ['rev-parse', '--git-common-dir'])
      ).trim();
      expect(
        await fs.promises.realpath(
          path.resolve(worktree.checkoutPath, commonDir),
        ),
      ).toBe(path.join(worktree.checkoutPath, '.git'));
      expect(
        fs.existsSync(
          path.join(
            worktree.checkoutPath,
            '.git',
            'objects',
            'info',
            'alternates',
          ),
        ),
      ).toBe(false);
      await expect(worktree.verify(binding)).resolves.toBeUndefined();
    } finally {
      await worktree?.dispose();
    }

    expect(fs.existsSync(worktree?.checkoutPath ?? '')).toBe(false);
  });

  it('prunes commits and objects outside the exact review binding', async () => {
    const { root, binding } = await repositoryFixture();
    const siblingSha = await addSiblingCommit(root, binding);
    expect(
      (
        await git(root, [
          'merge-base',
          '--is-ancestor',
          siblingSha,
          binding.headSha,
        ]).then(
          () => true,
          () => false,
        )
      ),
    ).toBe(false);

    const worktree = await createDetachedReviewWorktree({
      repositoryRoot: root,
      binding,
    });
    try {
      await expect(
        git(worktree.checkoutPath, [
          'cat-file',
          '-e',
          `${siblingSha}^{commit}`,
        ]),
      ).rejects.toThrow();
      const fsck = await git(worktree.checkoutPath, [
        'fsck',
        '--full',
        '--no-reflogs',
        '--unreachable',
        '--no-progress',
      ]);
      expect(fsck).not.toContain(siblingSha);
      expect(fsck.trim()).toBe('');
      await expect(worktree.verify(binding)).resolves.toBeUndefined();
    } finally {
      await worktree.dispose();
    }
  });

  it('isolates local configuration and refs from the source repository', async () => {
    const { root, binding } = await repositoryFixture();
    await git(root, ['config', 'nexus.boundary', 'source']);
    const worktree = await createDetachedReviewWorktree({
      repositoryRoot: root,
      binding,
    });
    try {
      await git(worktree.checkoutPath, [
        'config',
        '--local',
        'nexus.boundary',
        'clone',
      ]);
      await git(worktree.checkoutPath, [
        'update-ref',
        'refs/heads/main',
        binding.baseSha,
      ]);

      expect(
        (await git(root, ['config', '--local', 'nexus.boundary'])).trim(),
      ).toBe('source');
      expect((await git(root, ['rev-parse', 'refs/heads/main'])).trim()).toBe(
        binding.headSha,
      );
      await expect(worktree.verify(binding)).rejects.toThrow(/named refs/i);
      await git(worktree.checkoutPath, [
        'update-ref',
        '-d',
        'refs/heads/main',
      ]);
      await expect(worktree.verify(binding)).resolves.toBeUndefined();
    } finally {
      await worktree.dispose();
    }
  });

  it('keeps executable source config out while read-only Git tools inspect the clone', async () => {
    const { root, binding } = await repositoryFixture();
    const executionMarkers = await configureExecutableSourceGitDrivers(root);
    const sourceConfig = await git(root, ['config', '--local', '--list']);
    expect(sourceConfig).toMatch(/core\.hookspath=/i);
    expect(sourceConfig).toMatch(/filter\.nexus-review\.smudge=/i);
    expect(sourceConfig).toMatch(/diff\.nexus-review\.command=/i);
    expect(sourceConfig).toMatch(/merge\.nexus-review\.driver=/i);

    const worktree = await createDetachedReviewWorktree({
      repositoryRoot: root,
      binding,
    });
    try {
      const cloneConfig = await git(worktree.checkoutPath, [
        'config',
        '--local',
        '--list',
      ]);
      expect(cloneConfig).not.toMatch(
        /^(?:core\.hookspath|filter\.nexus-review\.|diff\.nexus-review\.|merge\.nexus-review\.)/im,
      );
      for (const marker of executionMarkers) {
        expect(fs.existsSync(marker)).toBe(false);
      }

      const context = reviewContext(worktree.checkoutPath);
      const tools = buildGitTools();
      const status = tools.find(
        (tool) => tool.name === 'nexus_git_status',
      );
      const diff = tools.find((tool) => tool.name === 'nexus_git_diff');
      const log = tools.find((tool) => tool.name === 'nexus_git_log');
      expect(status).toBeDefined();
      expect(diff).toBeDefined();
      expect(log).toBeDefined();

      await expect(status?.handler({}, context)).resolves.toMatchObject({
        cwd: worktree.checkoutPath,
        isRepo: true,
      });
      await expect(diff?.handler({}, context)).resolves.toMatchObject({
        cwd: worktree.checkoutPath,
        diff: '',
      });
      await expect(log?.handler({ count: 2 }, context)).resolves.toMatchObject({
        cwd: worktree.checkoutPath,
        count: 2,
        commits: expect.arrayContaining([
          expect.stringContaining('candidate'),
          expect.stringContaining('base'),
        ]),
      });
      await expect(worktree.verify(binding)).resolves.toBeUndefined();
    } finally {
      await worktree.dispose();
    }
  });

  it('rejects remotes or object alternates added before persistence', async () => {
    const { root, binding } = await repositoryFixture();
    const worktree = await createDetachedReviewWorktree({
      repositoryRoot: root,
      binding,
    });
    try {
      await git(worktree.checkoutPath, ['remote', 'add', 'unexpected', root]);
      await expect(worktree.verify(binding)).rejects.toThrow(/remote/i);
      await git(worktree.checkoutPath, ['remote', 'remove', 'unexpected']);

      const alternatesPath = path.join(
        worktree.checkoutPath,
        '.git',
        'objects',
        'info',
        'alternates',
      );
      await fs.promises.writeFile(
        alternatesPath,
        `${path.join(root, '.git', 'objects')}\n`,
        'utf8',
      );
      await expect(worktree.verify(binding)).rejects.toThrow(/alternates/i);
    } finally {
      await worktree.dispose();
    }
  });

  it('does not alter another registered source worktree during disposal', async () => {
    const { root, binding } = await repositoryFixture();
    const otherCreated = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'nexus-existing-worktree-test-'),
    );
    const otherWorktree = await fs.promises.realpath(otherCreated);
    roots.add(otherWorktree);
    await git(root, [
      'worktree',
      'add',
      '--detach',
      otherWorktree,
      binding.baseSha,
    ]);
    const registryBefore = await git(root, ['worktree', 'list', '--porcelain']);
    const reviewClone = await createDetachedReviewWorktree({
      repositoryRoot: root,
      binding,
    });

    await reviewClone.dispose();

    expect(await git(root, ['worktree', 'list', '--porcelain'])).toBe(
      registryBefore,
    );
    expect(fs.existsSync(otherWorktree)).toBe(true);
  });

  it('rejects a mutated checkout and still removes it completely', async () => {
    const { root, binding } = await repositoryFixture();
    const worktree = await createDetachedReviewWorktree({
      repositoryRoot: root,
      binding,
    });
    await fs.promises.writeFile(
      path.join(worktree.checkoutPath, 'untrusted-change.txt'),
      'mutation\n',
      'utf8',
    );

    await expect(worktree.verify(binding)).rejects.toThrow(
      /checkout changed/i,
    );
    await worktree.dispose();

    expect(fs.existsSync(worktree.checkoutPath)).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_MANIFEST_PATH,
  ProjectIdentityQuarantineError,
  clearProjectExecutionScopeCache,
  createProjectManifest,
  getOrCreateInstallationId,
  projectIdentityStats,
  resolveProjectExecutionScope,
  warmProjectIdentity,
} from './project-identity';
import {
  clearGitRepositoryContextCache,
  gitProofStats,
} from './project-git-lineage';

const PROJECT_ID = '018f6f5e-c2e8-7a59-8d75-3f7e5ab87c91';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initializeRepository(
  directory: string,
  options: { origin?: string; content?: string } = {},
): void {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init']);
  git(directory, ['config', 'user.name', 'Nexus Test']);
  git(directory, ['config', 'user.email', 'nexus@example.invalid']);
  fs.writeFileSync(
    path.join(directory, 'README.md'),
    `${options.content ?? path.basename(directory)}\n`,
  );
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', 'initial']);
  if (options.origin) git(directory, ['remote', 'add', 'origin', options.origin]);
}

function writeManifest(repository: string): void {
  const manifest = createProjectManifest(repository, {
    projectId: PROJECT_ID,
    name: 'Nexus',
  });
  const file = path.join(repository, PROJECT_MANIFEST_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function commitManifest(repository: string): void {
  writeManifest(repository);
  git(repository, ['add', PROJECT_MANIFEST_PATH]);
  git(repository, ['commit', '-m', 'add portable project identity']);
}

function options(root: string, installationId = 'installation-a') {
  return {
    installationId,
    checkoutRegistryFile: path.join(root, `checkouts-${installationId}.json`),
  };
}

function expectQuarantine(
  operation: () => unknown,
  code: ProjectIdentityQuarantineError['code'],
): void {
  try {
    operation();
    throw new Error('expected project identity quarantine');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectIdentityQuarantineError);
    expect(error).toMatchObject({ code });
    expect((error as ProjectIdentityQuarantineError).remediation).toMatch(
      /\.nexus\/project\.json|repositório|manifesto|checkout|clone|origin/i,
    );
  }
}

describe('project identity', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-project-identity-'));
  });

  afterEach(() => {
    clearProjectExecutionScopeCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps one installation id across restarts', () => {
    const stateFile = path.join(root, 'installation.json');

    const first = getOrCreateInstallationId(stateFile);
    const second = getOrCreateInstallationId(stateFile);

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('retries a fresh checkouts.json.lock instead of failing the first EEXIST', () => {
    const source = path.join(root, 'lock-retry-source');
    initializeRepository(source, {
      origin: 'git@github.com:Acme/Nexus.git',
      content: 'lock-retry',
    });
    commitManifest(source);
    const registryFile = path.join(root, 'checkouts-lock-retry.json');
    const lockFile = `${registryFile}.lock`;
    fs.mkdirSync(path.dirname(registryFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockFile, 'holder\n', { mode: 0o600 });

    let attempts = 0;
    const realOpenSync = fs.openSync.bind(fs);
    const retrySpy = vi.spyOn(fs, 'openSync').mockImplementation(
      ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (String(target) === lockFile && flags === 'wx') {
          attempts += 1;
          if (attempts === 1) {
            const busy = new Error('EEXIST') as NodeJS.ErrnoException;
            busy.code = 'EEXIST';
            throw busy;
          }
          fs.rmSync(lockFile, { force: true });
        }
        return realOpenSync(target, flags, mode);
      }) as typeof fs.openSync,
    );

    try {
      const scope = resolveProjectExecutionScope(source, {
        ...options(root, 'installation-lock-retry'),
        checkoutRegistryFile: registryFile,
      });
      expect(scope.projectId).toBe(PROJECT_ID);
      expect(attempts).toBeGreaterThan(1);
    } finally {
      retrySpy.mockRestore();
      fs.rmSync(lockFile, { force: true });
    }
  });

  it('re-reads the winning installation id when another process publishes first', () => {
    const stateFile = path.join(root, 'installation.json');
    const winningInstallationId = '018f6f5e-c2e8-7a59-8d75-3f7e5ab87c92';
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementationOnce(
      (_candidateFile, destinationFile) => {
        fs.writeFileSync(
          destinationFile,
          JSON.stringify({
            schemaVersion: 1,
            installationId: winningInstallationId,
          }),
        );
        const collision = new Error(
          'destination already exists',
        ) as NodeJS.ErrnoException;
        collision.code = 'EEXIST';
        throw collision;
      },
    );

    try {
      expect(getOrCreateInstallationId(stateFile)).toBe(winningInstallationId);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it('accepts one manifested project in a legitimate clone on another PC/path', () => {
    const source = path.join(root, 'source');
    const clone = path.join(root, 'different', 'clone');
    initializeRepository(source, {
      origin: 'git@github.com:Acme/Nexus.git',
      content: 'shared-history',
    });
    commitManifest(source);
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(root, ['clone', source, clone]);

    const sourceScope = resolveProjectExecutionScope(
      source,
      options(root, 'installation-a'),
    );
    const cloneScope = resolveProjectExecutionScope(
      clone,
      options(root, 'installation-b'),
    );

    expect(sourceScope.projectId).toBe(PROJECT_ID);
    expect(cloneScope.projectId).toBe(PROJECT_ID);
    expect(sourceScope.identitySource).toBe('manifest');
    expect(cloneScope.identitySource).toBe('manifest');
    expect(sourceScope.checkoutId).not.toBe(cloneScope.checkoutId);
  });

  it('quarantines a copied manifest in a repository with incompatible history', () => {
    const trusted = path.join(root, 'trusted');
    const attacker = path.join(root, 'attacker');
    initializeRepository(trusted, {
      origin: 'https://github.com/acme/nexus.git',
      content: 'trusted',
    });
    initializeRepository(attacker, {
      origin: 'https://github.com/acme/nexus.git',
      content: 'unrelated',
    });
    writeManifest(trusted);
    fs.mkdirSync(path.join(attacker, '.nexus'), { recursive: true });
    fs.copyFileSync(
      path.join(trusted, PROJECT_MANIFEST_PATH),
      path.join(attacker, PROJECT_MANIFEST_PATH),
    );

    expectQuarantine(
      () => resolveProjectExecutionScope(attacker, options(root)),
      'repository-lineage-mismatch',
    );
  });

  it('rejects a sibling fork that shares template roots but not the manifest anchor', () => {
    const trusted = path.join(root, 'trusted');
    const sibling = path.join(root, 'sibling');
    initializeRepository(trusted, { content: 'shared-template-root' });
    git(root, ['clone', trusted, sibling]);
    fs.writeFileSync(path.join(trusted, 'trusted.txt'), 'trusted-only\n');
    git(trusted, ['add', 'trusted.txt']);
    git(trusted, ['commit', '-m', 'trusted lineage anchor']);
    writeManifest(trusted);
    fs.mkdirSync(path.join(sibling, '.nexus'), { recursive: true });
    fs.copyFileSync(
      path.join(trusted, PROJECT_MANIFEST_PATH),
      path.join(sibling, PROJECT_MANIFEST_PATH),
    );

    expectQuarantine(
      () => resolveProjectExecutionScope(sibling, options(root)),
      'repository-lineage-mismatch',
    );
  });

  it('rejects a reachable anchor when portable origins explicitly diverge', () => {
    const trusted = path.join(root, 'trusted-origin');
    const fork = path.join(root, 'fork-origin');
    initializeRepository(trusted, {
      origin: 'git@github.com:acme/trusted.git',
      content: 'shared-anchor',
    });
    writeManifest(trusted);
    git(root, ['clone', trusted, fork]);
    git(fork, ['remote', 'set-url', 'origin', 'https://github.com/acme/fork.git']);
    fs.mkdirSync(path.join(fork, '.nexus'), { recursive: true });
    fs.copyFileSync(
      path.join(trusted, PROJECT_MANIFEST_PATH),
      path.join(fork, PROJECT_MANIFEST_PATH),
    );

    expectQuarantine(
      () => resolveProjectExecutionScope(fork, options(root)),
      'repository-lineage-mismatch',
    );
  });

  it('normalizes SSH/HTTPS origin proof for a legitimate shallow clone', () => {
    const source = path.join(root, 'source');
    const shallow = path.join(root, 'shallow');
    initializeRepository(source, {
      origin: 'git@github.com:Acme/Nexus.git',
      content: 'shared-history',
    });
    commitManifest(source);
    git(root, ['clone', '--depth', '1', `file://${source}`, shallow]);
    git(shallow, ['remote', 'set-url', 'origin', 'https://github.com/Acme/Nexus']);

    const scope = resolveProjectExecutionScope(shallow, options(root));

    expect(scope.projectId).toBe(PROJECT_ID);
    expect(scope.identitySource).toBe('manifest');
  });

  it('quarantines a shallow clone without a portable remote proof', () => {
    const source = path.join(root, 'source');
    const shallow = path.join(root, 'shallow');
    initializeRepository(source, { content: 'shared-history' });
    commitManifest(source);
    git(root, ['clone', '--depth', '1', `file://${source}`, shallow]);
    git(shallow, ['remote', 'remove', 'origin']);

    expectQuarantine(
      () => resolveProjectExecutionScope(shallow, options(root)),
      'repository-lineage-unverifiable',
    );
  });

  it('never treats a local file remote as portable origin proof', () => {
    const source = path.join(root, 'source');
    const shallow = path.join(root, 'shallow-local-origin');
    initializeRepository(source, { content: 'local-origin-history' });
    commitManifest(source);
    git(root, ['clone', '--depth', '1', `file://${source}`, shallow]);

    expectQuarantine(
      () => createProjectManifest(shallow, { projectId: PROJECT_ID }),
      'repository-lineage-unverifiable',
    );
  });

  it('supports full-history repositories without a remote through root commits', () => {
    const repository = path.join(root, 'offline');
    initializeRepository(repository, { content: 'offline-history' });
    writeManifest(repository);

    const scope = resolveProjectExecutionScope(repository, options(root));

    expect(scope.projectId).toBe(PROJECT_ID);
    expect(scope.identitySource).toBe('manifest');
  });

  it('captures the canonical workspace directory dev/inode in the frozen scope', () => {
    const repository = path.join(root, 'workspace-authority');
    initializeRepository(repository, { content: 'workspace-authority' });
    writeManifest(repository);

    const scope = resolveProjectExecutionScope(repository, options(root));
    const stat = fs.lstatSync(scope.rootRealPath, { bigint: true });

    expect(scope.workspaceRootDevice).toBe(stat.dev.toString());
    expect(scope.workspaceRootInode).toBe(stat.ino.toString());
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it('fails closed when manifested checkout collision registry is disabled', () => {
    const repository = path.join(root, 'registry-required');
    initializeRepository(repository, { content: 'registry-required' });
    writeManifest(repository);

    expectQuarantine(
      () => resolveProjectExecutionScope(repository, 'installation-a'),
      'checkout-registry-required',
    );
  });

  it('gives distinct stable checkout ids to Git worktrees of one project', () => {
    const repository = path.join(root, 'main');
    const worktree = path.join(root, 'feature');
    initializeRepository(repository, { content: 'worktree-history' });
    commitManifest(repository);
    git(repository, ['worktree', 'add', '-b', 'feature-test', worktree]);
    const registryOptions = options(root);

    const mainScope = resolveProjectExecutionScope(repository, registryOptions);
    const featureScope = resolveProjectExecutionScope(worktree, registryOptions);
    const featureAgain = resolveProjectExecutionScope(worktree, registryOptions);

    expect(featureScope.projectId).toBe(mainScope.projectId);
    expect(featureScope.checkoutId).not.toBe(mainScope.checkoutId);
    expect(featureAgain.checkoutId).toBe(featureScope.checkoutId);
  });

  it('keeps checkout identity across a copy+delete move that changes inode', () => {
    const original = path.join(root, 'original');
    const moved = path.join(root, 'moved-cross-volume');
    initializeRepository(original, { content: 'move-history' });
    writeManifest(original);
    const registryOptions = options(root);
    const before = resolveProjectExecutionScope(original, registryOptions);

    fs.cpSync(original, moved, { recursive: true, preserveTimestamps: true });
    fs.rmSync(original, { recursive: true, force: true });
    const after = resolveProjectExecutionScope(moved, registryOptions);

    expect(after.checkoutId).toBe(before.checkoutId);
    expect(after.rootRealPath).toBe(fs.realpathSync(moved));
  });

  it('skips the checkouts.json rewrite when only a fresh lastSeenAt would change', () => {
    vi.useFakeTimers();
    try {
      const repository = path.join(root, 'last-seen-throttle');
      initializeRepository(repository, { origin: 'https://example.invalid/owner/repo.git' });
      commitManifest(repository);
      const registryFile = path.join(root, 'checkouts-throttle.json');
      const registryOptions = {
        installationId: 'installation-throttle',
        checkoutRegistryFile: registryFile,
      };

      vi.setSystemTime(1_700_000_000_000);
      resolveProjectExecutionScope(repository, registryOptions);
      const afterFirst = fs.readFileSync(registryFile, 'utf8');

      vi.setSystemTime(1_700_000_001_000);
      resolveProjectExecutionScope(repository, registryOptions);
      const afterSecond = fs.readFileSync(registryFile, 'utf8');
      expect(afterSecond).toBe(afterFirst);

      // Beyond the refresh window the liveness marker is written again.
      vi.setSystemTime(1_700_000_000_000 + 3_600_000 + 2_000);
      resolveProjectExecutionScope(repository, registryOptions);
      const afterWindow = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as {
        entries: { lastSeenAt: number }[];
      };
      expect(afterWindow.entries[0]!.lastSeenAt).toBe(1_700_000_000_000 + 3_600_000 + 2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rewrites checkouts.json immediately when a matched entry changes beyond lastSeenAt', () => {
    vi.useFakeTimers();
    try {
      const original = path.join(root, 'throttle-move');
      initializeRepository(original, { content: 'throttle-move' });
      writeManifest(original);
      const registryFile = path.join(root, 'checkouts-throttle-move.json');
      const registryOptions = {
        installationId: 'installation-throttle-move',
        checkoutRegistryFile: registryFile,
      };

      vi.setSystemTime(1_700_000_000_000);
      const before = resolveProjectExecutionScope(original, registryOptions);
      const afterFirst = fs.readFileSync(registryFile, 'utf8');

      // A copy+delete move changes rootRealPath: the registry must follow the
      // move right away even though lastSeenAt is still fresh.
      const moved = path.join(root, 'throttle-moved');
      fs.cpSync(original, moved, { recursive: true, preserveTimestamps: true });
      fs.rmSync(original, { recursive: true, force: true });
      vi.setSystemTime(1_700_000_001_000);
      const after = resolveProjectExecutionScope(moved, registryOptions);

      expect(after.checkoutId).toBe(before.checkoutId);
      const rewritten = fs.readFileSync(registryFile, 'utf8');
      expect(rewritten).not.toBe(afterFirst);
      const entry = (JSON.parse(rewritten) as { entries: { rootRealPath: string }[] })
        .entries[0]!;
      expect(entry.rootRealPath).toBe(fs.realpathSync(moved));
    } finally {
      vi.useRealTimers();
    }
  });

  it('quarantines a duplicated live checkout token instead of colliding ids', () => {
    const original = path.join(root, 'original');
    const duplicate = path.join(root, 'duplicate');
    initializeRepository(original, { content: 'duplicate-history' });
    writeManifest(original);
    const registryOptions = options(root);
    resolveProjectExecutionScope(original, registryOptions);
    fs.cpSync(original, duplicate, { recursive: true, preserveTimestamps: true });

    expectQuarantine(
      () => resolveProjectExecutionScope(duplicate, registryOptions),
      'duplicate-checkout-token',
    );
  });

  it('quarantines a symlinked checkout token in the Git administration area', () => {
    const repository = path.join(root, 'unsafe-token');
    initializeRepository(repository, { content: 'unsafe-token' });
    writeManifest(repository);
    const registryOptions = options(root);
    resolveProjectExecutionScope(repository, registryOptions);
    const gitDir = git(repository, ['rev-parse', '--absolute-git-dir']);
    const tokenFile = path.join(gitDir, 'nexus', 'checkout.json');
    const outside = path.join(root, 'outside-checkout-token.json');
    fs.copyFileSync(tokenFile, outside);
    fs.rmSync(tokenFile);
    fs.symlinkSync(outside, tokenFile);

    expectQuarantine(
      () => resolveProjectExecutionScope(repository, registryOptions),
      'unsafe-git-administration',
    );
  });

  it('migrates a v1 checkout registry only after its local fingerprint matches', () => {
    const repository = path.join(root, 'repository');
    initializeRepository(repository, { content: 'legacy-registry' });
    writeManifest(repository);
    const registryFile = path.join(root, 'checkouts.json');
    const stat = fs.statSync(repository, { bigint: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        installationId: 'installation-a',
        entries: [
          {
            checkoutId: 'checkout-11111111111111111111111111111111',
            projectId: PROJECT_ID,
            rootRealPath: fs.realpathSync(repository),
            device: stat.dev.toString(),
            inode: stat.ino.toString(),
            birthtimeNs: stat.birthtimeNs.toString(),
            createdAt: 1,
            lastSeenAt: 1,
          },
        ],
      }),
    );

    const scope = resolveProjectExecutionScope(repository, {
      installationId: 'installation-a',
      checkoutRegistryFile: registryFile,
    });
    const migrated = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as {
      schemaVersion: number;
      entries: Array<{ kind: string; checkoutId: string }>;
    };

    expect(scope.checkoutId).toBe(
      'checkout-11111111111111111111111111111111',
    );
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.entries).toContainEqual(
      expect.objectContaining({
        kind: 'git-token',
        checkoutId: scope.checkoutId,
      }),
    );
  });

  it('does not adopt a legacy checkout id when its local fingerprint is gone', () => {
    const repository = path.join(root, 'repository');
    const unrelatedFingerprint = path.join(root, 'old-checkout');
    initializeRepository(repository, { content: 'new-checkout' });
    fs.mkdirSync(unrelatedFingerprint);
    writeManifest(repository);
    const registryFile = path.join(root, 'checkouts.json');
    const stat = fs.statSync(unrelatedFingerprint, { bigint: true });
    const legacyCheckoutId = 'checkout-22222222222222222222222222222222';
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        installationId: 'installation-a',
        entries: [
          {
            checkoutId: legacyCheckoutId,
            projectId: PROJECT_ID,
            rootRealPath: fs.realpathSync(unrelatedFingerprint),
            device: stat.dev.toString(),
            inode: stat.ino.toString(),
            birthtimeNs: stat.birthtimeNs.toString(),
            createdAt: 1,
            lastSeenAt: 1,
          },
        ],
      }),
    );

    const scope = resolveProjectExecutionScope(repository, {
      installationId: 'installation-a',
      checkoutRegistryFile: registryFile,
    });

    expect(scope.checkoutId).not.toBe(legacyCheckoutId);
  });

  it('quarantines a legacy v1 manifest with explicit migration remediation', () => {
    const repository = path.join(root, 'legacy');
    initializeRepository(repository, { content: 'legacy-manifest' });
    const manifest = path.join(repository, PROJECT_MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID }),
    );

    expectQuarantine(
      () => resolveProjectExecutionScope(repository, options(root)),
      'legacy-manifest-unverified',
    );
  });

  it('marks a workspace without a manifest as provisional', () => {
    const scope = resolveProjectExecutionScope(root, 'installation-a');

    expect(scope.projectId).toMatch(/^local-[a-f0-9]{32}$/);
    expect(scope.checkoutId).toMatch(/^checkout-[a-f0-9]{32}$/);
    expect(scope.identitySource).toBe('provisional');
  });

  it('rejects symlinked, oversized, invalid and extra-field manifests', () => {
    const repository = path.join(root, 'repository');
    initializeRepository(repository, { content: 'manifest-safety' });
    const manifest = path.join(repository, PROJECT_MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID }));
    fs.symlinkSync(outside, manifest);
    expect(() => resolveProjectExecutionScope(repository, options(root))).toThrow(
      /outside workspace/i,
    );

    fs.rmSync(manifest);
    fs.writeFileSync(manifest, 'x'.repeat(70 * 1024));
    expect(() => resolveProjectExecutionScope(repository, options(root))).toThrow(
      /too large/i,
    );

    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, projectId: 'bad' }));
    expect(() => resolveProjectExecutionScope(repository, options(root))).toThrow(
      /invalid project manifest/i,
    );

    const valid = createProjectManifest(repository, { projectId: PROJECT_ID });
    fs.writeFileSync(manifest, JSON.stringify({ ...valid, unexpectedAuthority: true }));
    expect(() => resolveProjectExecutionScope(repository, options(root))).toThrow(
      /invalid project manifest/i,
    );
  });

  it('keeps the same provisional checkout id when the folder is recreated', () => {
    // Cenário de produção: pasta sem git/manifest apagada e recriada no MESMO
    // path (tmp de teste, re-clone, restore). A fingerprint muda, o digest do
    // path não — sem a cura, o workspace fica preso em "checkout id collision".
    const workspace = path.join(root, 'meu-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const opts = options(root);

    const first = resolveProjectExecutionScope(workspace, opts);
    expect(first.identitySource).toBe('provisional');

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });

    const second = resolveProjectExecutionScope(workspace, opts);
    expect(second.checkoutId).toBe(first.checkoutId);
    expect(second.projectId).toBe(first.projectId);

    // A entrada foi refrescada, não duplicada.
    const registry = JSON.parse(
      fs.readFileSync(opts.checkoutRegistryFile, 'utf8'),
    ) as { entries: { checkoutId: string; rootRealPath: string }[] };
    const entriesForPath = registry.entries.filter(
      (entry) => entry.checkoutId === first.checkoutId,
    );
    expect(entriesForPath).toHaveLength(1);
  });

  it('still fails closed on a checkout id collision from a DIFFERENT path', () => {
    const workspace = path.join(root, 'workspace-b');
    fs.mkdirSync(workspace, { recursive: true });
    const opts = options(root);
    const scope = resolveProjectExecutionScope(workspace, opts);

    // Forja uma entrada com o MESMO checkoutId apontando para outro path —
    // colisão real de identidade, não uma recriação da mesma pasta.
    const registry = JSON.parse(
      fs.readFileSync(opts.checkoutRegistryFile, 'utf8'),
    ) as {
      entries: { checkoutId: string; rootRealPath: string; inode: string }[];
    };
    for (const entry of registry.entries) {
      if (entry.checkoutId === scope.checkoutId) {
        entry.rootRealPath = path.join(root, 'outro-lugar');
        entry.inode = '999999999';
      }
    }
    fs.writeFileSync(opts.checkoutRegistryFile, JSON.stringify(registry));

    expect(() => resolveProjectExecutionScope(workspace, opts)).toThrow(
      /checkout id collision/i,
    );
  });
});

describe('identity proof cache (fail-closed)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-identity-cache-'));
    clearGitRepositoryContextCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearProjectExecutionScopeCache();
    clearGitRepositoryContextCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolução pós-aquecimento não roda git síncrono', async () => {
    initializeRepository(root, {
      origin: 'https://example.invalid/owner/repo.git',
      content: 'cache-warm',
    });
    commitManifest(root);
    await warmProjectIdentity(root);

    const gitBefore = gitProofStats();
    const idBefore = projectIdentityStats();
    const scope = resolveProjectExecutionScope(
      root,
      options(root, 'installation-warm'),
    );
    expect(scope.identitySource).toBe('manifest');
    expect(gitProofStats().contextSyncRuns).toBe(gitBefore.contextSyncRuns);
    expect(projectIdentityStats().identityHits).toBe(idBefore.identityHits + 1);
  });

  it('manifesto adulterado quarentena mesmo com o cache quente', () => {
    initializeRepository(root, {
      origin: 'https://example.invalid/owner/repo.git',
      content: 'cache-poison',
    });
    commitManifest(root);
    const opts = options(root, 'installation-poison');
    const first = resolveProjectExecutionScope(root, opts);
    expect(first.identitySource).toBe('manifest');

    // Troca o manifesto por um de OUTRO projeto: o cache NÃO pode servir a
    // identidade antiga — a fingerprint do manifesto mudou, então recompute
    // e quarentena (fail-closed).
    const manifestFile = path.join(root, PROJECT_MANIFEST_PATH);
    const manifest = JSON.parse(
      fs.readFileSync(manifestFile, 'utf8'),
    ) as Record<string, unknown>;
    const repository = manifest.repository as Record<string, unknown>;
    manifest.projectId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    repository.originHashes = [`origin-sha256-${'ab'.repeat(32)}`];
    repository.anchorCommits = [];
    repository.rootCommits = [];
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    expectQuarantine(
      () => resolveProjectExecutionScope(root, opts),
      'repository-lineage-mismatch',
    );
  });

  it('TTL vencido recomputa a identidade', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    initializeRepository(root, {
      origin: 'https://example.invalid/owner/repo.git',
      content: 'cache-ttl',
    });
    commitManifest(root);
    const opts = options(root, 'installation-ttl');
    resolveProjectExecutionScope(root, opts);
    const before = projectIdentityStats();

    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
    clearProjectExecutionScopeCache();
    resolveProjectExecutionScope(root, opts);
    expect(projectIdentityStats().identityRuns).toBe(before.identityRuns + 1);
  });
});

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReviewBinding } from './review-council';
import { removeTree } from '../util/remove-tree';

const COMMIT_SHA = /^[a-f0-9]{40,64}$/;
const DIFF_HASH = /^[a-f0-9]{64}$/;
const TEMP_PREFIX = 'nexus-prevc-review-';
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const ALTERNATE_FILES = [
  'objects/info/alternates',
  'objects/info/http-alternates',
] as const;
const GIT_ENVIRONMENT_OVERRIDES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
] as const;

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface DetachedReviewWorktree {
  readonly checkoutPath: string;
  verify(binding: ReviewBinding, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

interface ReviewCheckoutContext {
  readonly repositoryRoot: string;
  readonly temporaryRoot: string;
  readonly temporaryParent: string;
  readonly checkoutPath: string;
  readonly hooksPath: string;
}

interface VerifyCheckoutInput {
  readonly repositoryRoot: string;
  readonly checkoutPath: string;
  readonly binding: ReviewBinding;
  readonly signal?: AbortSignal;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        typeof signal.reason === 'string'
          ? signal.reason
          : 'session_authority_revoked',
      );
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of GIT_ENVIRONMENT_OVERRIDES) {
    delete environment[key];
  }
  return environment;
}

function runGit(
  repositoryRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repositoryRoot, ...args],
      {
        encoding: 'utf8',
        env: gitEnvironment(),
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(signal?.aborted ? abortError(signal) : error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertBindingShape(binding: ReviewBinding): void {
  if (
    !COMMIT_SHA.test(binding.baseSha) ||
    !COMMIT_SHA.test(binding.headSha) ||
    !DIFF_HASH.test(binding.diffHash)
  ) {
    throw new Error('detached review requires an exact Git binding');
  }
}

async function canonicalDirectory(
  directory: string,
  label: string,
): Promise<string> {
  const resolved = path.resolve(directory);
  const real = await fs.promises.realpath(resolved);
  const stat = await fs.promises.stat(real);
  if (real !== resolved || !stat.isDirectory()) {
    throw new Error(`${label} identity changed`);
  }
  return real;
}

function assertOwnedTemporaryParent(
  temporaryRoot: string,
  temporaryParent: string,
): void {
  if (
    path.dirname(temporaryParent) !== temporaryRoot ||
    !path.basename(temporaryParent).startsWith(TEMP_PREFIX)
  ) {
    throw new Error('detached review temporary path escaped its owned root');
  }
}

function isInsideDirectory(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveExistingGitPath(
  checkoutPath: string,
  gitPath: string,
  label: string,
): Promise<string> {
  const absolutePath = path.isAbsolute(gitPath)
    ? gitPath
    : path.resolve(checkoutPath, gitPath);
  return canonicalDirectory(absolutePath, label);
}

async function verifyIndependentGitStorage(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const commonDirOutput = (
    await runGit(checkoutPath, ['rev-parse', '--git-common-dir'], signal)
  ).stdout.trim();
  const commonDir = await resolveExistingGitPath(
    checkoutPath,
    commonDirOutput,
    'detached review Git common directory',
  );
  if (!isInsideDirectory(commonDir, checkoutPath)) {
    throw new Error('detached review Git common directory escaped the clone');
  }

  const objectsOutput = (
    await runGit(checkoutPath, ['rev-parse', '--git-path', 'objects'], signal)
  ).stdout.trim();
  const objectsDir = await resolveExistingGitPath(
    checkoutPath,
    objectsOutput,
    'detached review Git object directory',
  );
  if (!isInsideDirectory(objectsDir, commonDir)) {
    throw new Error('detached review Git object store is shared externally');
  }

  for (const alternateFile of ALTERNATE_FILES) {
    const alternatePath = (
      await runGit(
        checkoutPath,
        ['rev-parse', '--git-path', alternateFile],
        signal,
      )
    ).stdout.trim();
    const resolvedAlternate = path.isAbsolute(alternatePath)
      ? alternatePath
      : path.resolve(checkoutPath, alternatePath);
    if (
      await fs.promises
        .lstat(resolvedAlternate)
        .then(() => true, () => false)
    ) {
      throw new Error('detached review Git object alternates are forbidden');
    }
  }
}

async function verifyNoRemotes(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const remotes = (
    await runGit(checkoutPath, ['remote'], signal)
  ).stdout.trim();
  if (remotes.length > 0) {
    throw new Error('detached review clone regained a Git remote');
  }
}

async function listNamedRefs(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  return (
    await runGit(
      checkoutPath,
      ['for-each-ref', '--format=%(refname)'],
      signal,
    )
  ).stdout
    .split('\n')
    .map((refName) => refName.trim())
    .filter((refName) => refName.length > 0);
}

async function verifyNoNamedRefs(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if ((await listNamedRefs(checkoutPath, signal)).length > 0) {
    throw new Error('detached review clone regained named refs');
  }
}

async function verifyNoUnreachableObjects(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit(
    checkoutPath,
    [
      'fsck',
      '--full',
      '--no-reflogs',
      '--unreachable',
      '--no-progress',
    ],
    signal,
  );
  if (result.stdout.trim().length > 0) {
    throw new Error('detached review clone retained unbound Git objects');
  }
}

async function verifyCheckoutIdentity(
  input: VerifyCheckoutInput,
): Promise<string> {
  const realCheckout = await canonicalDirectory(
    input.checkoutPath,
    'detached review checkout',
  );
  if (
    realCheckout !== input.checkoutPath ||
    realCheckout === input.repositoryRoot
  ) {
    throw new Error('detached review checkout is not physically isolated');
  }

  const topLevel = (
    await runGit(realCheckout, ['rev-parse', '--show-toplevel'], input.signal)
  ).stdout.trim();
  const realTopLevel = await fs.promises.realpath(topLevel);
  if (realTopLevel !== realCheckout) {
    throw new Error('detached review Git top-level changed');
  }
  return realCheckout;
}

async function verifyBoundCommits(
  checkoutPath: string,
  binding: ReviewBinding,
  signal?: AbortSignal,
): Promise<{ readonly baseSha: string; readonly headSha: string }> {
  const headSha = (
    await runGit(
      checkoutPath,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      signal,
    )
  ).stdout.trim().toLowerCase();
  if (headSha !== binding.headSha) {
    throw new Error('detached review HEAD changed before persistence');
  }
  const baseSha = (
    await runGit(
      checkoutPath,
      ['rev-parse', '--verify', `${binding.baseSha}^{commit}`],
      signal,
    )
  ).stdout.trim().toLowerCase();
  if (baseSha !== binding.baseSha) {
    throw new Error('detached review base commit changed');
  }
  await runGit(
    checkoutPath,
    ['merge-base', '--is-ancestor', baseSha, headSha],
    signal,
  );
  return { baseSha, headSha };
}

async function verifyBoundDiff(
  checkoutPath: string,
  binding: ReviewBinding,
  commits: { readonly baseSha: string; readonly headSha: string },
  signal?: AbortSignal,
): Promise<void> {
  const diff = (
    await runGit(
      checkoutPath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        `${commits.baseSha}...${commits.headSha}`,
        '--',
      ],
      signal,
    )
  ).stdout;
  if (sha256(diff) !== binding.diffHash) {
    throw new Error('detached review diff no longer matches its binding');
  }
}

async function verifyCleanCheckout(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const status = (
    await runGit(
      checkoutPath,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      signal,
    )
  ).stdout;
  if (status.length > 0) {
    throw new Error(
      'detached review checkout changed before report persistence',
    );
  }
}

async function verifyCheckout(input: VerifyCheckoutInput): Promise<void> {
  assertBindingShape(input.binding);
  const checkoutPath = await verifyCheckoutIdentity(input);
  await verifyIndependentGitStorage(checkoutPath, input.signal);
  await verifyNoRemotes(checkoutPath, input.signal);
  await verifyNoNamedRefs(checkoutPath, input.signal);
  const commits = await verifyBoundCommits(
    checkoutPath,
    input.binding,
    input.signal,
  );
  await verifyBoundDiff(checkoutPath, input.binding, commits, input.signal);
  await verifyCleanCheckout(checkoutPath, input.signal);
  await verifyNoUnreachableObjects(checkoutPath, input.signal);
  await verifyIndependentGitStorage(checkoutPath, input.signal);
  await verifyNoRemotes(checkoutPath, input.signal);
  await verifyNoNamedRefs(checkoutPath, input.signal);
}

async function createReviewCheckoutContext(
  repositoryRoot: string,
): Promise<ReviewCheckoutContext> {
  const temporaryRoot = await fs.promises.realpath(os.tmpdir());
  const temporaryParent = await fs.promises.mkdtemp(
    path.join(temporaryRoot, TEMP_PREFIX),
  );
  const realTemporaryParent = await fs.promises.realpath(temporaryParent);
  assertOwnedTemporaryParent(temporaryRoot, realTemporaryParent);
  const checkoutPath = path.join(realTemporaryParent, 'checkout');
  const hooksPath = path.join(realTemporaryParent, 'empty-hooks');
  await fs.promises.mkdir(hooksPath, { mode: 0o700 });
  return {
    repositoryRoot,
    temporaryRoot,
    temporaryParent: realTemporaryParent,
    checkoutPath,
    hooksPath,
  };
}

async function removeAllRemotes(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const remoteNames = (
    await runGit(checkoutPath, ['remote'], signal)
  ).stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const remoteName of remoteNames) {
    await runGit(checkoutPath, ['remote', 'remove', remoteName], signal);
  }
  await verifyNoRemotes(checkoutPath, signal);
}

async function removeSourceCloneProvenance(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(
    checkoutPath,
    [
      'reflog',
      'expire',
      '--expire=now',
      '--expire-unreachable=now',
      '--all',
    ],
    signal,
  );
  const remaining = (
    await runGit(
      checkoutPath,
      ['reflog', 'show', '--all', '--format=%gs'],
      signal,
    )
  ).stdout.trim();
  if (remaining.length > 0) {
    throw new Error('detached review clone retained source provenance');
  }
}

async function removeAllNamedRefs(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const refName of await listNamedRefs(checkoutPath, signal)) {
    await runGit(checkoutPath, ['update-ref', '-d', refName], signal);
  }
  await verifyNoNamedRefs(checkoutPath, signal);
}

async function pruneUnboundGitObjects(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(
    checkoutPath,
    [
      '-c',
      'gc.cruftPacks=false',
      'repack',
      '-A',
      '-d',
      '--no-write-bitmap-index',
    ],
    signal,
  );
  await runGit(
    checkoutPath,
    ['prune', '--expire=now'],
    signal,
  );
  await verifyNoUnreachableObjects(checkoutPath, signal);
}

async function disposeReviewCheckout(
  context: ReviewCheckoutContext,
): Promise<void> {
  assertOwnedTemporaryParent(context.temporaryRoot, context.temporaryParent);
  await removeTree(context.temporaryParent, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

function materializedWorktree(
  context: ReviewCheckoutContext,
): DetachedReviewWorktree {
  let isDisposed = false;
  return Object.freeze({
    checkoutPath: context.checkoutPath,
    verify: (binding: ReviewBinding, signal?: AbortSignal) =>
      verifyCheckout({
        repositoryRoot: context.repositoryRoot,
        checkoutPath: context.checkoutPath,
        binding,
        signal,
      }),
    dispose: async () => {
      if (isDisposed) return;
      await disposeReviewCheckout(context);
      isDisposed = true;
    },
  });
}

async function materializeIndependentClone(
  context: ReviewCheckoutContext,
  binding: ReviewBinding,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(
    context.temporaryParent,
    [
      'clone',
      '--no-local',
      '--no-hardlinks',
      '--no-checkout',
      '--',
      context.repositoryRoot,
      context.checkoutPath,
    ],
    signal,
  );
  await runGit(
    context.checkoutPath,
    [
      '-c',
      `core.hooksPath=${context.hooksPath}`,
      'checkout',
      '--detach',
      '--force',
      binding.headSha,
      '--',
    ],
    signal,
  );
  // Keep the hook override command-scoped. Persisting it would make the
  // independently cloned repository fail the same executable-config policy
  // enforced by every Nexus Git tool.
  await removeAllRemotes(context.checkoutPath, signal);
  await removeAllNamedRefs(context.checkoutPath, signal);
  await removeSourceCloneProvenance(context.checkoutPath, signal);
  await pruneUnboundGitObjects(context.checkoutPath, signal);
}

export async function createDetachedReviewWorktree(input: {
  readonly repositoryRoot: string;
  readonly binding: ReviewBinding;
  readonly signal?: AbortSignal;
}): Promise<DetachedReviewWorktree> {
  assertBindingShape(input.binding);
  const repositoryRoot = await canonicalDirectory(
    input.repositoryRoot,
    'review repository',
  );
  const context = await createReviewCheckoutContext(repositoryRoot);
  try {
    await materializeIndependentClone(context, input.binding, input.signal);
    await verifyCheckout({
      repositoryRoot,
      checkoutPath: context.checkoutPath,
      binding: input.binding,
      signal: input.signal,
    });
    return materializedWorktree(context);
  } catch (error) {
    try {
      await disposeReviewCheckout(context);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'detached review clone setup and cleanup failed',
      );
    }
    throw error;
  }
}

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { AsyncProcessGitRunner, assertSafeLocalGitConfigAsync, type AsyncGitRunner } from '../runtime/git-command';
import { openWorkspaceFileForRead } from '../orch/workspace-file';
import { canonicalJson } from './canonical-json';
import { DEFAULT_ORIENTATION_LIMITS, SECRET_BASENAME_PATTERN, SKIP_DIRECTORIES } from './orientation/orientation-types';
import { walkOrientationTreeAsync } from './orientation/orientation-walker';

const MAX_CANDIDATE_FILES = 512;
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const COMMIT_HASH = /^[a-f0-9]{40,64}$/u;

export interface WorkingTreeCandidateSnapshot {
  readonly source: 'git' | 'filesystem';
  readonly headSha: string | null;
  readonly fingerprint: string;
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly diff: string;
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
}

function abortIfNeeded(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isSafeCandidatePath(value: string): boolean {
  return Boolean(value) && !/[\0\r\n\\]/u.test(value) &&
    value !== '.' && value !== '..' && !path.posix.isAbsolute(value) &&
    !value.split('/').includes('..') && path.posix.normalize(value) === value;
}

/** Same scope as the source index: generated/runtime metadata and secrets are not product sources. */
function inCandidateScope(value: string): boolean {
  return !SECRET_BASENAME_PATTERN.test(path.posix.basename(value)) &&
    !value.split('/').slice(0, -1).some((segment) => SKIP_DIRECTORIES.has(segment));
}

function candidatePaths(raw: readonly string[]): { paths: string[]; reasons: string[] } {
  const reasons: string[] = [];
  if (raw.some((value) => !isSafeCandidatePath(value))) reasons.push('candidate has unsupported paths');
  const paths = [...new Set(raw.filter(isSafeCandidatePath).filter(inCandidateScope))].sort();
  if (paths.length > MAX_CANDIDATE_FILES) reasons.push(`candidate file limit ${MAX_CANDIDATE_FILES} reached`);
  return { paths: paths.slice(0, MAX_CANDIDATE_FILES), reasons };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readCandidateFile(scope: ProjectExecutionScope, relativePath: string, maxBytes: number): Buffer {
  if (!isSafeCandidatePath(relativePath) || !inCandidateScope(relativePath)) throw new Error('unsafe candidate source path');
  const handle = openWorkspaceFileForRead(scope, relativePath);
  try {
    if (handle.stat.size > maxBytes) throw new Error('candidate byte limit reached');
    const buffer = Buffer.alloc(handle.stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(handle.fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const content = buffer.subarray(0, read);
    const after = fs.fstatSync(handle.fd);
    const named = fs.lstatSync(handle.absolutePath);
    if (content.length !== handle.stat.size || after.size !== handle.stat.size ||
      after.mtimeMs !== handle.stat.mtimeMs || after.ctimeMs !== handle.stat.ctimeMs ||
      named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) {
      throw new Error('candidate file changed while being read');
    }
    return content;
  } finally {
    handle.close();
  }
}

type CandidateInventory = Pick<WorkingTreeCandidateSnapshot,
  'changedPaths' | 'deletedPaths' | 'untrackedPaths' | 'diff' | 'incompleteReasons'>;
type CandidateGitRead = (args: readonly string[]) => Promise<string>;

async function filesystemInventory(scope: ProjectExecutionScope, signal?: AbortSignal): Promise<CandidateInventory> {
  const walk = await walkOrientationTreeAsync(scope, {
    ...DEFAULT_ORIENTATION_LIMITS,
    maxFiles: MAX_CANDIDATE_FILES,
    maxFileBytes: MAX_CANDIDATE_BYTES,
    maxTotalBytes: MAX_CANDIDATE_BYTES,
  }, signal);
  const { paths, reasons } = candidatePaths(walk.files.map((file) => file.relativePath));
  const truncated = walk.truncated || walk.treeFingerprintParts.some((part) => part.includes('\0skip-size\0'));
  return { changedPaths: paths, deletedPaths: [], untrackedPaths: paths, diff: '',
    incompleteReasons: [...reasons, ...(truncated ? ['filesystem candidate index was truncated'] : [])] };
}

async function gitInventory(base: string, run: CandidateGitRead): Promise<CandidateInventory> {
  if (!COMMIT_HASH.test(base)) throw new Error('invalid candidate base commit');
  const [status, untracked] = await Promise.all([
    run(['diff', '--name-status', '-z', '--no-renames', base, '--']),
    run(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const reasons: string[] = [];
  const records = status.split('\0').filter(Boolean);
  if (records.length % 2 !== 0) reasons.push('candidate diff inventory was malformed');
  const tracked: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const file = records[index + 1]!;
    tracked.push(file);
    if (records[index] === 'D') deleted.push(file);
  }
  const newFiles = candidatePaths(untracked.split('\0').filter(Boolean));
  const changed = candidatePaths([...tracked, ...newFiles.paths]);
  const trackedPaths = changed.paths.filter((file) => tracked.includes(file));
  const diff = trackedPaths.length === 0 ? '' : await run([
    '-c', 'core.quotePath=false', 'diff', '--binary', '--full-index', '--unified=0',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', base, '--', ...trackedPaths.map((file) => `:(literal)${file}`),
  ]);
  return { changedPaths: changed.paths, deletedPaths: deleted.filter((file) => changed.paths.includes(file)),
    untrackedPaths: newFiles.paths, diff, incompleteReasons: [...reasons, ...newFiles.reasons, ...changed.reasons] };
}

async function fingerprintFiles(scope: ProjectExecutionScope, inventory: CandidateInventory, signal?: AbortSignal) {
  // Hash current bytes too: Git attributes/filters may normalize away a meaningful edit.
  const files: Array<{ path: string; hash: string; size: number }> = [];
  const reasons: string[] = [];
  let bytes = 0;
  for (const file of inventory.changedPaths.filter((value) => !inventory.deletedPaths.includes(value))) {
    abortIfNeeded(signal);
    try {
      const content = readCandidateFile(scope, file, MAX_CANDIDATE_BYTES - bytes);
      bytes += content.length;
      files.push({ path: file, hash: sha256(content), size: content.length });
    } catch {
      reasons.push(`candidate file unavailable or outside limits: ${file}`);
    }
    if (files.length % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { files, reasons };
}

/** Read-only fingerprint. Never stages files or writes objects/index; no Git is required for a new project. */
export async function captureWorkingTreeCandidate(input: {
  readonly scope: ProjectExecutionScope;
  readonly baseSha?: string;
  readonly git?: AsyncGitRunner;
  readonly signal?: AbortSignal;
}): Promise<WorkingTreeCandidateSnapshot> {
  abortIfNeeded(input.signal);
  const root = await fs.promises.realpath(input.scope.rootRealPath);
  if (root !== input.scope.rootRealPath) throw new Error('candidate checkout identity changed');
  const git = input.git ?? new AsyncProcessGitRunner();
  const run: CandidateGitRead = async (args) => {
    abortIfNeeded(input.signal);
    return (await git.run(root, args, { timeoutMs: GIT_TIMEOUT_MS })).stdout;
  };
  let headSha: string | null = null;
  try {
    await assertSafeLocalGitConfigAsync(git, root);
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (COMMIT_HASH.test(head)) headSha = head;
  } catch {
    abortIfNeeded(input.signal);
  }
  const inventory = headSha ? await gitInventory(input.baseSha ?? headSha, run)
    : await filesystemInventory(input.scope, input.signal);
  const { files, reasons } = await fingerprintFiles(input.scope, inventory, input.signal);
  if (headSha) {
    try {
      if ((await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== headSha) {
        reasons.push('candidate HEAD changed while snapshotting');
      }
    } catch {
      abortIfNeeded(input.signal);
      reasons.push('candidate HEAD could not be revalidated');
    }
  }
  const incompleteReasons = Object.freeze([...new Set([...inventory.incompleteReasons, ...reasons])]);
  const { diff, changedPaths, deletedPaths, untrackedPaths } = inventory;
  return Object.freeze({
    source: headSha ? 'git' : 'filesystem', headSha,
    fingerprint: sha256(canonicalJson({ headSha, diffHash: sha256(diff), changedPaths, deletedPaths, files })),
    changedPaths: Object.freeze(changedPaths), deletedPaths: Object.freeze(deletedPaths),
    untrackedPaths: Object.freeze(untrackedPaths), diff,
    complete: incompleteReasons.length === 0, incompleteReasons,
  });
}

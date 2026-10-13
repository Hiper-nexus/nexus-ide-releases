import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { AsyncProcessGitRunner, assertSafeLocalGitConfigAsync, type AsyncGitRunner } from '../runtime/git-command';
import { openWorkspaceFileForRead } from '../orch/workspace-file';
import { canonicalJson } from './canonical-json';
import { DEFAULT_ORIENTATION_LIMITS, SECRET_BASENAME_PATTERN, SKIP_DIRECTORIES } from './orientation/orientation-types';

const MAX_CANDIDATE_FILES = 512;
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// Orientation's build/vendor skips are performance hints, not review authority.
const AMBIGUOUS_SOURCE_DIRECTORIES = new Set(['build', 'vendor']);
const DEPENDENCY_RUNTIME_DIRECTORIES = new Set([...SKIP_DIRECTORIES].filter(name => !AMBIGUOUS_SOURCE_DIRECTORIES.has(name)));
// Keep the existing confidentiality boundary around provider/runtime dotdirs.
const PROTECTED_DIRECTORIES = new Set([...SKIP_DIRECTORIES].filter(name => name.startsWith('.') && !AMBIGUOUS_SOURCE_DIRECTORIES.has(name) || name === 'worktrees'));
const MAX_FILESYSTEM_ENTRIES = 4_096;
/** Coarse filesystem clocks (HFS+ 1 s, FAT 2 s): near the baseline counts as new. */
const STALE_MARGIN_MS = 2_000;

export interface WorkingTreeCandidateSnapshot {
  readonly source: 'git' | 'filesystem';
  readonly headSha: string | null;
  readonly fingerprint: string;
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly diff: string;
  /** Current files whose bytes were actually read and included in this fingerprint. */
  readonly coveredPaths?: readonly string[];
  /** Complete for the declared source boundary, not excluded runtime/secret bytes. */
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  /** Explicit dependency/runtime boundary, never a claim to have inspected these bytes. */
  readonly excludedPaths?: readonly string[];
  /** F-1301: untracked files untouched since the baseline; outside the delta and NOT reviewed. */
  readonly staleUntrackedPaths?: readonly string[];
  /**
   * F-1428: safe regular files beyond the declared content budget. Their bytes
   * were NOT read; size/mtime/ctime/inode keep them in the fingerprint, so a
   * later edit still changes the candidate. Declared, never hidden.
   */
  readonly unreadPaths?: readonly string[];
  /** F-1428: listed paths absent from the checkout (deleted/renamed after listing or claim); nothing to read. */
  readonly absentPaths?: readonly string[];
}

function abortIfNeeded(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isSafeCandidatePath(value: string): boolean {
  return Boolean(value) && !/[\0\r\n\\]/u.test(value) &&
    value !== '.' && value !== '..' && !path.posix.isAbsolute(value) &&
    !value.split('/').includes('..') && path.posix.normalize(value) === value;
}

/** A content-read policy only. Git inventory must retain every tracked path. */
function inCandidateScope(value: string): boolean {
  return !value.split('/').includes('.git') && !SECRET_BASENAME_PATTERN.test(path.posix.basename(value)) &&
    !value.split('/').slice(0, -1).some((segment) => PROTECTED_DIRECTORIES.has(segment) || SECRET_BASENAME_PATTERN.test(segment));
}

function candidatePaths(raw: readonly string[]): { paths: string[]; reasons: string[] } {
  const reasons: string[] = [];
  if (raw.some((value) => !isSafeCandidatePath(value))) reasons.push('candidate has unsupported paths');
  const paths = [...new Set(raw.filter(isSafeCandidatePath))].sort();
  for (const file of paths.slice(0, MAX_CANDIDATE_FILES)) if (!inCandidateScope(file)) reasons.push(`candidate content excluded by safety policy: ${file}`);
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
  'changedPaths' | 'deletedPaths' | 'untrackedPaths' | 'diff' | 'incompleteReasons' | 'excludedPaths' | 'staleUntrackedPaths'>;
type CandidateGitRead = (args: readonly string[]) => Promise<string>;

/** Declare limited filesystem coverage without descending into dependencies/runtime. */
async function filesystemInventory(scope: ProjectExecutionScope, signal?: AbortSignal): Promise<CandidateInventory> {
  const files: string[] = [];
  const reasons: string[] = [];
  const excluded: string[] = [];
  let entries = 0;
  let truncated = false;
  const startedAt = Date.now();
  const visit = async (relative: string, depth: number): Promise<void> => {
    abortIfNeeded(signal);
    if (truncated) return;
    if (++entries > MAX_FILESYSTEM_ENTRIES || depth > DEFAULT_ORIENTATION_LIMITS.maxDepth ||
      Date.now() - startedAt > GIT_TIMEOUT_MS) {
      truncated = true; return;
    }
    const absolute = path.join(scope.rootRealPath, relative);
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(absolute); }
    catch { reasons.push(`candidate path unavailable: ${relative}`); return; }
    const basename = path.posix.basename(relative);
    if (relative && (basename === '.git' || SECRET_BASENAME_PATTERN.test(basename))) {
      excluded.push(relative + (stat.isDirectory() ? '/' : '')); return;
    }
    if (relative && DEPENDENCY_RUNTIME_DIRECTORIES.has(basename) && (stat.isDirectory() || stat.isSymbolicLink())) {
      excluded.push(relative + '/'); return;
    }
    if (stat.isSymbolicLink()) { reasons.push(`candidate symbolic link not inspected: ${relative}`); return; }
    if (stat.isDirectory()) {
      let directory: fs.Dir;
      try {
        if (await fs.promises.realpath(absolute) !== absolute) { reasons.push(`candidate directory identity changed: ${relative}`); return; }
        directory = await fs.promises.opendir(absolute);
      }
      catch { reasons.push(`candidate directory unavailable: ${relative}`); return; }
      for await (const entry of directory) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (!isSafeCandidatePath(child)) { reasons.push('candidate has unsupported paths'); continue; }
        await visit(child, depth + 1);
        if (truncated) break;
      }
      try {
        const after = await fs.promises.lstat(absolute);
        if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
          reasons.push(`candidate directory changed while indexing: ${relative}`);
        }
      } catch { reasons.push(`candidate directory unavailable: ${relative}`); }
    } else if (stat.isFile()) {
      if (files.length >= MAX_CANDIDATE_FILES) { truncated = true; return; }
      files.push(relative);
      if (stat.size > MAX_CANDIDATE_BYTES) reasons.push('filesystem candidate index was truncated');
    } else reasons.push(`candidate special file not inspected: ${relative}`);
    if (entries % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  };
  await visit('', 0);
  const selected = candidatePaths(files);
  if (excluded.length > MAX_CANDIDATE_FILES) reasons.push('candidate exclusion inventory limit reached');
  return { changedPaths: selected.paths, deletedPaths: [], untrackedPaths: selected.paths, diff: '', excludedPaths: excluded.sort().slice(0, MAX_CANDIDATE_FILES),
    incompleteReasons: [...reasons, ...selected.reasons, ...(truncated ? ['filesystem candidate index was truncated'] : [])] };
}

/**
 * F-1301: untracked files whose bytes and inode metadata predate the mission
 * baseline are not that mission's delta (another agent's WIP in a shared
 * checkout). ctime cannot be set back from user space; any later write,
 * rename or copy moves it past the baseline and the file re-enters the delta.
 * Symlinks and paths whose parents resolve elsewhere stay in the delta.
 */
async function untouchedSince(root: string, files: readonly string[], since: number): Promise<Set<string>> {
  const untouched = new Set<string>();
  for (const file of files.slice(0, MAX_FILESYSTEM_ENTRIES)) {
    const absolute = path.join(root, file);
    try {
      if (await fs.promises.realpath(path.dirname(absolute)) !== path.dirname(absolute)) continue;
      const stat = await fs.promises.lstat(absolute);
      if (stat.isFile() && Math.max(stat.ctimeMs, stat.mtimeMs) < since - STALE_MARGIN_MS) untouched.add(file);
    } catch { /* unreadable stays in the delta and is reported by the read */ }
  }
  return untouched;
}

async function gitInventory(base: string, run: CandidateGitRead, currentState = false,
  preexisting?: (files: readonly string[]) => Promise<Set<string>>): Promise<CandidateInventory> {
  if (!COMMIT_HASH.test(base)) throw new Error('invalid candidate base commit');
  const [inventory, untracked, removed] = await Promise.all([
    currentState ? run(['ls-files', '--cached', '-z']) : run(['diff', '--name-status', '-z', '--no-renames', base, '--']),
    run(['ls-files', '--others', '--exclude-standard', '-z']),
    currentState ? run(['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', base, '--']) : Promise.resolve(''),
  ]);
  const reasons: string[] = [];
  const tracked: string[] = [];
  const deleted: string[] = [];
  if (currentState) {
    deleted.push(...removed.split('\0').filter(Boolean));
    tracked.push(...inventory.split('\0').filter(Boolean), ...deleted);
  } else {
    const records = inventory.split('\0').filter(Boolean);
    if (records.length % 2 !== 0) reasons.push('candidate diff inventory was malformed');
    for (let index = 0; index + 1 < records.length; index += 2) {
      tracked.push(records[index + 1]!);
      if (records[index] === 'D') deleted.push(records[index + 1]!);
    }
  }
  const untrackedNames = untracked.split('\0').filter(Boolean);
  const excluded = new Set(untrackedNames.filter(file => isSafeCandidatePath(file) &&
    (!inCandidateScope(file) || file.split('/').slice(0, -1).some(segment => DEPENDENCY_RUNTIME_DIRECTORIES.has(segment)))));
  const exclusions = [...new Set([...excluded].map(file => {
    const parts = file.split('/');
    const boundary = parts.slice(0, -1).findIndex(segment => DEPENDENCY_RUNTIME_DIRECTORIES.has(segment));
    return boundary >= 0 ? parts.slice(0, boundary + 1).join('/') + '/' : file;
  }))].sort();
  const untouched = preexisting && !currentState
    ? await preexisting(untrackedNames.filter(file => isSafeCandidatePath(file) && !excluded.has(file)))
    : new Set<string>();
  if (exclusions.length > MAX_CANDIDATE_FILES) reasons.push('candidate exclusion inventory limit reached');
  const newFiles = candidatePaths(untrackedNames.filter(file => !excluded.has(file) && !untouched.has(file)));
  const changed = candidatePaths([...tracked, ...newFiles.paths]);
  // Never ask Git for secret/provider bodies, even for a tracked deletion.
  const trackedSet = new Set(tracked);
  const changedSet = new Set(changed.paths);
  const trackedPaths = changed.paths.filter(file => trackedSet.has(file) && inCandidateScope(file));
  const diff = currentState || trackedPaths.length === 0 ? '' : await run([
    '-c', 'core.quotePath=false', 'diff', '--binary', '--full-index', '--unified=0',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', base, '--', ...trackedPaths.map(file => `:(literal)${file}`),
  ]);
  return { changedPaths: changed.paths, deletedPaths: deleted.filter(file => changedSet.has(file)),
    untrackedPaths: newFiles.paths, diff, excludedPaths: exclusions.slice(0, MAX_CANDIDATE_FILES),
    ...(untouched.size > 0 ? { staleUntrackedPaths: [...untouched].sort() } : {}),
    incompleteReasons: [...reasons, ...newFiles.reasons, ...changed.reasons] };
}

/** Claimed deliverables outside the inspected inventory cannot inherit its proof. */
export function candidateCoverageReasons(
  candidate: Pick<WorkingTreeCandidateSnapshot, 'changedPaths' | 'deletedPaths' | 'coveredPaths' | 'unreadPaths' | 'absentPaths'>,
  requiredPaths: readonly string[],
): readonly string[] {
  // F-1428: a declared unread/absent path is accounted for, not silently missing.
  const covered = new Set([...(candidate.coveredPaths ?? candidate.changedPaths), ...candidate.deletedPaths,
    ...(candidate.unreadPaths ?? []), ...(candidate.absentPaths ?? [])]);
  const reasons = requiredPaths.length > MAX_CANDIDATE_FILES ? ['required candidate path limit reached'] : [];
  for (const file of requiredPaths.slice(0, MAX_CANDIDATE_FILES)) {
    if (!isSafeCandidatePath(file) || !covered.has(file)) reasons.push(`delivered candidate path was not inspected: ${JSON.stringify(file)}`);
  }
  return reasons;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

/** The nearest existing ancestor must be a physical directory inside the checkout (no symlinked parent). */
async function physicalAncestorInside(root: string, absolute: string): Promise<boolean> {
  for (let directory = path.dirname(absolute); directory.startsWith(root); directory = path.dirname(directory)) {
    try { return await fs.promises.realpath(directory) === directory; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return false; }
    if (directory === root) return false;
  }
  return false;
}

/**
 * F-1428: only bounded bytes are read, but every listed path is accounted for.
 * Beyond the content budget a safe regular file is declared unread and kept in
 * the fingerprint by metadata; an absent path is declared absent. Unsafe paths
 * (symlinks, hardlinks, special files, parents leaving the checkout, secret
 * names) still fail closed through `readCandidateFile`.
 */
async function fingerprintFiles(scope: ProjectExecutionScope, inventory: CandidateInventory, signal?: AbortSignal) {
  // Hash current bytes too: Git attributes/filters may normalize away a meaningful edit.
  const files: Array<{ path: string; hash: string; size: number }> = [];
  const unread: Array<{ path: string; size: number; mtimeMs: number; ctimeMs: number; ino: number }> = [];
  const absent: string[] = [];
  const reasons: string[] = [];
  let bytes = 0;
  let visited = 0;
  for (const file of inventory.changedPaths.filter((value) => !inventory.deletedPaths.includes(value))) {
    abortIfNeeded(signal);
    if (++visited % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const absolute = path.join(scope.rootRealPath, file);
    let stat: fs.Stats | null = null;
    try { stat = await fs.promises.lstat(absolute); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '') && isSafeCandidatePath(file) && inCandidateScope(file) &&
        await physicalAncestorInside(scope.rootRealPath, absolute)) { absent.push(file); continue; }
    }
    if (stat && stat.size > MAX_CANDIDATE_BYTES - bytes && stat.isFile() && stat.nlink === 1 &&
      isSafeCandidatePath(file) && inCandidateScope(file) && await physicalAncestorInside(scope.rootRealPath, absolute)) {
      unread.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
      continue;
    }
    try {
      const content = readCandidateFile(scope, file, MAX_CANDIDATE_BYTES - bytes);
      bytes += content.length;
      files.push({ path: file, hash: sha256(content), size: content.length });
    } catch {
      reasons.push(`candidate file not readable under the safety policy: ${file}`);
    }
  }
  return { files, unread, absent, reasons };
}

/** Read-only fingerprint. Never stages files or writes objects/index; no Git is required for a new project. */
export async function captureWorkingTreeCandidate(input: {
  readonly scope: ProjectExecutionScope;
  readonly baseSha?: string;
  /** Unknown baseline: inspect current files without claiming a historical delta. */
  readonly mode?: 'delta' | 'current-state';
  readonly git?: AsyncGitRunner;
  readonly signal?: AbortSignal;
  /** Repo-relative claimed deliverables; excluded paths cannot inherit source-only proof. */
  readonly requiredPaths?: readonly string[];
  /** Delta only: Main baseline observation time; untracked files untouched since then are excluded (F-1301). */
  readonly untrackedSince?: number;
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
  const since = input.untrackedSince;
  const inventory = headSha ? await gitInventory(input.baseSha ?? headSha, run, input.mode === 'current-state',
    since === undefined || !input.baseSha ? undefined : files => untouchedSince(root, files, since))
    : await filesystemInventory(input.scope, input.signal);
  const required = candidatePaths(input.requiredPaths ?? []);
  const requiredTracked = headSha && required.paths.length > 0
    ? new Set((await run(['ls-files', '--cached', '-z', '--', ...required.paths.map(file => `:(literal)${file}`)])).split('\0').filter(Boolean))
    : new Set<string>();
  const admittedRequired: string[] = [];
  for (const file of required.paths) {
    const runtimeBoundary = file.split('/').slice(0, -1).some(segment => DEPENDENCY_RUNTIME_DIRECTORIES.has(segment));
    if (!inCandidateScope(file) || runtimeBoundary && !requiredTracked.has(file) && !inventory.deletedPaths.includes(file)) {
      required.reasons.push(`delivered candidate path outside source boundary: ${JSON.stringify(file)}`);
    } else admittedRequired.push(file);
  }
  // Required artifacts can be unchanged since baseline. Hash them without
  // inventing a Git delta; their coverage is recorded separately below.
  const readTargets = candidatePaths([...inventory.changedPaths, ...admittedRequired]);
  const { files, unread, absent, reasons } = await fingerprintFiles(input.scope, { ...inventory, changedPaths: readTargets.paths }, input.signal);
  reasons.push(...required.reasons, ...readTargets.reasons);
  const coveredPaths = Object.freeze(files.map(file => file.path));
  const unreadPaths = Object.freeze(unread.map(file => file.path));
  const absentPaths = Object.freeze([...absent]);
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
  const incompleteReasons = Object.freeze([...new Set([...inventory.incompleteReasons, ...reasons,
    ...candidateCoverageReasons({ ...inventory, coveredPaths, unreadPaths, absentPaths }, input.requiredPaths ?? [])])]);
  const { diff, changedPaths, deletedPaths, untrackedPaths } = inventory;
  return Object.freeze({
    source: headSha ? 'git' : 'filesystem', headSha,
    // Unchanged shape when nothing was left out, so existing fingerprints stay stable.
    fingerprint: sha256(canonicalJson({ headSha, diffHash: sha256(diff), changedPaths, deletedPaths, files,
      ...(unread.length > 0 ? { unread } : {}), ...(absent.length > 0 ? { absent } : {}) })),
    changedPaths: Object.freeze(changedPaths), deletedPaths: Object.freeze(deletedPaths),
    untrackedPaths: Object.freeze(untrackedPaths), diff, coveredPaths,
    ...(unreadPaths.length > 0 ? { unreadPaths } : {}),
    ...(absentPaths.length > 0 ? { absentPaths } : {}),
    complete: incompleteReasons.length === 0, incompleteReasons, excludedPaths: Object.freeze(inventory.excludedPaths ?? []),
    // A declared deliverable read above is covered, not "outside the candidate".
    ...(inventory.staleUntrackedPaths?.some(file => !coveredPaths.includes(file))
      ? { staleUntrackedPaths: Object.freeze(inventory.staleUntrackedPaths.filter(file => !coveredPaths.includes(file))) } : {}),
  });
}

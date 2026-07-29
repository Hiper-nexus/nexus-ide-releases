import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { readWorkspaceTextFile } from '../../orch/workspace-file';
import {
  buildOrientationImportGraphFromFacts,
  buildOrientationImportGraphFromFactsAsync,
  extractOrientationImportSpecifiers,
  isOrientationImportSource,
  type ImportGraphBuildResult,
  type OrientationImportFileFact,
} from './orientation-import-graph';
import {
  filterOrientationChangedPaths,
  filterOrientationChangedPathsAsync,
  normalizeOrientationChangedPath,
} from './orientation-path-policy';
import {
  buildOrientationSymbolsFromFacts,
  buildOrientationSymbolsFromFactsAsync,
  extractOrientationDeclarations,
  type OrientationSymbolFileFact,
} from './orientation-symbols';
import {
  LANGUAGE_BY_EXT,
  SOURCE_EXTENSIONS,
  type OrientationLimits,
  type OrientationSymbolSummary,
} from './orientation-types';
import {
  sortOrientationItems,
  throwIfOrientationAborted,
  yieldOrientationWork,
} from './orientation-cooperative';
import type {
  OrientationWalkResult,
  WalkedFile,
} from './orientation-walker';

const MAX_DECLARATIONS_PER_FILE = 2_048;
const MAX_IMPORTS_PER_FILE = 4_096;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW;

export interface OrientationStructuralFile {
  readonly relativePath: string;
  readonly ext: string;
  readonly language: string | null;
  readonly size: number;
  readonly mtimeMs: number;
  readonly isSource: boolean;
  readonly isContentIndexed: boolean;
  readonly declarations: readonly string[];
  readonly importSpecifiers: readonly string[];
}

export interface OrientationStructuralIndex {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly headSha: string | null;
  readonly truncated: boolean;
  readonly files: readonly OrientationStructuralFile[];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function freezeFile(
  file: OrientationStructuralFile,
): OrientationStructuralFile {
  return Object.freeze({
    ...file,
    declarations: Object.freeze([...file.declarations]),
    importSpecifiers: Object.freeze([...file.importSpecifiers]),
  });
}

function readStructuralFile(
  scope: ProjectExecutionScope,
  candidate: string,
  limits: OrientationLimits,
): OrientationStructuralFile | null {
  const relativePath = normalizeOrientationChangedPath(candidate);
  if (!relativePath) return null;
  const root = fs.realpathSync(scope.rootRealPath);
  if (root !== scope.rootRealPath) {
    throw new Error('project root identity changed');
  }
  const absolute = path.join(root, ...relativePath.split('/'));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return null;
  }
  if (!isInside(root, real) || stat.size > limits.maxFileBytes) return null;

  const ext = path.posix.extname(relativePath).toLowerCase();
  const isSource = SOURCE_EXTENSIONS.has(ext);
  let isContentIndexed = false;
  let declarations: readonly string[] = Object.freeze([]);
  let importSpecifiers: readonly string[] = Object.freeze([]);
  if (isSource) {
    try {
      const read = readWorkspaceTextFile(scope, relativePath);
      isContentIndexed = true;
      declarations = extractOrientationDeclarations(read.content).slice(
        0,
        MAX_DECLARATIONS_PER_FILE,
      );
      if (isOrientationImportSource(ext)) {
        importSpecifiers = extractOrientationImportSpecifiers(
          read.content,
        ).slice(0, MAX_IMPORTS_PER_FILE);
      }
    } catch {
      // Keep safe metadata in the inventory; omit unreadable content facts.
    }
  }

  return freezeFile({
    relativePath,
    ext,
    language: LANGUAGE_BY_EXT[ext] ?? null,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    isSource,
    isContentIndexed,
    declarations,
    importSpecifiers,
  });
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readStructuralFileAsync(
  root: string,
  candidate: string,
  limits: OrientationLimits,
  signal?: AbortSignal,
): Promise<OrientationStructuralFile | null> {
  throwIfOrientationAborted(signal);
  const relativePath = normalizeOrientationChangedPath(candidate);
  if (!relativePath) return null;
  const absolute = path.join(root, ...relativePath.split('/'));
  let beforeOpen: fs.Stats;
  try {
    beforeOpen = await fs.promises.lstat(absolute);
  } catch {
    return null;
  }
  if (
    beforeOpen.isSymbolicLink() ||
    !beforeOpen.isFile() ||
    beforeOpen.nlink !== 1 ||
    beforeOpen.size > limits.maxFileBytes
  ) {
    return null;
  }
  let real: string;
  try {
    real = await fs.promises.realpath(absolute);
  } catch {
    return null;
  }
  if (
    !isInside(root, real) ||
    path.normalize(real) !== path.normalize(absolute)
  ) {
    return null;
  }

  const ext = path.posix.extname(relativePath).toLowerCase();
  const isSource = SOURCE_EXTENSIONS.has(ext);
  let isContentIndexed = false;
  let declarations: readonly string[] = Object.freeze([]);
  let importSpecifiers: readonly string[] = Object.freeze([]);
  let observedStat = beforeOpen;
  if (isSource) {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(absolute, READ_FLAGS);
      const descriptor = await handle.stat();
      const afterOpen = await fs.promises.lstat(absolute);
      if (
        !descriptor.isFile() ||
        descriptor.nlink !== 1 ||
        afterOpen.isSymbolicLink() ||
        !afterOpen.isFile() ||
        !sameInode(beforeOpen, descriptor) ||
        !sameInode(descriptor, afterOpen) ||
        descriptor.size > limits.maxFileBytes
      ) {
        return null;
      }
      const content = await handle.readFile({ encoding: 'utf8' });
      const afterRead = await handle.stat();
      if (
        !sameInode(descriptor, afterRead) ||
        descriptor.size !== afterRead.size ||
        descriptor.mtimeMs !== afterRead.mtimeMs
      ) {
        return null;
      }
      throwIfOrientationAborted(signal);
      observedStat = afterRead;
      isContentIndexed = true;
      declarations = extractOrientationDeclarations(content).slice(
        0,
        MAX_DECLARATIONS_PER_FILE,
      );
      if (isOrientationImportSource(ext)) {
        importSpecifiers = extractOrientationImportSpecifiers(content).slice(
          0,
          MAX_IMPORTS_PER_FILE,
        );
      }
    } catch {
      throwIfOrientationAborted(signal);
      // Keep safe metadata in the inventory; omit unreadable content facts.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return freezeFile({
    relativePath,
    ext,
    language: LANGUAGE_BY_EXT[ext] ?? null,
    size: observedStat.size,
    mtimeMs: observedStat.mtimeMs,
    isSource,
    isContentIndexed,
    declarations,
    importSpecifiers,
  });
}

function sortedFiles(
  files: Iterable<OrientationStructuralFile>,
): readonly OrientationStructuralFile[] {
  return Object.freeze(
    [...files].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)),
  );
}

export function buildOrientationStructuralIndex(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
  limits: OrientationLimits,
  headSha: string | null,
): OrientationStructuralIndex {
  const files: OrientationStructuralFile[] = [];
  for (const walked of walk.files) {
    const indexed = readStructuralFile(scope, walked.relativePath, limits);
    if (indexed) files.push(indexed);
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    headSha,
    truncated: walk.truncated,
    files: sortedFiles(files),
  });
}

export async function buildOrientationStructuralIndexAsync(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
  limits: OrientationLimits,
  headSha: string | null,
  signal?: AbortSignal,
): Promise<OrientationStructuralIndex> {
  throwIfOrientationAborted(signal);
  const root = await fs.promises.realpath(scope.rootRealPath);
  if (root !== scope.rootRealPath) {
    throw new Error('project root identity changed');
  }
  const files: OrientationStructuralFile[] = [];
  let processed = 0;
  for (const walked of walk.files) {
    const indexed = await readStructuralFileAsync(
      root,
      walked.relativePath,
      limits,
      signal,
    );
    if (indexed) files.push(indexed);
    processed += 1;
    if (processed % 128 === 0) await yieldOrientationWork(signal);
  }
  const sorted = await sortOrientationItems(
    files,
    (left, right) => left.relativePath.localeCompare(right.relativePath),
    signal,
  );
  return Object.freeze({
    schemaVersion: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    headSha,
    truncated: walk.truncated,
    files: sorted,
  });
}

export function updateOrientationStructuralIndex(
  scope: ProjectExecutionScope,
  current: OrientationStructuralIndex,
  changedPaths: readonly string[],
  limits: OrientationLimits,
  headSha: string | null,
): OrientationStructuralIndex {
  if (
    current.projectId !== scope.projectId ||
    current.checkoutId !== scope.checkoutId
  ) {
    throw new Error('orientation structural index scope mismatch');
  }
  if (current.truncated) {
    throw new Error('truncated orientation index requires a full rebuild');
  }

  const byPath = new Map(
    current.files.map((file) => [file.relativePath, file] as const),
  );
  for (const relativePath of filterOrientationChangedPaths(changedPaths)) {
    byPath.delete(relativePath);
    const updated = readStructuralFile(scope, relativePath, limits);
    if (updated) byPath.set(relativePath, updated);
  }

  const files = sortedFiles(byPath.values());
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > limits.maxFiles || totalBytes > limits.maxTotalBytes) {
    throw new Error('incremental orientation exceeded configured limits');
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    headSha,
    truncated: false,
    files,
  });
}

export async function updateOrientationStructuralIndexAsync(
  scope: ProjectExecutionScope,
  current: OrientationStructuralIndex,
  changedPaths: readonly string[],
  limits: OrientationLimits,
  headSha: string | null,
  signal?: AbortSignal,
): Promise<OrientationStructuralIndex> {
  if (
    current.projectId !== scope.projectId ||
    current.checkoutId !== scope.checkoutId
  ) {
    throw new Error('orientation structural index scope mismatch');
  }
  if (current.truncated) {
    throw new Error('truncated orientation index requires a full rebuild');
  }
  throwIfOrientationAborted(signal);
  const root = await fs.promises.realpath(scope.rootRealPath);
  if (root !== scope.rootRealPath) {
    throw new Error('project root identity changed');
  }

  const byPath = new Map<string, OrientationStructuralFile>();
  let processed = 0;
  for (const file of current.files) {
    byPath.set(file.relativePath, file);
    processed += 1;
    if (processed % 512 === 0) await yieldOrientationWork(signal);
  }
  const eligiblePaths = await filterOrientationChangedPathsAsync(
    changedPaths,
    signal,
  );
  for (const relativePath of eligiblePaths) {
    byPath.delete(relativePath);
    const updated = await readStructuralFileAsync(
      root,
      relativePath,
      limits,
      signal,
    );
    if (updated) byPath.set(relativePath, updated);
    processed += 1;
    if (processed % 128 === 0) await yieldOrientationWork(signal);
  }

  const files = await sortOrientationItems(
    [...byPath.values()],
    (left, right) => left.relativePath.localeCompare(right.relativePath),
    signal,
  );
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    totalBytes += files[index].size;
    if (index > 0 && index % 1_024 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  if (files.length > limits.maxFiles || totalBytes > limits.maxTotalBytes) {
    throw new Error('incremental orientation exceeded configured limits');
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    headSha,
    truncated: false,
    files,
  });
}

export function orientationWalkFromStructuralIndex(
  index: OrientationStructuralIndex,
): OrientationWalkResult {
  const files: WalkedFile[] = index.files.map((file) =>
    Object.freeze({
      relativePath: file.relativePath,
      ext: file.ext,
      language: file.language,
      size: file.size,
      isSource: file.isSource,
      isSecretName: false,
    }));
  return Object.freeze({
    files: Object.freeze(files),
    truncated: index.truncated,
    treeFingerprintParts: Object.freeze(
      index.files.map(
        (file) => `${file.relativePath}\0${file.size}\0${file.mtimeMs}`,
      ),
    ),
  });
}

export async function orientationWalkFromStructuralIndexAsync(
  index: OrientationStructuralIndex,
  signal?: AbortSignal,
): Promise<OrientationWalkResult> {
  const files: WalkedFile[] = [];
  const treeFingerprintParts: string[] = [];
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex += 1) {
    const file = index.files[fileIndex];
    files.push(Object.freeze({
      relativePath: file.relativePath,
      ext: file.ext,
      language: file.language,
      size: file.size,
      isSource: file.isSource,
      isSecretName: false,
    }));
    treeFingerprintParts.push(
      `${file.relativePath}\0${file.size}\0${file.mtimeMs}`,
    );
    if (fileIndex > 0 && fileIndex % 512 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  return Object.freeze({
    files: Object.freeze(files),
    truncated: index.truncated,
    treeFingerprintParts: Object.freeze(treeFingerprintParts),
  });
}

export function structuralIndexFingerprint(
  index: OrientationStructuralIndex,
): string {
  const hash = createHash('sha256');
  for (const part of orientationWalkFromStructuralIndex(index)
    .treeFingerprintParts) {
    hash.update(part).update('\n');
  }
  return hash.digest('hex');
}

export async function structuralIndexFingerprintAsync(
  index: OrientationStructuralIndex,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex += 1) {
    const file = index.files[fileIndex];
    hash
      .update(file.relativePath)
      .update('\0')
      .update(String(file.size))
      .update('\0')
      .update(String(file.mtimeMs))
      .update('\n');
    if (fileIndex > 0 && fileIndex % 1_024 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  return hash.digest('hex');
}

export function buildSymbolsFromStructuralIndex(
  index: OrientationStructuralIndex,
  limits: OrientationLimits,
): OrientationSymbolSummary {
  const facts: OrientationSymbolFileFact[] = index.files
    .filter((file) => file.isSource && file.isContentIndexed)
    .map((file) => Object.freeze({
      relativePath: file.relativePath,
      language: file.language,
      size: file.size,
      declarations: file.declarations,
    }));
  return buildOrientationSymbolsFromFacts(facts, limits);
}

export async function buildSymbolsFromStructuralIndexAsync(
  index: OrientationStructuralIndex,
  limits: OrientationLimits,
  signal?: AbortSignal,
): Promise<OrientationSymbolSummary> {
  const facts: OrientationSymbolFileFact[] = [];
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex += 1) {
    const file = index.files[fileIndex];
    if (file.isSource && file.isContentIndexed) {
      facts.push(Object.freeze({
        relativePath: file.relativePath,
        language: file.language,
        size: file.size,
        declarations: file.declarations,
      }));
    }
    if (fileIndex > 0 && fileIndex % 512 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  return buildOrientationSymbolsFromFactsAsync(facts, limits, signal);
}

export function buildImportGraphFromStructuralIndex(
  index: OrientationStructuralIndex,
  limits: OrientationLimits,
): ImportGraphBuildResult {
  const facts: OrientationImportFileFact[] = index.files
    .filter(
      (file) => file.isSource && isOrientationImportSource(file.ext),
    )
    .map((file) => Object.freeze({
      relativePath: file.relativePath,
      ext: file.ext,
      size: file.size,
      importSpecifiers: file.importSpecifiers,
    }));
  return buildOrientationImportGraphFromFacts(facts, limits);
}

export async function buildImportGraphFromStructuralIndexAsync(
  index: OrientationStructuralIndex,
  limits: OrientationLimits,
  signal?: AbortSignal,
): Promise<ImportGraphBuildResult> {
  const facts: OrientationImportFileFact[] = [];
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex += 1) {
    const file = index.files[fileIndex];
    if (file.isSource && isOrientationImportSource(file.ext)) {
      facts.push(Object.freeze({
        relativePath: file.relativePath,
        ext: file.ext,
        size: file.size,
        importSpecifiers: file.importSpecifiers,
      }));
    }
    if (fileIndex > 0 && fileIndex % 512 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  return buildOrientationImportGraphFromFactsAsync(facts, limits, signal);
}

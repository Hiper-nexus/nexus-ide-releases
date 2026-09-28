import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AsyncProcessGitRunner,
  type AsyncGitRunner,
} from '../runtime/git-command';
import { canonicalJson } from './canonical-json';
import { captureWorkingTreeCandidate, readCandidateFile } from './candidate-working-tree-snapshot';
import type {
  CandidateQualityLineRange,
  CandidateQualitySourceFact,
} from './candidate-quality-analysis';
import {
  DEFAULT_ORIENTATION_LIMITS,
  type OrientationLimits,
} from './orientation/orientation-types';
import {
  walkOrientationTreeAsync,
  type OrientationWalkResult,
} from './orientation/orientation-walker';
import type { ReviewFindingInput } from './review-council';

const ANALYZER_VERSION = 'candidate-quality-v1';
const MAX_CHANGED_FILES = 512;
const MAX_SOURCE_FILES = 1_500;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 384 * 1024;
const ANALYSIS_BUDGET_MS = 3_000;
const TS_JS_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

export interface RunCandidateQualityAnalysisInput {
  readonly scope: ProjectExecutionScope;
  readonly checkoutPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
  readonly changedFiles: readonly string[];
  /** Commit review is unchanged; civilian review explicitly includes current/untracked files. */
  readonly candidateSource?: 'commit' | 'working-tree';
  readonly signal?: AbortSignal;
}

export interface CandidateQualityAnalysis {
  readonly version: typeof ANALYZER_VERSION;
  readonly complete: boolean;
  readonly analysisHash: string;
  readonly findings: readonly ReviewFindingInput[];
  readonly inspectedFiles: number;
  readonly inspectedBytes: number;
  readonly incompleteReasons: readonly string[];
  readonly reviewerMarkdown: string;
  readonly candidateFingerprint?: string;
}

export interface CandidateQualityScannerDependencies {
  readonly git?: AsyncGitRunner;
  readonly walk?: (
    scope: ProjectExecutionScope,
    limits: OrientationLimits,
    signal?: AbortSignal,
  ) => Promise<OrientationWalkResult>;
  readonly now?: () => number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error =
    signal.reason instanceof Error
      ? signal.reason
      : new Error('candidate quality analysis aborted');
  error.name = 'AbortError';
  throw error;
}

function normalizeRelativePath(value: string): string | null {
  if (!value || /[\0\r\n\\]/u.test(value)) return null;
  const normalized = path.posix.normalize(value);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseAddedLines(diff: string): ReadonlyMap<string, readonly CandidateQualityLineRange[]> {
  const ranges = new Map<string, CandidateQualityLineRange[]>();
  let currentPath: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentPath = normalizeRelativePath(line.slice('+++ b/'.length));
      if (currentPath && !ranges.has(currentPath)) ranges.set(currentPath, []);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      currentPath = null;
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;
    const match = line.match(/\+(\d+)(?:,(\d+))?/u);
    if (!match) continue;
    const start = Number.parseInt(match[1]!, 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (count <= 0) continue;
    ranges.get(currentPath)!.push(
      Object.freeze({ start, end: start + count - 1 }),
    );
  }
  return new Map(
    [...ranges].map(([file, values]) => [
      file,
      Object.freeze([...values]),
    ]),
  );
}

async function readPhysicalSource(
  scope: ProjectExecutionScope,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  try {
    return readCandidateFile(scope, relativePath, MAX_FILE_BYTES).toString('utf8');
  } catch {
    return null;
  }
}

function boundedReason(reason: string): string {
  return reason.replace(/[\0\r\n]/gu, ' ').trim().slice(0, 512);
}

function reviewerMarkdown(input: {
  complete: boolean;
  analysisHash: string;
  findings: readonly ReviewFindingInput[];
  inspectedFiles: number;
  inspectedBytes: number;
  incompleteReasons: readonly string[];
  candidateSource?: 'git' | 'filesystem';
}): string {
  const findingLines = input.findings.slice(0, 32).map(
    (value) =>
      `- [${value.severity.toUpperCase()}] ${value.file}` +
      `${value.line ? `:${value.line}` : ''} — ${value.evidence}`,
  );
  return [
    '## Main-owned candidate quality preflight',
    `Analyzer: ${ANALYZER_VERSION}`,
    ...(input.candidateSource ? [input.candidateSource === 'git'
      ? 'Candidate: current working tree, including untracked files.'
      : 'Candidate: current directory files; Git comparison was unavailable.'] : []),
    `Evidence hash: ${input.analysisHash}`,
    `Status: ${input.complete ? 'complete' : 'partial — manual inspection is mandatory'}`,
    `Bounded index: ${input.inspectedFiles} files / ${input.inspectedBytes} bytes`,
    ...(input.incompleteReasons.length > 0
      ? [`Incomplete because: ${input.incompleteReasons.join('; ')}`]
      : []),
    '',
    ...(findingLines.length > 0
      ? ['Deterministic findings bound to this exact diff:', ...findingLines]
      : ['No deterministic finding was produced; this is not a substitute for independent review.']),
    '',
    'Independently inspect: unreachable/dead code, duplicated functions or exported APIs, process/module boundaries, integration blast radius, and missing tests or line-coverage evidence.',
    'Critical/high deterministic findings already block promotion; verify them and report any additional issue.',
  ].join('\n');
}

export async function runCandidateQualityAnalysis(
  input: RunCandidateQualityAnalysisInput,
  dependencies: CandidateQualityScannerDependencies = {},
): Promise<CandidateQualityAnalysis> {
  throwIfAborted(input.signal);
  const root = await fs.promises.realpath(path.resolve(input.checkoutPath));
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('candidate quality checkout is not a physical directory');
  }
  const git = dependencies.git ?? new AsyncProcessGitRunner();
  const scope = Object.freeze({ ...input.scope, rootRealPath: root });
  const snapshotInput = { scope, baseSha: input.baseSha, git, signal: input.signal };
  const snapshot = input.candidateSource === 'working-tree'
    ? await captureWorkingTreeCandidate(snapshotInput)
    : null;
  const requestedPaths = [...input.changedFiles, ...(snapshot?.changedPaths ?? [])];
  const changedFiles = requestedPaths
    .map(normalizeRelativePath)
    .filter((value): value is string => value !== null);
  const limitedChanged = [...new Set(changedFiles)].slice(0, MAX_CHANGED_FILES);
  const reasons: string[] = [...(snapshot?.incompleteReasons ?? [])];
  if (changedFiles.length !== requestedPaths.length) {
    reasons.push('one or more changed paths were unsafe');
  }
  if (new Set(changedFiles).size > MAX_CHANGED_FILES) {
    reasons.push(`changed-file limit ${MAX_CHANGED_FILES} reached`);
  }

  const observedHead = snapshot
    ? snapshot.headSha
    : (await git.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { timeoutMs: 5_000 })).stdout.trim();
  if (observedHead && observedHead.toLowerCase() !== input.headSha.toLowerCase()) {
    throw new Error('candidate quality checkout HEAD does not match review binding');
  }
  let addedLines: ReadonlyMap<string, readonly CandidateQualityLineRange[]> =
    new Map();
  let diffAvailable = false;
  try {
    const diff = snapshot ? { stdout: snapshot.diff } : await git.run(
      root,
      [
        'diff',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        input.baseSha,
        input.headSha,
        '--',
        ...limitedChanged,
      ],
      { timeoutMs: 10_000 },
    );
    addedLines = parseAddedLines(diff.stdout);
    diffAvailable = true;
  } catch (error) {
    reasons.push(
      boundedReason(
        `added-line diff unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  const deletedPaths = new Set(snapshot?.deletedPaths ?? []);
  const untrackedPaths = new Set(snapshot?.untrackedPaths ?? []);
  const limits = Object.freeze({
    ...DEFAULT_ORIENTATION_LIMITS,
    maxFileBytes: MAX_FILE_BYTES,
    buildBudgetMs: ANALYSIS_BUDGET_MS,
  });
  const walk = await (dependencies.walk ?? walkOrientationTreeAsync)(
    scope,
    limits,
    input.signal,
  );
  if (walk.truncated) reasons.push('bounded project index was truncated');

  const now = dependencies.now ?? Date.now;
  const deadline = now() + ANALYSIS_BUDGET_MS;
  const sources: CandidateQualitySourceFact[] = [];
  let inspectedBytes = 0;
  const walkedByPath = new Map(
    walk.files.map((file) => [file.relativePath, file]),
  );
  const changedDirectories = new Set(limitedChanged.map((file) => path.posix.dirname(file)));
  const changedRoots = new Set(limitedChanged.map((file) => file.split('/')[0]));
  const proximity = (file: string): number => changedDirectories.has(path.posix.dirname(file))
    ? 0 : changedRoots.has(file.split('/')[0]) ? 1 : 2;
  const unchangedSources = walk.files
    .filter((file) => file.isSource && TS_JS_EXTENSIONS.has(file.ext) && !limitedChanged.includes(file.relativePath))
    .sort((a, b) => proximity(a.relativePath) - proximity(b.relativePath) || a.relativePath.localeCompare(b.relativePath));
  const prioritizedFiles = [
    ...limitedChanged
      .filter((relativePath) =>
        !deletedPaths.has(relativePath) &&
        TS_JS_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()))
      .map(
        (relativePath) =>
          walkedByPath.get(relativePath) ?? {
            relativePath,
            ext: path.posix.extname(relativePath).toLowerCase(),
            language: null,
            size: 0,
            isSource: true,
            isSecretName: false,
          },
      ),
    ...unchangedSources,
  ];
  for (const file of prioritizedFiles) {
    throwIfAborted(input.signal);
    if (
      !file.isSource ||
      !TS_JS_EXTENSIONS.has(file.ext)
    ) {
      continue;
    }
    if (sources.length >= MAX_SOURCE_FILES) {
      reasons.push(`source file limit ${MAX_SOURCE_FILES} reached`);
      break;
    }
    if (now() > deadline) {
      reasons.push(`analysis time budget ${ANALYSIS_BUDGET_MS}ms reached`);
      break;
    }
    if (inspectedBytes + file.size > MAX_SOURCE_BYTES) {
      reasons.push(`source byte limit ${MAX_SOURCE_BYTES} reached`);
      continue;
    }
    let content: string | null = null;
    try {
      content = await readPhysicalSource(scope, file.relativePath, input.signal);
    } catch {
      throwIfAborted(input.signal);
    }
    if (content === null) {
      if (limitedChanged.includes(file.relativePath)) {
        reasons.push(`changed source could not be read: ${file.relativePath}`);
      }
      continue;
    }
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (inspectedBytes + contentBytes > MAX_SOURCE_BYTES) {
      reasons.push(`source byte limit ${MAX_SOURCE_BYTES} reached`);
      continue;
    }
    inspectedBytes += contentBytes;
    sources.push(Object.freeze({
      relativePath: file.relativePath,
      content,
      addedLines: untrackedPaths.has(file.relativePath)
        ? Object.freeze([{ start: 1, end: content.split('\n').length }])
        : addedLines.get(file.relativePath) ?? Object.freeze([]),
    }));
    if (
      diffAvailable &&
      limitedChanged.includes(file.relativePath) &&
      !untrackedPaths.has(file.relativePath) &&
      !addedLines.has(file.relativePath)
    ) {
      reasons.push(`changed source had no parseable diff header: ${file.relativePath}`);
    }
    if (sources.length % 32 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const sourcePathSet = new Set(sources.map((source) => source.relativePath));
  for (const changed of limitedChanged) {
    if (
      TS_JS_EXTENSIONS.has(path.posix.extname(changed).toLowerCase()) &&
      !deletedPaths.has(changed) &&
      !sourcePathSet.has(changed)
    ) {
      reasons.push(`changed source was outside the bounded index: ${changed}`);
    }
  }
  if (snapshot) {
    try {
      const after = await captureWorkingTreeCandidate(snapshotInput);
      reasons.push(...after.incompleteReasons);
      if (snapshot.fingerprint !== after.fingerprint) reasons.push('working-tree candidate changed during analysis');
      for (const source of sources) {
        if (await readPhysicalSource(scope, source.relativePath, input.signal) !== source.content) {
          reasons.push(`source changed during analysis: ${source.relativePath}`);
        }
      }
    } catch {
      throwIfAborted(input.signal);
      reasons.push('working-tree candidate could not be revalidated');
    }
  }
  const uniqueReasons = Object.freeze(
    [...new Set(reasons.map(boundedReason).filter(Boolean))].slice(0, 32),
  );
  // A análise carrega o compilador TypeScript inteiro (~70 MB de RSS no
  // main): só entra quando uma revisão roda, não no boot do app.
  const { analyzeCandidateQualityFacts } = await import('./candidate-quality-analysis');
  const findings = analyzeCandidateQualityFacts({
    changedFiles: limitedChanged,
    sources,
  });
  const complete = uniqueReasons.length === 0;
  const analysisHash = createHash('sha256')
    .update(canonicalJson({
      version: ANALYZER_VERSION,
      binding: {
        projectId: input.scope.projectId,
        checkoutId: input.scope.checkoutId,
        baseSha: input.baseSha,
        headSha: input.headSha,
        diffHash: input.diffHash,
        ...(snapshot ? { candidateFingerprint: snapshot.fingerprint } : {}),
        sources: sources.map((source) => ({
          path: source.relativePath,
          sha256: createHash('sha256').update(source.content).digest('hex'),
        })),
      },
      complete,
      findings,
      inspectedFiles: sources.length,
      inspectedBytes,
      incompleteReasons: uniqueReasons,
    }))
    .digest('hex');
  return Object.freeze({
    version: ANALYZER_VERSION,
    complete,
    analysisHash,
    findings,
    inspectedFiles: sources.length,
    inspectedBytes,
    incompleteReasons: uniqueReasons,
    reviewerMarkdown: reviewerMarkdown({
      complete,
      analysisHash,
      findings,
      inspectedFiles: sources.length,
      inspectedBytes,
      incompleteReasons: uniqueReasons,
      candidateSource: snapshot?.source,
    }),
    ...(snapshot ? { candidateFingerprint: snapshot.fingerprint } : {}),
  });
}

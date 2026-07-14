import {
  benchmarkManifestHash,
  benchmarkRunId,
  evidenceHash,
  verifyBenchmarkJournal,
  type BenchmarkJournalEntry,
  type BenchmarkRunManifest,
} from './benchmark-contract';
import { DEFAULT_N_MIN, rankAllModels } from './ranker';
import type { EvalCaseResult, ModelCaseBundle, ModelRankResult } from './suite-types';
import type { BenchmarkJournalSink } from './benchmark-journal';

export const MAX_BENCHMARK_TEXT_CHARS = 256 * 1024;

export type BenchmarkJudgeWinner = 'A' | 'B' | 'none';

export interface BenchmarkCaseInput {
  caseId: string;
  prompt: string;
  /** Hidden reference stays in memory and is never written to the journal. */
  reference?: string;
}

export interface BenchmarkExecution {
  answer: string;
  durationMs: number;
  costUsd?: number;
  risk?: number;
}

export interface BenchmarkCompetitorInput {
  caseId: string;
  prompt: string;
  subject: BenchmarkRunManifest['subjects'][number];
}

export interface BenchmarkJudgeInput {
  caseId: string;
  prompt: string;
  reference?: string;
  /** Blind judge boundary: identities are deliberately absent. */
  answerA: string;
  answerB: string;
}

export interface BenchmarkJudgeDecision {
  winner: BenchmarkJudgeWinner;
  qualityA?: number;
  qualityB?: number;
}

export type BenchmarkCompetitorExecutor = (
  input: BenchmarkCompetitorInput,
) => Promise<BenchmarkExecution>;

export type BenchmarkJudge = (
  input: BenchmarkJudgeInput,
) => Promise<BenchmarkJudgeDecision>;

export interface BenchmarkRunOptions {
  manifest: BenchmarkRunManifest;
  cases: readonly BenchmarkCaseInput[];
  executeCompetitor: BenchmarkCompetitorExecutor;
  judge: BenchmarkJudge;
  journal?: BenchmarkJournalSink;
  now?: () => string;
}

export interface BenchmarkRunResult {
  runId: string;
  manifestHash: string;
  evaluatedAt: string;
  entries: BenchmarkJournalEntry[];
  bundles: ModelCaseBundle[];
  ranks: ModelRankResult[];
}

type ExecutionAttempt = {
  ok: true;
  value: BenchmarkExecution;
} | {
  ok: false;
  errorCode: string;
};

interface MatchResult {
  entry: BenchmarkJournalEntry;
  caseResultA: EvalCaseResult;
  caseResultB: EvalCaseResult;
}

const DEFAULT_TIMESTAMP = () => new Date().toISOString();

function assertText(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BENCHMARK_TEXT_CHARS) {
    throw new Error(`${label} must be non-empty and at most ${MAX_BENCHMARK_TEXT_CHARS} characters`);
  }
}

function boundedMetric(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error('benchmark metric must be finite');
  return Math.max(0, Math.min(1, value));
}

function validateExecution(value: BenchmarkExecution): BenchmarkExecution {
  assertText(value.answer, 'benchmark answer');
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new Error('benchmark durationMs must be a non-negative finite number');
  }
  if (value.costUsd !== undefined && (!Number.isFinite(value.costUsd) || value.costUsd < 0)) {
    throw new Error('benchmark costUsd must be a non-negative finite number');
  }
  return {
    answer: value.answer,
    durationMs: value.durationMs,
    costUsd: value.costUsd,
    risk: boundedMetric(value.risk),
  };
}

function validateDecision(value: BenchmarkJudgeDecision): BenchmarkJudgeDecision {
  if (!value || !['A', 'B', 'none'].includes(value.winner)) {
    throw new Error('benchmark judge returned an invalid winner');
  }
  return {
    winner: value.winner,
    qualityA: boundedMetric(value.qualityA),
    qualityB: boundedMetric(value.qualityB),
  };
}

async function tryExecute(
  executor: BenchmarkCompetitorExecutor,
  input: BenchmarkCompetitorInput,
): Promise<ExecutionAttempt> {
  try {
    return { ok: true, value: validateExecution(await executor(input)) };
  } catch (error) {
    return { ok: false, errorCode: error instanceof Error ? error.name : 'execution-error' };
  }
}

function matchId(
  runId: string,
  caseId: string,
  subjectA: string,
  subjectB: string,
): string {
  return `match-${evidenceHash({ runId, caseId, subjectA, subjectB }).slice(0, 20)}`;
}

function resultFor(
  subjectId: string,
  winnerId: string | null,
  outcome: BenchmarkJournalEntry['outcome'],
  execution: ExecutionAttempt,
  qualityExtra: number | undefined,
): EvalCaseResult {
  const pass = outcome === 'no-contest' ? 0.5 : winnerId === subjectId ? 1 : 0;
  return {
    caseId: '',
    dimension: 'coding',
    pass,
    qualityExtra: qualityExtra ?? pass,
    ...(execution.ok
      ? {
          costUsd: execution.value.costUsd,
          durationMs: execution.value.durationMs,
          risk: execution.value.risk,
        }
      : { risk: 1 }),
  };
}

async function runMatch(
  options: BenchmarkRunOptions,
  runId: string,
  manifestHash: string,
  caseInput: BenchmarkCaseInput,
  caseMeta: BenchmarkRunManifest['cases'][number],
  subjectA: BenchmarkRunManifest['subjects'][number],
  subjectB: BenchmarkRunManifest['subjects'][number],
  sequence: number,
  timestamp: string,
): Promise<MatchResult> {
  const [attemptA, attemptB] = await Promise.all([
    tryExecute(options.executeCompetitor, { caseId: caseInput.caseId, prompt: caseInput.prompt, subject: subjectA }),
    tryExecute(options.executeCompetitor, { caseId: caseInput.caseId, prompt: caseInput.prompt, subject: subjectB }),
  ]);

  let decision: BenchmarkJudgeDecision | null = null;
  if (attemptA.ok && attemptB.ok) {
    try {
      decision = validateDecision(await options.judge({
        caseId: caseInput.caseId,
        prompt: caseInput.prompt,
        reference: caseInput.reference,
        answerA: attemptA.value.answer,
        answerB: attemptB.value.answer,
      }));
    } catch {
      decision = null;
    }
  }

  const outcome: BenchmarkJournalEntry['outcome'] =
    decision?.winner === 'A' || decision?.winner === 'B'
      ? 'judged'
      : attemptA.ok !== attemptB.ok
        ? 'forfeit'
        : 'no-contest';
  const winnerId =
    outcome === 'judged'
      ? decision?.winner === 'A' ? subjectA.id : subjectB.id
      : outcome === 'forfeit'
        ? attemptA.ok ? subjectA.id : subjectB.id
        : null;
  const id = matchId(runId, caseInput.caseId, subjectA.id, subjectB.id);
  const entry: BenchmarkJournalEntry = {
    version: 1,
    runId,
    manifestHash,
    sequence,
    matchId: id,
    caseId: caseInput.caseId,
    subjectA: subjectA.id,
    subjectB: subjectB.id,
    outcome,
    winnerId,
    evidenceHash: evidenceHash({
      caseId: caseInput.caseId,
      casePublicHash: caseMeta.publicHash,
      casePrivateHash: caseMeta.privateHash,
      answerA: attemptA.ok ? evidenceHash(attemptA.value.answer) : null,
      answerB: attemptB.ok ? evidenceHash(attemptB.value.answer) : null,
      executionA: attemptA.ok ? attemptA.value : attemptA.errorCode,
      executionB: attemptB.ok ? attemptB.value : attemptB.errorCode,
      decision,
    }),
    timestamp,
  };
  const qualityA = outcome === 'judged' ? decision?.qualityA : undefined;
  const qualityB = outcome === 'judged' ? decision?.qualityB : undefined;
  return {
    entry,
    caseResultA: {
      ...resultFor(subjectA.id, winnerId, outcome, attemptA, qualityA),
      caseId: caseInput.caseId,
      dimension: caseMeta.dimension,
    },
    caseResultB: {
      ...resultFor(subjectB.id, winnerId, outcome, attemptB, qualityB),
      caseId: caseInput.caseId,
      dimension: caseMeta.dimension,
    },
  };
}

export async function runBenchmarkSuite(options: BenchmarkRunOptions): Promise<BenchmarkRunResult> {
  const caseMap = new Map<string, BenchmarkCaseInput>();
  for (const item of options.cases) {
    if (caseMap.has(item.caseId)) throw new Error(`duplicate benchmark case input: ${item.caseId}`);
    assertText(item.caseId, 'benchmark caseId');
    assertText(item.prompt, 'benchmark prompt');
    if (item.reference !== undefined) assertText(item.reference, 'benchmark reference');
    caseMap.set(item.caseId, item);
  }
  const manifestCases = new Map(options.manifest.cases.map((item) => [item.id, item]));
  if (caseMap.size !== manifestCases.size || [...manifestCases.keys()].some((id) => !caseMap.has(id))) {
    throw new Error('benchmark case inputs must exactly match the manifest cases');
  }

  const now = options.now ?? DEFAULT_TIMESTAMP;
  const evaluatedAt = new Date(now()).toISOString();
  const runId = benchmarkRunId(options.manifest);
  const manifestHash = benchmarkManifestHash(options.manifest);
  const results: MatchResult[] = [];
  let sequence = 1;

  for (const caseMeta of options.manifest.cases) {
    const caseInput = caseMap.get(caseMeta.id);
    if (!caseInput) throw new Error(`missing benchmark case input: ${caseMeta.id}`);
    for (let left = 0; left < options.manifest.subjects.length; left += 1) {
      for (let right = left + 1; right < options.manifest.subjects.length; right += 1) {
        results.push(await runMatch(
          options,
          runId,
          manifestHash,
          caseInput,
          caseMeta,
          options.manifest.subjects[left],
          options.manifest.subjects[right],
          sequence,
          evaluatedAt,
        ));
        sequence += 1;
      }
    }
  }

  const entries = results.map((result) => result.entry);
  verifyBenchmarkJournal(entries, options.manifest);
  if (options.journal) {
    for (const entry of entries) await options.journal.append(entry);
  }

  const casesBySubject = new Map<string, EvalCaseResult[]>();
  for (const subject of options.manifest.subjects) casesBySubject.set(subject.id, []);
  for (const result of results) {
    casesBySubject.get(result.entry.subjectA)?.push(result.caseResultA);
    casesBySubject.get(result.entry.subjectB)?.push(result.caseResultB);
  }
  const bundles: ModelCaseBundle[] = options.manifest.subjects.map((subject) => ({
    subject: {
      adapterId: subject.adapterId,
      modelId: subject.modelId,
    },
    cases: casesBySubject.get(subject.id) ?? [],
  }));
  const ranks = rankAllModels(bundles, {
    suiteId: options.manifest.suiteId,
    suiteRevision: options.manifest.suiteRevision,
    evaluatedAt,
    nMinPerDimension: DEFAULT_N_MIN,
  });
  return { runId, manifestHash, evaluatedAt, entries, bundles, ranks };
}

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { benchmarkManifestHash, benchmarkRunId, type BenchmarkRunManifest } from './benchmark-contract';
import { runBenchmarkSuite, type BenchmarkJudgeInput } from './benchmark-runner';
import type { BenchmarkJournalSink } from './benchmark-journal';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function manifest(caseIds = ['case-001']): BenchmarkRunManifest {
  return {
    version: 1,
    methodology: 'nexus-bench-v1',
    suiteId: 'runner-smoke',
    suiteRevision: 'v1',
    seed: 'fixed-seed',
    promptPolicyHash: hash('judge-policy'),
    subjects: [
      { id: 'alpha', adapterId: 'alpha-cli', modelId: 'alpha-model' },
      { id: 'beta', adapterId: 'beta-cli', modelId: 'beta-model' },
    ],
    cases: caseIds.map((id, index) => ({
      id,
      dimension: index % 2 === 0 ? 'security' : 'coding',
      revision: '1',
      publicHash: hash(`public:${id}`),
      privateHash: hash(`private:${id}`),
    })),
  };
}

function collectingJournal(entries: unknown[] = []): BenchmarkJournalSink & { entries: unknown[] } {
  return {
    entries,
    append: async (entry) => {
      entries.push(entry);
    },
  };
}

describe('benchmark runner', () => {
  it('runs blind head-to-head matches and feeds verified outcomes into the ranker', async () => {
    const input = manifest();
    const journal = collectingJournal();
    const seenJudgeInputs: BenchmarkJudgeInput[] = [];

    const result = await runBenchmarkSuite({
      manifest: input,
      cases: [{ caseId: 'case-001', prompt: 'Find the reachable security issue.', reference: 'expected' }],
      executeCompetitor: async ({ subject }) => ({
        answer: `${subject.id}-answer`,
        durationMs: subject.id === 'alpha' ? 100 : 120,
        costUsd: 0.01,
      }),
      judge: async (judgeInput) => {
        seenJudgeInputs.push(judgeInput);
        return { winner: 'A', qualityA: 0.9, qualityB: 0.6 };
      },
      journal,
      now: () => '2026-07-14T12:00:00.000Z',
    });

    expect(seenJudgeInputs[0]).toMatchObject({
      caseId: 'case-001',
      prompt: 'Find the reachable security issue.',
      reference: 'expected',
      answerA: 'alpha-answer',
      answerB: 'beta-answer',
    });
    expect(seenJudgeInputs[0]).not.toHaveProperty('subjectA');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      outcome: 'judged',
      winnerId: 'alpha',
      sequence: 1,
      runId: benchmarkRunId(input),
      manifestHash: benchmarkManifestHash(input),
    });
    expect(JSON.stringify(result.entries[0])).not.toContain('alpha-answer');
    expect(result.ranks[0]?.subject.adapterId).toBe('alpha-cli');
    expect(result.bundles.find((bundle) => bundle.subject.adapterId === 'alpha-cli')?.cases[0]?.pass).toBe(1);
  });

  it('records one-sided failures as forfeits and two-sided failures as no-contest', async () => {
    const input = manifest(['case-001', 'case-002']);
    const journal = collectingJournal();
    const result = await runBenchmarkSuite({
      manifest: input,
      cases: [
        { caseId: 'case-001', prompt: 'first' },
        { caseId: 'case-002', prompt: 'second' },
      ],
      executeCompetitor: async ({ caseId, subject }) => {
        if (caseId === 'case-001' && subject.id === 'beta') throw new Error('beta unavailable');
        if (caseId === 'case-001' && subject.id === 'alpha') {
          return { answer: 'alpha-answer', durationMs: 100 };
        }
        throw new Error(`${subject.id} unavailable`);
      },
      judge: async () => ({ winner: 'A' }),
      journal,
      now: () => '2026-07-14T12:00:00.000Z',
    });

    expect(result.entries.map((entry) => entry.outcome)).toEqual(['forfeit', 'no-contest']);
    expect(result.entries[0]?.winnerId).toBe('alpha');
    expect(result.entries[1]?.winnerId).toBeNull();
    expect(result.entries[0]?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

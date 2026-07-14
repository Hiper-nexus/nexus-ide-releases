import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  benchmarkManifestHash,
  benchmarkRunId,
  evidenceHash,
  verifyBenchmarkJournal,
  type BenchmarkRunManifest,
} from './benchmark-contract';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function manifest(): BenchmarkRunManifest {
  return {
    version: 1,
    methodology: 'nexus-bench-v1',
    suiteId: 'smoke',
    suiteRevision: 'v1',
    seed: '2026-07-14',
    promptPolicyHash: hash('policy'),
    subjects: [
      { id: 'claude/sonnet', adapterId: 'claude', modelId: 'sonnet' },
      { id: 'codex/default', adapterId: 'codex', modelId: 'default' },
    ],
    cases: [
      {
        id: 'case-001',
        dimension: 'security',
        revision: '1.0.0',
        publicHash: hash('public'),
        privateHash: hash('private'),
      },
    ],
  };
}

describe('benchmark contract', () => {
  it('binds a journal to immutable manifest identity', () => {
    const input = manifest();
    const runId = benchmarkRunId(input);
    const manifestHash = benchmarkManifestHash(input);
    const verified = verifyBenchmarkJournal(
      [
        {
          version: 1,
          runId,
          manifestHash,
          sequence: 1,
          matchId: 'match-001',
          caseId: 'case-001',
          subjectA: 'claude/sonnet',
          subjectB: 'codex/default',
          outcome: 'judged',
          winnerId: 'claude/sonnet',
          evidenceHash: evidenceHash({ answer: 'a' }),
          timestamp: '2026-07-14T12:00:00.000Z',
        },
      ],
      input,
    );

    expect(verified.entries).toHaveLength(1);
    expect(verified.manifestHash).toBe(manifestHash);
  });

  it('rejects tampered hashes, duplicate matches, and invalid winners', () => {
    const input = manifest();
    const base = {
      version: 1,
      runId: benchmarkRunId(input),
      manifestHash: benchmarkManifestHash(input),
      sequence: 1,
      matchId: 'match-001',
      caseId: 'case-001',
      subjectA: 'claude/sonnet',
      subjectB: 'codex/default',
      outcome: 'judged',
      winnerId: 'other/model',
      evidenceHash: evidenceHash({ answer: 'a' }),
      timestamp: '2026-07-14T12:00:00.000Z',
    };

    expect(() => verifyBenchmarkJournal([base], input)).toThrow(/invalid winner/);
    expect(() => verifyBenchmarkJournal([{ ...base, winnerId: null, outcome: 'no-contest' }, { ...base, sequence: 2 }], input)).toThrow(/duplicate matchId/);
    expect(() => verifyBenchmarkJournal([{ ...base, winnerId: null, manifestHash: hash('tampered') }], input)).toThrow(/different manifest hash/);
  });
});

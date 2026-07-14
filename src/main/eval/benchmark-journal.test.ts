import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { benchmarkManifestHash, benchmarkRunId, evidenceHash, type BenchmarkRunManifest } from './benchmark-contract';
import { createJsonlBenchmarkJournal } from './benchmark-journal';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function manifest(): BenchmarkRunManifest {
  return {
    version: 1,
    methodology: 'nexus-bench-v1',
    suiteId: 'journal-smoke',
    suiteRevision: 'v1',
    seed: 'fixed-seed',
    promptPolicyHash: hash('policy'),
    subjects: [
      { id: 'alpha', adapterId: 'alpha-cli', modelId: 'alpha-model' },
      { id: 'beta', adapterId: 'beta-cli', modelId: 'beta-model' },
    ],
    cases: [{
      id: 'case-001',
      dimension: 'security',
      revision: '1',
      publicHash: hash('public'),
      privateHash: null,
    }],
  };
}

function entry(input: BenchmarkRunManifest) {
  return {
    version: 1 as const,
    runId: benchmarkRunId(input),
    manifestHash: benchmarkManifestHash(input),
    sequence: 1,
    matchId: 'match-001',
    caseId: 'case-001',
    subjectA: 'alpha',
    subjectB: 'beta',
    outcome: 'no-contest' as const,
    winnerId: null,
    evidenceHash: evidenceHash({ answerA: hash('a'), answerB: hash('b') }),
    timestamp: '2026-07-14T12:00:00.000Z',
  };
}

describe('JSONL benchmark journal', () => {
  it('appends entries and verifies the complete file before every append', async () => {
    const input = manifest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bench-journal-'));
    const file = path.join(dir, 'runs', 'journal.jsonl');
    const journal = createJsonlBenchmarkJournal(file, input);

    await journal.append(entry(input));
    expect(journal.read()).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses to append after an existing line was tampered with', async () => {
    const input = manifest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bench-journal-'));
    const file = path.join(dir, 'journal.jsonl');
    const journal = createJsonlBenchmarkJournal(file, input);

    await journal.append(entry(input));
    fs.writeFileSync(file, `${JSON.stringify({ ...entry(input), winnerId: 'beta' })}\n`);

    expect(() => journal.read()).toThrow();
    await expect(journal.append({ ...entry(input), sequence: 2, matchId: 'match-002' })).rejects.toThrow();
  });
});

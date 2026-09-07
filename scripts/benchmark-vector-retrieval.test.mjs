import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptDir);
const benchPath = path.join(repositoryRoot, 'scripts', 'benchmark-vector-retrieval.mjs');

/**
 * Small enough to run in a couple of seconds, large enough that the cosine scan
 * is doing real work rather than measuring loop overhead.
 */
const SMALL_ROWS = '2000';

function runBenchmark(env = {}) {
  const result = spawnSync(process.execPath, [benchPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, VECTOR_BENCH_ROWS: SMALL_ROWS, VECTOR_BENCH_RUNS: '5', ...env },
  });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `benchmark did not emit JSON (exit ${result.status}).\n` +
        `stdout: ${result.stdout.slice(0, 500)}\nstderr: ${result.stderr.slice(0, 500)}`,
    );
  }
  return { status: result.status, report };
}

describe('benchmark-vector-retrieval', () => {
  const { status, report } = runBenchmark();

  it('exits 0 and reports the vector measurement', () => {
    expect(status).toBe(0);
    expect(report.rows).toBe(Number(SMALL_ROWS));
    expect(report.topK).toBe(64);
    expect(report.cosineTopKMs.p50).toBeGreaterThan(0);
    expect(report.cosineTopKMs.p95).toBeGreaterThanOrEqual(report.cosineTopKMs.p50);
    expect(report.vectorStoreBytes).toBe(report.rows * report.dim * 4);
  });

  it('answers the extension question with a verdict, not just numbers', () => {
    // This is the property the script exists for: a reader should not have to
    // re-derive the conclusion from the timings.
    expect(typeof report.verdict.bruteForceWithinBudget).toBe('boolean');
    expect(report.verdict.needsVectorIndexExtension).toBe(
      !report.verdict.bruteForceWithinBudget,
    );
    expect(report.verdict.note).toContain(String(report.rows));
  });

  it('measures the vector channel even when better-sqlite3 cannot load', () => {
    // better-sqlite3's ABI legitimately flips between Node and Electron during
    // normal development (rebuild:node vs rebuild:electron). The lexical half
    // reports that as data instead of failing the run, because the decision the
    // script supports does not depend on it. Asserted in whichever ABI state the
    // checkout happens to be in.
    if (report.lexical.bm25RecallMs) {
      expect(report.lexical.sqlite).toMatch(/^\d+\.\d+/);
      expect(report.lexical.bm25RecallMs.p50).toBeGreaterThan(0);
      expect(report.lexical.unavailable).toBeUndefined();
    } else {
      expect(typeof report.lexical.unavailable).toBe('string');
      expect(report.lexical.unavailable.length).toBeGreaterThan(0);
      // The verdict must still be present and still be about the vector channel.
      expect(typeof report.verdict.bruteForceWithinBudget).toBe('boolean');
    }
  });

  it('honours the dimension parameter, which is what a model choice changes', () => {
    const { report: wide } = runBenchmark({ VECTOR_BENCH_DIM: '512' });
    expect(wide.dim).toBe(512);
    expect(wide.vectorStoreBytes).toBe(wide.rows * 512 * 4);
    expect(wide.vectorStoreBytes).toBeGreaterThan(report.vectorStoreBytes);
  });

  it('honours the budget parameter, so the crossover can be probed', () => {
    // A budget of zero must flip the verdict: proof the verdict is computed from
    // the measurement rather than hardcoded to the convenient answer.
    const { report: impossible } = runBenchmark({ VECTOR_BENCH_BUDGET_MS: '0' });
    expect(impossible.verdict.bruteForceWithinBudget).toBe(false);
    expect(impossible.verdict.needsVectorIndexExtension).toBe(true);
  });
});

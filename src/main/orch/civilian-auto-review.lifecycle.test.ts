import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { CandidateQualityAnalysis } from '../context/candidate-quality-scanner';
import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { testProjectScope } from './__tests__/scope-fixture';
import { enforceCivilianAutoReview, type CivilianAutoReviewInput } from './civilian-auto-review';

const passed = (kind: 'typecheck' | 'dependency-audit' | 'test-coverage' | 'dependency-freshness') => ({ kind, status: 'passed' as const, summary: 'Private fixture checked.', findings: [] });
const analysis: CandidateQualityAnalysis = { version: 'candidate-quality-v1', complete: true,
  analysisHash: 'f'.repeat(64), findings: [{ severity: 'high', category: 'correctness', file: 'src/fixture.ts',
    criterionRefs: [], invariantRefs: [], evidence: 'Private fixture needs repair.', recommendation: 'Repair fixture.' }],
  inspectedFiles: 1, inspectedBytes: 100, incompleteReasons: [], reviewerMarkdown: '' };
const mission = { id: 'mission-f889-fixture', title: 'Private fixture', status: 'running', description: 'Fixture source review.',
  intentState: 'executing', intentVersion: 1, createdAt: 1000, updatedAt: 2000, milestones: [], learnings: '' } as Mission;
const deps = { git: { run: async (_cwd: string, args: readonly string[]) => ({ status: 0,
  stdout: (args[0] === 'log' ? 'a' : 'b').repeat(40), stderr: '' }) }, typecheck: async () => passed('typecheck'),
  audit: async () => passed('dependency-audit'), freshness: async () => passed('dependency-freshness'),
  testCoverage: async () => passed('test-coverage'), regressionGate: null };

it.each(['approval', 'repair'] as const)('cancelled scanner cannot produce late %s', async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f889-scanner-'));
  const marker = path.join(root, 'repair-delivered');
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void; const gate = new Promise<CandidateQualityAnalysis>(resolve => { release = () => resolve({ ...analysis, findings: kind === 'repair' ? analysis.findings : [] }); });
  let outcome: Awaited<ReturnType<typeof enforceCivilianAutoReview>> | undefined;
  const id = `f889-scanner:${root}`;
  const flight = runPeriodicTask(id, async lifetime => {
    const input = { mission, scope: testProjectScope({ rootRealPath: root }), productFiles: ['src/fixture.ts'],
      liveOrchestratorSessionId: 'fixture-maestro', lifetime } as CivilianAutoReviewInput;
    outcome = await enforceCivilianAutoReview(input, { ...deps, analyze: () => { enter(); return gate; },
      deliverRepair: async () => { fs.writeFileSync(marker, 'late repair'); return true; } });
  });
  void flight.catch(() => undefined);
  await entered; const stop = stopPeriodicTask(id); release();
  try {
    await stop; await flight.catch(() => undefined);
    expect(fs.existsSync(marker)).toBe(false);
    expect(outcome).toBeUndefined();
  } finally { release(); await flight.catch(() => undefined); fs.rmSync(root, { recursive: true, force: true }); }
});

it('sensor sibling rejection cannot settle physical drain before the owned process closes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f889-sensor-'));
  const releaseFile = path.join(root, 'release');
  let child: ChildProcess | undefined;
  let childClosed = false;
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  let completion: Promise<ReturnType<typeof passed>> | undefined;
  const id = `f889-sensors:${root}`;
  const flight = runPeriodicTask(id, async lifetime => {
    await enforceCivilianAutoReview({ mission: { ...mission, id: 'mission-f889-sensors-fixture' }, scope: testProjectScope({ rootRealPath: root }),
      productFiles: ['src/fixture.ts'], lifetime } as CivilianAutoReviewInput, {
      ...deps, analyze: async () => ({ ...analysis, findings: [] }),
      typecheck: async () => { throw new Error('fixture sibling failed'); },
      audit: () => {
        // Exact Node executable/handle owned by this fixture; no CLI/provider/env.
        child = spawn(process.execPath, ['-e', "const fs=require('node:fs');process.stdout.write('ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},10)", releaseFile],
          { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout!.once('data', () => ready());
        completion = new Promise((resolve, reject) => {
          child!.once('error', reject); child!.once('close', code => { childClosed = true;
            if (code === 0) resolve(passed('dependency-audit')); else reject(new Error('owned fixture process failed')); });
        });
        return completion;
      },
    });
  });
  void flight.catch(() => undefined);
  await started;
  let stopped = false; const stop = stopPeriodicTask(id).then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const stoppedEarly = stopped;
  fs.writeFileSync(releaseFile, 'go');
  try { await stop; await flight.catch(() => undefined); await completion;
    expect(childClosed).toBe(true); expect(stoppedEarly).toBe(false);
  } finally { fs.writeFileSync(releaseFile, 'go'); await completion?.catch(() => undefined);
    await flight.catch(() => undefined); fs.rmSync(root, { recursive: true, force: true }); }
});

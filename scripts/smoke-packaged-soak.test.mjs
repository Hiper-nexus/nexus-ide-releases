import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertSoakProof, parseSoakArguments, readSoakGitAuthority, runPackagedSoak } from './smoke-packaged-soak.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SOAK_POLICY, SOAK_HEAP_SOURCE } from '../src/shared/soak-smoke';
import { soakSamples, soakFixtureNonce } from '../src/shared/__tests__/soak-fixture';
import { FUNCTIONAL_SMOKE_REQUIRED_PROBES, FUNCTIONAL_SMOKE_MIN_ADAPTERS, FUNCTIONAL_SMOKE_MIN_TOOLS } from '../src/shared/smoke-types';
const cleanup = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
function fixture() {
  return { schema: 'nexus.soak-smoke/v1', nonce: soakFixtureNonce, pid: 4321, rendererPid: 1234,
    appVersion: '0.76.192', packaged: true, electronVersion: '43.8.3', heapSource: SOAK_HEAP_SOURCE, units: 'bytes',
    durationMs: 301000, postFunctionalMs: 1000, startedAt: 1000, finishedAt: 303000, policy: SOAK_POLICY, samples: soakSamples(),
    finalFunctional: { ok: true, probes: [...FUNCTIONAL_SMOKE_REQUIRED_PROBES], adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS, toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS } };
}
it('requires explicit mode and concrete source/archive/artifact arguments', () => {
  expect(() => parseSoakArguments([])).toThrow();
  expect(parseSoakArguments(['--verify-soak', '--app', '/tmp/NexusIDE.app', '--zip', '/tmp/candidate.zip', '--build-receipt', '/tmp/candidate-build.json',
    '--source-sha', 'a'.repeat(40), '--expected-version', '0.76.192', '--evidence-dir', '/tmp/new-evidence'])).toMatchObject({ sourceSha: 'a'.repeat(40) });
});
it('binds actual clean Git HEAD and annotated tag instead of accepting self-declared source fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-soak-git-unit-')); cleanup.push(root);
  const execute = promisify(execFile);
  const git = args => execute('git', ['-c', 'user.name=SoakFixture', '-c', 'user.email=soak@fixture.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
  await git(['init', '--quiet']); await fs.writeFile(path.join(root, 'source.txt'), 'private Git fixture');
  await git(['add', 'source.txt']); await git(['commit', '--quiet', '-m', 'private source fixture']);
  const sourceSha = (await git(['rev-parse', 'HEAD'])).stdout.trim(); await git(['tag', '-a', 'v1.2.3', '-m', 'private source tag']);
  const input = { sourceSha, expectedVersion: '1.2.3', authority: { version: '1.2.3', allowedTagSignerFingerprints: [] } };
  await expect(readSoakGitAuthority(root, input)).resolves.toMatchObject({ commitSha: sourceSha, tag: 'v1.2.3', tagSignatureVerified: false });
  await expect(readSoakGitAuthority(root, { ...input, sourceSha: '0'.repeat(40) })).rejects.toThrow();
  await fs.writeFile(path.join(root, 'source.txt'), 'dirty source'); await expect(readSoakGitAuthority(root, input)).rejects.toThrow(/dirty/);
  await git(['checkout', '--', 'source.txt']); await git(['tag', '-d', 'v1.2.3']); await git(['tag', 'v1.2.3']);
  await expect(readSoakGitAuthority(root, input)).rejects.toThrow(/annotated/);
});
it('recomputes duration, bounded growth and complete post-run functionality', () => {
  expect(assertSoakProof(fixture(), { pid: 4321, expectedVersion: '0.76.192' }).durationMs).toBe(301000);
  for (const mutate of [v => { v.durationMs = 60000; }, v => { v.samples[0].memoryBytes.rendererHeap = 0; },
    v => { v.policy = { ...SOAK_POLICY, requiredDurationMs: 5000 }; }, v => { v.finalFunctional.probes.pop(); }, v => { v.rendererPid++; }]) {
    const f = fixture(); mutate(f); expect(() => assertSoakProof(f, { pid: 4321, expectedVersion: '0.76.192' })).toThrow();
  }
});
async function runFixture(alterResult) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-soak-cli-unit-')); cleanup.push(root);
  const evidenceDir = path.join(root, 'evidence');
  let profile;
  const seal = { sourceSha: 'a'.repeat(40), buildReceiptSha256: 'b'.repeat(64), zipSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), signature: { cdhash: 'e'.repeat(40) } };
  const runSmoke = async (_app, options) => {
    expect(options.remoteDebugging).toBe(false); expect(options.soakProbe).toBe(true);
    expect(options.env.NEXUS_SMOKE_SOAK).toBe('1'); expect(options.runtimeProbeTimeoutMs).toBeGreaterThan(300000);
    profile = options.smokeSession.userData;
    await fs.mkdir(path.join(profile, 'logs'));
    await fs.writeFile(path.join(profile, 'logs', 'soak-smoke.json'), JSON.stringify(fixture()));
    await fs.writeFile(path.join(profile, 'logs', 'soak-samples.ndjson'), 'private fixture evidence\n');
    const runtimeProof = await options.runtimeProbe({ pid: 4321 }, { userData: profile, signal: new AbortController().signal });
    const result = { code: 0, runtimeProof, shutdownMode: 'graceful', treeProof: { ok: true }, processTreeProof: { orphans: [] },
      output: '[smoke] soak-ready\n[smoke] functional-ready\n[smoke] shutdown-complete: physical PTY inventory proven' };
    alterResult?.(result); return result;
  };
  const options = { expectedVersion: '0.76.192', sourceSha: seal.sourceSha, buildReceipt: '/fixture/candidate-build.json', zip: '/fixture/candidate.zip',
    evidenceDir, bindCandidate: async () => seal, runSmoke };
  return { options, evidenceDir, run: () => runPackagedSoak('/fixture/NexusIDE.app', options), profile: () => profile };
}
it('preserves raw evidence outside the private profile and accepts only natural physical exit', async () => {
  const f = await runFixture(); await expect(f.run()).resolves.toMatchObject({ sourceSha: 'a'.repeat(40), processTreesClean: true });
  expect(await fs.readFile(path.join(f.evidenceDir, 'soak-samples.ndjson'), 'utf8')).toContain('private fixture');
  await expect(fs.stat(f.profile())).rejects.toThrow();
});
it('does not write acceptance when the process tree proof is missing; retains private failure evidence', async () => {
  const f = await runFixture(result => { result.processTreeProof.orphans = [9876]; });
  await expect(f.run()).rejects.toThrow();
  expect(await fs.readFile(path.join(f.evidenceDir, 'soak-samples.ndjson'), 'utf8')).toContain('private fixture');
  await expect(fs.stat(path.join(f.evidenceDir, 'acceptance.json'))).rejects.toThrow();
  cleanup.push(f.profile());
});
it('rejects an app/ZIP seal that changes during the run', async () => {
  const f = await runFixture(); let calls = 0;
  f.options.bindCandidate = async () => ({ manifestSha256: String(calls++), sourceSha: 'a'.repeat(40) });
  await expect(f.run()).rejects.toThrow(/changed/);
});

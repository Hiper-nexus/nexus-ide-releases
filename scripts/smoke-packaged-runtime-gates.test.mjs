import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { parseRuntimeArguments, assertRuntimeReceipt, runPackagedRuntimeGates } from './smoke-packaged-runtime-gates.mjs';
import { runtimeFactFixture } from '../src/shared/__tests__/runtime-gate-fixture';
import { deriveRuntimeChecks } from '../src/shared/runtime-gate-proof';
import { FUNCTIONAL_SMOKE_REQUIRED_PROBES, FUNCTIONAL_SMOKE_MIN_ADAPTERS, FUNCTIONAL_SMOKE_MIN_TOOLS } from '../src/shared/smoke-types';
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function receipt(phase, pid) {
  const facts = runtimeFactFixture(phase);
  return { schema: 'nexus.runtime-gates/v1', phase, pid, rendererPid: pid + 100, nonce: phase === 'exercise' ? facts.marker : '22222222-2222-4222-8222-222222222222',
    packaged: true, appVersion: '0.76.192', electronVersion: '43.8.3', facts, checks: deriveRuntimeChecks(facts), state: facts.state,
    cli: { adapterId: 'claude', version: 'Claude fixture (unit only)', binarySha256: 'b'.repeat(64), actualInstalled: true },
    voice: phase === 'exercise' ? { grant: 'granted', ...facts.voice.final } : undefined,
    captures: phase === 'exercise' ? [{ assignmentId: 'main-assignment-uuid', artifactId: 'capture', sha256: 'a'.repeat(64), path: '/private/artifact.png' }] : [],
    finalFunctional: { ok: true, probes: [...FUNCTIONAL_SMOKE_REQUIRED_PROBES], adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS, toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS } };
}
it('refuses incomplete launch arguments and renderer booleans without Main facts/final functionality', () => {
  expect(() => parseRuntimeArguments([])).toThrow();
  const proof = receipt('exercise', 4321); expect(() => assertRuntimeReceipt(proof, { phase: 'exercise', pid: 4321, expectedVersion: '0.76.192' })).not.toThrow();
  for (const mutate of [v => { v.facts.history = []; }, v => { v.finalFunctional.probes.pop(); }, v => { v.pid++; }, v => { v.electronVersion = '43.0.0'; },
    v => { v.captures = []; }, v => { v.facts.questionCommands[1].questionId = 'wrong'; }]) {
    const value = structuredClone(proof); mutate(value); expect(() => assertRuntimeReceipt(value, { phase: 'exercise', pid: 4321, expectedVersion: '0.76.192' })).toThrow();
  }
});
async function fixture(alter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runtime-cli-unit-')); roots.push(root);
  const seal = { appPath: '/fixture/NexusIDE.app', sourceSha: 'c'.repeat(40), signature: { codeDirectoryHash: 'd'.repeat(40) }, zipSha256: 'e'.repeat(64) };
  const evidenceDir = path.join(root, 'evidence'), seen = [], close = [];
  const runSmoke = async (_app, options) => {
    expect(options.remoteDebugging).toBe(false); expect(options.runtimeGatesProbe).toBe(true); expect(options.timeoutMs).toBe(600000);
    const profile = options.smokeSession.userData; roots.push(profile); seen.push(profile);
    const phase = options.env.NEXUS_SMOKE_RUNTIME_PHASE, pid = phase === 'exercise' ? 4321 : 5432;
    const proof = receipt(phase, pid);
    await fs.mkdir(path.join(profile, 'logs'), { recursive: true });
    if (phase === 'exercise') {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
      const hash = createHash('sha256').update(png).digest('hex'), file = path.join(profile, 'capture.png'); await fs.writeFile(file, png);
      proof.captures[0].path = file; proof.captures[0].sha256 = hash; proof.facts.history[6].agents[1].visual.sha256 = hash;
    }
    await fs.writeFile(path.join(profile, 'logs', `runtime-gates-${phase}.json`), JSON.stringify(proof));
    const runtimeProof = await options.runtimeProbe({ pid }, { userData: profile, signal: new AbortController().signal });
    const result = { code: 0, runtimeProof, shutdownMode: 'graceful', treeProof: { ok: true }, processTreeProof: { orphans: [] },
      output: `[smoke] runtime-${phase}-ready\n[smoke] functional-ready\n[smoke] shutdown-complete: physical PTY inventory proven` };
    alter?.(result, phase); return result;
  };
  const options = { expectedVersion: '0.76.192', sourceSha: seal.sourceSha, buildReceipt: '/fixture/candidate-build.json', zip: '/fixture/candidate.zip', evidenceDir,
    bindCandidate: async () => seal, runSmoke, gatewayFactory: async () => ({ nonce: runtimeFactFixture().marker, url: 'http://127.0.0.1:45678', observations: [], close: async () => close.push(true) }) };
  return { root, seen, close, options, run: () => runPackagedRuntimeGates('/fixture/NexusIDE.app', options) };
}
it('uses one private profile for two fresh processes, preserves PNG bytes and requires both physical natural exits', async () => {
  const f = await fixture(); await expect(f.run()).resolves.toMatchObject({ processTreesClean: true, visualInspection: 'pending-human-image-inspection' });
  expect(f.seen).toHaveLength(2); expect(f.seen[0]).toBe(f.seen[1]); expect(f.close).toHaveLength(1);
  expect((await fs.readFile(path.join(f.options.evidenceDir, 'exercise-capture-0.png'))).length).toBeGreaterThan(8);
  await expect(fs.stat(f.seen[0])).rejects.toThrow();
});
it.each(['orphan', 'same-process', 'wrong-conversation'])('does not certify %s and retains the private unknown evidence', async control => {
  const f = await fixture((r, phase) => {
    if (control === 'orphan') r.processTreeProof.orphans = [9876];
    else if (phase === 'resume' && control === 'same-process') r.runtimeProof.pid = 4321;
    else if (phase === 'resume') r.runtimeProof.state = { ...r.runtimeProof.state, memoryId: 'different' };
  });
  await expect(f.run()).rejects.toThrow(); await expect(fs.stat(path.join(f.options.evidenceDir, 'acceptance.json'))).rejects.toThrow();
  expect(f.close).toHaveLength(1);
});
it('rejects archive/signature replacement across the two launches', async () => {
  const f = await fixture(); let reads = 0; f.options.bindCandidate = async () => ({ signature: reads++ });
  await expect(f.run()).rejects.toThrow(/changed/);
});

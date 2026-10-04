import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseSoakArguments, bindSignedSoakCandidate } from './smoke-packaged-soak.mjs';
import { createPackagedSmokeSession, disposePackagedSmokeSession, runPackagedSmoke } from './smoke-packaged-app.mjs';
import { startRuntimeGateway } from './runtime-gateway.mjs';
import { assertRuntimeProof } from '../src/shared/runtime-gates.ts';
import { deriveRuntimeChecks } from '../src/shared/runtime-gate-proof.ts';
import { soakNonce, SOAK_ELECTRON } from '../src/shared/soak-smoke.ts';
import { parseFunctionalSmokeResult } from '../src/shared/smoke-types.ts';
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseRuntimeArguments(args) {
  if (args[0] !== '--verify-runtime-gates') throw new Error('explicit runtime acceptance mode required');
  return parseSoakArguments(['--verify-soak', ...args.slice(1)]);
}
async function readBounded(file, cap) {
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > cap) throw new Error('unsafe runtime artifact');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const read = await fd.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error('runtime artifact short read'); offset += read.bytesRead; }
    const after = await fs.lstat(file);
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await fs.realpath(file) !== file) throw new Error('runtime artifact changed');
    return bytes;
  } finally { await fd.close(); }
}
export function assertRuntimeReceipt(receipt, { phase, pid, expectedVersion }) {
  assertRuntimeProof(receipt, phase);
  if (receipt.schema !== 'nexus.runtime-gates/v1' || receipt.pid !== pid || receipt.appVersion !== expectedVersion || receipt.electronVersion !== SOAK_ELECTRON ||
      !Number.isSafeInteger(receipt.rendererPid) || receipt.rendererPid <= 0 || !soakNonce.safeParse(receipt.facts?.marker).success ||
      receipt.facts.phase !== phase || JSON.stringify(deriveRuntimeChecks(receipt.facts)) !== JSON.stringify(receipt.checks) ||
      !parseFunctionalSmokeResult(receipt.finalFunctional)?.ok || !Array.isArray(receipt.captures) || (phase === 'exercise' && receipt.captures.length < 1)) throw new Error('runtime Main or final functional proof incomplete');
  return receipt;
}
async function waitForReceipt(userData, { phase, pid, expectedVersion, evidenceDir, signal }) {
  for (;;) {
    if (signal.aborted) throw new Error('runtime observer cancelled');
    try {
      const file = path.join(userData, 'logs', `runtime-gates-${phase}.json`), bytes = await readBounded(file, 8 * 1024 * 1024);
      const proof = assertRuntimeReceipt(JSON.parse(bytes), { phase, pid, expectedVersion });
      const copied = [];
      for (const capture of proof.captures) {
        if (!capture || typeof capture.path !== 'string' || !capture.path.startsWith(`${userData}${path.sep}`) || !/^[a-f0-9]{64}$/u.test(capture.sha256) ||
            !proof.facts.history.some(h => h.agents?.some(a => a.visual?.artifactId === capture.artifactId && a.visual.assignmentId === capture.assignmentId && a.visual.sha256 === capture.sha256))) throw new Error('runtime capture origin incomplete');
        const png = await readBounded(capture.path, 64 * 1024 * 1024);
        if (sha(png) !== capture.sha256 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('runtime PNG bytes differ from Main capture');
        const name = `${phase}-capture-${copied.length}.png`;
        await fs.writeFile(path.join(evidenceDir, name), png, { mode: 0o600, flag: 'wx' }); copied.push({ ...capture, preservedPath: name });
      }
      await fs.writeFile(path.join(evidenceDir, `runtime-gates-${phase}.json`), bytes, { mode: 0o600, flag: 'wx' });
      return { ...proof, captures: copied };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
export async function runPackagedRuntimeGates(app, { expectedVersion, sourceSha, buildReceipt, zip, evidenceDir,
  bindCandidate = bindSignedSoakCandidate, runSmoke = runPackagedSmoke, gatewayFactory = startRuntimeGateway, env = process.env } = {}) {
  parseRuntimeArguments(['--verify-runtime-gates', '--app', app, '--zip', zip, '--build-receipt', buildReceipt, '--source-sha', sourceSha, '--expected-version', expectedVersion, '--evidence-dir', evidenceDir]);
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  const seal = await bindCandidate(app, { zip, buildReceipt, sourceSha, expectedVersion });
  await fs.writeFile(path.join(evidenceDir, 'candidate-before.json'), JSON.stringify(seal) + '\n', { mode: 0o600, flag: 'wx' });
  const session = await createPackagedSmokeSession(), results = [];
  let gateway;
  try {
    const workspace = path.join(session.userData, 'functional-smoke-workspace'); await fs.mkdir(workspace, { mode: 0o700 });
    const gitEnv = { ...env, HOME: path.join(session.userData, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = args => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=RuntimeFixture', '-c', 'user.email=runtime@fixture.invalid', ...args],
      { cwd: workspace, env: gitEnv, timeout: 15000, maxBuffer: 65536 });
    await git(['init', '--quiet', '-b', 'runtime-private']); await fs.writeFile(path.join(workspace, 'runtime-fixture.md'), 'Private packaged acceptance fixture.\n', { mode: 0o600 });
    await git(['add', 'runtime-fixture.md']); await git(['commit', '--quiet', '-m', 'Private runtime fixture']);
    gateway = await gatewayFactory(randomUUID());
    for (const phase of ['exercise', 'resume']) {
      const result = await runSmoke(seal.appPath ?? app, { smokeSession: session, remoteDebugging: false, runtimeGatesProbe: true,
        env: { ...env, NEXUS_SMOKE_RUNTIME_GATES: '1', NEXUS_SMOKE_RUNTIME_GATEWAY: gateway.url, NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: gateway.nonce,
          NEXUS_SMOKE_RUNTIME_PHASE: phase, NEXUS_SMOKE_SOAK: '0', NEXUS_SMOKE_HANG_PROBE: '0', NEXUS_SMOKE_BUSY_BANNER_PROBE: '0' },
        timeoutMs: 600000, runtimeProbeTimeoutMs: 590000,
        runtimeProbe: (child, input) => waitForReceipt(input.userData, { ...input, phase, pid: child.pid, expectedVersion, evidenceDir }) });
      results.push(result);
      if (result?.code !== 0 || result.shutdownMode !== 'graceful' || result.treeProof?.ok !== true || !Array.isArray(result.processTreeProof?.orphans) || result.processTreeProof.orphans.length ||
          !result.output?.includes(`[smoke] runtime-${phase}-ready`) || result.output.indexOf('[smoke] functional-ready') <= result.output.indexOf(`[smoke] runtime-${phase}-ready`) ||
          !result.output.includes('[smoke] shutdown-complete: physical PTY inventory proven')) throw new Error(`runtime ${phase} lacks natural physical exit proof`);
    }
    const [first, second] = results.map(r => r.runtimeProof);
    if (first.pid === second.pid || first.nonce === second.nonce || first.rendererPid === second.rendererPid || first.facts.marker !== second.facts.marker ||
        JSON.stringify(first.state) !== JSON.stringify(second.state) || JSON.stringify(first.cli) !== JSON.stringify(second.cli)) throw new Error('runtime restart identity/conversation/CLI proof differs');
    const after = await bindCandidate(app, { zip, buildReceipt, sourceSha, expectedVersion });
    await fs.writeFile(path.join(evidenceDir, 'candidate-after.json'), JSON.stringify(after) + '\n', { mode: 0o600, flag: 'wx' });
    if (JSON.stringify(seal) !== JSON.stringify(after)) throw new Error('runtime candidate app/ZIP/signature changed');
    const acceptance = { schema: 'nexus.runtime-acceptance/v1', sourceSha, expectedVersion, candidate: seal, phases: results.map(r => r.runtimeProof),
      gatewayObservations: gateway.observations, processTreesClean: true, shutdownMode: 'graceful', visualInspection: 'pending-human-image-inspection' };
    await fs.writeFile(path.join(evidenceDir, 'acceptance.json'), JSON.stringify(acceptance) + '\n', { mode: 0o600, flag: 'wx' }); return acceptance;
  } catch (error) {
    await fs.writeFile(path.join(evidenceDir, 'failure.json'), JSON.stringify({ status: 'failed', privateProfile: session.userData, reason: String(error.message ?? error).slice(0, 1000) }) + '\n', { mode: 0o600, flag: 'wx' }); throw error;
  } finally {
    await gateway?.close();
    // Unknown or unproved processes retain the profile; no cleanup upgrades FAIL.
    if (results.length === 2 && results.every(r => r?.treeProof?.ok === true && r.processTreeProof?.orphans?.length === 0)) await disposePackagedSmokeSession(session);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const args = parseRuntimeArguments(process.argv.slice(2)); const proof = await runPackagedRuntimeGates(args.app, args); process.stdout.write(`[smoke] runtimeProof ${JSON.stringify(proof)}\n`); }
  catch (error) { process.stderr.write(`[smoke] runtime gates failed: ${error.message}\n`); process.exitCode = 1; }
}

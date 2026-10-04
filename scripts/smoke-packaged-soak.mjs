import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOAK_FILE, SOAK_POLICY, SOAK_HEAP_SOURCE, SOAK_ELECTRON, SOAK_ENV, assertSoakSamples, soakNonce } from '../src/shared/soak-smoke.ts';
import { parseFunctionalSmokeResult } from '../src/shared/smoke-types.ts';
import { createPackagedSmokeSession, disposePackagedSmokeSession, runPackagedSmoke } from './smoke-packaged-app.mjs';
import { assertCandidateBuildReceipt } from './release-candidate-gate.mjs';
import { readAndAssertReleaseAuthority, assertReleaseRepositoryState, parseVerifiedTagSignerFingerprint } from './release-authority.mjs';
import { assertFastRealMissionAppSignature } from './spikes/e2e-real-mission-signature-preflight.mjs';
import { assertRequiredElectronFuses, buildFusesReadInvocation, parseCodesignMetadata } from './verify-macos-release.mjs';
const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');

export function parseSoakArguments(args) {
  const result = {};
  let mode = false;
  const keys = { '--app': 'app', '--zip': 'zip', '--build-receipt': 'buildReceipt', '--source-sha': 'sourceSha', '--expected-version': 'expectedVersion', '--evidence-dir': 'evidenceDir' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify-soak' && !mode) { mode = true; continue; }
    const key = keys[args[i]];
    if (!key || result[key] !== undefined || !args[i + 1]) throw new Error('invalid soak arguments');
    result[key] = args[++i];
  }
  if (!mode || !/^\d+\.\d+\.\d+$/u.test(result.expectedVersion ?? '') || !/^[a-f0-9]{40}$/u.test(result.sourceSha ?? '') ||
    !['app', 'zip', 'buildReceipt', 'evidenceDir'].every(key => typeof result[key] === 'string' && path.isAbsolute(result[key]))) throw new Error('soak requires explicit mode, app, ZIP, build receipt, source SHA, version and new absolute evidence directory');
  return result;
}
export function assertSoakProof(receipt, { pid, expectedVersion }) {
  if (receipt?.schema !== 'nexus.soak-smoke/v1' || receipt.pid !== pid || !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(receipt.rendererPid) || receipt.rendererPid <= 0 || !soakNonce.safeParse(receipt.nonce).success ||
    receipt.packaged !== true || receipt.appVersion !== expectedVersion || receipt.units !== 'bytes' ||
    receipt.electronVersion !== SOAK_ELECTRON || receipt.heapSource !== SOAK_HEAP_SOURCE ||
    JSON.stringify(receipt.policy) !== JSON.stringify(SOAK_POLICY) || !parseFunctionalSmokeResult(receipt.finalFunctional)?.ok ||
    !Number.isFinite(receipt.postFunctionalMs) || receipt.postFunctionalMs < 0 || receipt.postFunctionalMs > 60000 ||
    !Number.isSafeInteger(receipt.startedAt) || !Number.isSafeInteger(receipt.finishedAt) || receipt.finishedAt <= receipt.startedAt ||
    !Array.isArray(receipt.samples) || receipt.samples.some(v => v.rendererPid !== receipt.rendererPid)) throw new Error('soak process, protocol, policy or final functionality proof incomplete');
  const summary = assertSoakSamples(receipt.samples, receipt.durationMs);
  if (receipt.summary && JSON.stringify(receipt.summary) !== JSON.stringify(summary)) throw new Error('soak memory summary differs from raw evidence');
  return { schema: 'nexus.soak-acceptance/v1', nonce: receipt.nonce, pid, rendererPid: receipt.rendererPid, appVersion: expectedVersion,
    electronVersion: SOAK_ELECTRON, heapSource: SOAK_HEAP_SOURCE, units: 'bytes', durationMs: receipt.durationMs,
    sampleCount: receipt.samples.length, policy: SOAK_POLICY, summary, finalFunctional: true };
}
export async function readSoakGitAuthority(root, { sourceSha, expectedVersion, authority }) {
  const git = async args => execute('git', args, { cwd: root, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const tag = `refs/tags/v${expectedVersion}`;
  const [status, head, taggedCommit, taggedObject, taggedType] = await Promise.all([
    git(['status', '--porcelain=v1', '--untracked-files=all']), git(['rev-parse', 'HEAD']), git(['rev-parse', `${tag}^{commit}`]),
    git(['rev-parse', tag]), git(['cat-file', '-t', tag]),
  ]);
  if (authority.version !== expectedVersion || head.stdout.trim() !== sourceSha || taggedCommit.stdout.trim() !== sourceSha) throw new Error('soak source SHA is not the actual repository HEAD and release tag');
  let tagSignerFingerprint = null;
  if (authority.allowedTagSignerFingerprints.length) {
    const verified = await git(['verify-tag', '--raw', tag]);
    tagSignerFingerprint = parseVerifiedTagSignerFingerprint(verified.stdout + verified.stderr);
  }
  const gitAuthority = assertReleaseRepositoryState({ statusPorcelain: status.stdout, headSha: head.stdout.trim(), tagCommitSha: taggedCommit.stdout.trim(),
    tagObjectSha: taggedObject.stdout.trim(), tagObjectType: taggedType.stdout.trim(), tagSignerFingerprint,
    allowedTagSignerFingerprints: authority.allowedTagSignerFingerprints, version: expectedVersion });
  return gitAuthority;
}
export async function bindSignedSoakCandidate(app, { zip, buildReceipt, sourceSha, expectedVersion }) {
  if (process.platform !== 'darwin') throw new Error('signed soak currently requires macOS');
  const appStat = await fs.lstat(app);
  if (!appStat.isDirectory() || appStat.isSymbolicLink()) throw new Error('soak app must be a regular bundle');
  app = await fs.realpath(app);
  const root = path.dirname(path.dirname(buildReceipt)), receiptBytes = await fs.readFile(buildReceipt), receipt = JSON.parse(receiptBytes);
  if (path.basename(buildReceipt) !== 'candidate-build.json' || path.basename(path.dirname(buildReceipt)) !== 'release-artifacts' || receipt.commitSha !== sourceSha) throw new Error('soak source/build receipt binding missing');
  const authority = readAndAssertReleaseAuthority(root);
  const gitAuthority = await readSoakGitAuthority(root, { sourceSha, expectedVersion, authority });
  const artifacts = Object.fromEntries(['zip', 'dmg'].map(kind => {
    const entries = receipt.artifacts?.filter(v => typeof v.path === 'string' && v.path.endsWith(`.${kind}`));
    if (entries?.length !== 1) throw new Error('soak candidate artifact inventory incomplete');
    const target = path.resolve(root, entries[0].path);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('soak artifact path escaped release root');
    return [kind, target];
  }));
  if (artifacts.zip !== zip) throw new Error('soak ZIP is not the candidate receipt ZIP');
  assertCandidateBuildReceipt({ receipt, root, version: expectedVersion, commitSha: sourceSha,
    tagObjectSha: gitAuthority.tagObjectSha, tagSignerFingerprint: gitAuthority.tagSignerFingerprint, tagSignatureVerified: gitAuthority.tagSignatureVerified,
    packageLockSha256: sha(await fs.readFile(path.join(root, 'package-lock.json'))), npmVersion: authority.npmVersion,
    npmPackageIntegrity: authority.npmPackageIntegrity, nodeVersion: authority.nodeVersion, expectedArch: receipt.architecture, artifacts });
  const compared = JSON.parse((await execute('python3', [path.join(here, 'compare-soak-bundle.py'), app, zip], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  const declaredZip = receipt.artifacts.find(v => v.path.endsWith('.zip'));
  if (compared.zipSha256 !== declaredZip.sha256) throw new Error('soak ZIP changed while comparing bundle');
  const signed = assertFastRealMissionAppSignature(app);
  const metadata = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', app], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const signature = { ...signed, ...parseCodesignMetadata(metadata.stdout + metadata.stderr) };
  if (!/^[a-f0-9]{40}$/u.test(signature.codeDirectoryHash)) throw new Error('soak app CodeDirectory hash missing');
  const fuses = buildFusesReadInvocation(app, root);
  const output = await execute(fuses.command, fuses.args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  assertRequiredElectronFuses(output.stdout + output.stderr);
  return { appPath: app, sourceSha, buildReceiptSha256: sha(receiptBytes), zipSha256: compared.zipSha256, manifestSha256: compared.manifestSha256,
    gitAuthority, signature, fuses: (output.stdout + output.stderr).replace(/\x1b\[[0-9;]*m/gu, ''), files: compared.files, bytes: compared.bytes };
}
async function waitForSoak(userData, { pid, expectedVersion, evidenceDir, signal }) {
  for (;;) {
    if (signal.aborted) throw new Error('soak observer cancelled');
    try {
      const bytes = await fs.readFile(path.join(userData, 'logs', SOAK_FILE));
      if (bytes.length > 2 * 1024 * 1024) throw new Error('soak receipt exceeded bound');
      const proof = assertSoakProof(JSON.parse(bytes), { pid, expectedVersion });
      await fs.writeFile(path.join(evidenceDir, SOAK_FILE), bytes, { mode: 0o600, flag: 'wx' });
      return proof;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
export async function runPackagedSoak(app, { expectedVersion, sourceSha, buildReceipt, zip, evidenceDir,
  bindCandidate = bindSignedSoakCandidate, runSmoke = runPackagedSmoke, env = process.env } = {}) {
  parseSoakArguments(['--verify-soak', '--app', app, '--zip', zip, '--build-receipt', buildReceipt, '--source-sha', sourceSha, '--expected-version', expectedVersion, '--evidence-dir', evidenceDir]);
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  const before = await bindCandidate(app, { zip, buildReceipt, sourceSha, expectedVersion });
  await fs.writeFile(path.join(evidenceDir, 'candidate-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const session = await createPackagedSmokeSession();
  let result;
  try {
    result = await runSmoke(before.appPath ?? app, { smokeSession: session, remoteDebugging: false, soakProbe: true,
      env: { ...env, [SOAK_ENV]: '1', NEXUS_SMOKE_HANG_PROBE: '0', NEXUS_SMOKE_BUSY_BANNER_PROBE: '0' },
      timeoutMs: 480000, runtimeProbeTimeoutMs: 450000,
      runtimeProbe: (child, input) => waitForSoak(input.userData, { ...input, pid: child.pid, expectedVersion, evidenceDir }) });
    const after = await bindCandidate(app, { zip, buildReceipt, sourceSha, expectedVersion });
    await fs.writeFile(path.join(evidenceDir, 'candidate-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('soak candidate app/ZIP/signature changed during use');
    const output = result?.output ?? '';
    if (result?.code !== 0 || result.runtimeProof?.schema !== 'nexus.soak-acceptance/v1' || result.shutdownMode !== 'graceful' || result.treeProof?.ok !== true ||
        !Array.isArray(result.processTreeProof?.orphans) || result.processTreeProof.orphans.length || !output.includes('[smoke] soak-ready') ||
        output.indexOf('[smoke] functional-ready') <= output.indexOf('[smoke] soak-ready') || !output.includes('[smoke] shutdown-complete: physical PTY inventory proven')) throw new Error('soak acceptance lacks final functionality and natural physical exit');
    const proof = { ...result.runtimeProof, sourceSha, buildReceiptSha256: before.buildReceiptSha256, zipSha256: before.zipSha256,
      bundleManifestSha256: before.manifestSha256, signature: before.signature, fuses: before.fuses,
      processTreesClean: true, shutdownMode: 'graceful', postRunFunctional: true };
    await fs.writeFile(path.join(evidenceDir, 'acceptance.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return proof;
  } catch (error) {
    await fs.writeFile(path.join(evidenceDir, 'failure.json'), JSON.stringify({ status: 'failed', privateProfile: session.userData,
      reason: String(error.message ?? error).slice(0, 1000) }) + '\n', { mode: 0o600, flag: 'wx' });
    throw error;
  } finally {
    for (const name of ['soak-samples.ndjson']) {
      try { await fs.copyFile(path.join(session.userData, 'logs', name), path.join(evidenceDir, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // An unknown tree retains its private profile for diagnosis; it never earns acceptance.
    if (result?.treeProof?.ok === true && result.processTreeProof?.orphans?.length === 0) await disposePackagedSmokeSession(session);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const args = parseSoakArguments(process.argv.slice(2)); const proof = await runPackagedSoak(args.app, args); process.stdout.write(`[smoke] soakProof ${JSON.stringify(proof)}\n`); }
  catch (error) { process.stderr.write(`[smoke] soak failed: ${error.message}\n`); process.exitCode = 1; }
}

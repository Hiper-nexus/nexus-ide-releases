import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { extractWindowsArchive, assertWindowsArchiveEntries, assertWindowsRun, assertWindowsArtifact, assertWindowsCandidate, assertMonotonicWindowsRelease, appendWindowsAssets, requireWindowsRunId, parseUpgradeProofWaiver } from './windows-release-candidate.mjs';

const sha = 'a'.repeat(40);
const repo = { id: 12, full_name: 'Hiper-nexus/nexus-ide', private: true };
const run = { id: 42, workflow_id: 7, path: '.github/workflows/windows-release.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success', repository: repo };
const workflow = { id: 7, path: run.path, state: 'active' };
const branch = { protected: true, commit: { sha } };
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-win-receipt-'));
  roots.push(root);
  const setup = 'NexusIDE-1.2.3-win32-x64-Setup.exe';
  const nupkg = 'nexus_ide-1.2.3-full.nupkg';
  const payloads = { [setup]: Buffer.from('setup bytes'), [nupkg]: Buffer.from('package bytes') };
  payloads.RELEASES = Buffer.from(`${hash(payloads[nupkg], 'sha1')} ${nupkg} ${payloads[nupkg].length}\n`);
  const executables = { setup: { sha256: hash(payloads[setup]) }, app: { sha256: 'b'.repeat(64) }, updater: { sha256: 'c'.repeat(64) }, stub: { sha256: 'd'.repeat(64) } };
  const receipt = { schemaVersion: 2, version: '1.2.3', commitSha: sha, runId: '42', platform: 'win32', arch: 'x64', signing: 'none', smoke: { status: 'pass', installedUpgradeVerified: true }, executables, assets: Object.entries(payloads).map(([name, bytes]) => ({ name, size: bytes.length, sha256: hash(bytes) })) };
  receipt.installedUpgradeProof = { schemaVersion: 1, status: 'pass', fromVersion: '1.2.2', toVersion: '1.2.3', commitSha: sha, runId: '42', assetSha256: Object.fromEntries(receipt.assets.map(a => [a.name, a.sha256])), checks: { signedBaselineInstalled: true, squirrelUpgradeApplied: true, targetRestarted: true, userDataPreserved: true } };
  for (const [name, bytes] of Object.entries(payloads)) fs.writeFileSync(path.join(root, name), bytes);
  fs.writeFileSync(path.join(root, 'windows-release-receipt.json'), JSON.stringify(receipt));
  return { root, receipt, setup, nupkg, expected: { version: '1.2.3', commitSha: sha, runId: '42' } };
}
describe('Windows workflow authority', () => {
  it('requires explicit authenticated worker run, never a local receipt path', () => {
    expect(() => requireWindowsRunId({})).toThrow(/NEXUS_WINDOWS_RELEASE_RUN_ID/);
    expect(() => requireWindowsRunId({ NEXUS_WINDOWS_RELEASE_RUN_ID: '/tmp/receipt.json' })).toThrow();
    expect(requireWindowsRunId({ NEXUS_WINDOWS_RELEASE_RUN_ID: '42' })).toBe('42');
  });
  it('accepts only the successful known private workflow at the same protected commit', () => {
    expect(() => assertWindowsRun({ run, workflow, branch, commitSha: sha, runId: '42' })).not.toThrow();
    for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' }, { head_branch: 'evil' }, { head_sha: 'b'.repeat(40) }, { workflow_id: 8 }, { path: 'evil.yml' }, { repository: { ...repo, private: false } }, { repository: { ...repo, full_name: 'evil/repo' } }]) {
      expect(() => assertWindowsRun({ run: { ...run, ...patch }, workflow, branch, commitSha: sha, runId: '42' })).toThrow();
    }
    expect(() => assertWindowsRun({ run, workflow, branch: { ...branch, protected: false }, commitSha: sha, runId: '42' })).toThrow();
  });
  it('rejects archive traversal, directories and duplicate entries before extraction', () => {
    const entries = ['NexusIDE-1.2.3-win32-x64-Setup.exe', 'nexus_ide-1.2.3-full.nupkg', 'RELEASES', 'windows-release-receipt.json'];
    expect(() => assertWindowsArchiveEntries(entries, '1.2.3')).not.toThrow();
    for (const names of [[...entries, entries[0]], ['../escape', ...entries.slice(1)], [entries[0], 'other-1.2.3-full.nupkg', ...entries.slice(2)], ['nested/setup.exe', ...entries.slice(1)], entries.slice(1)]) expect(() => assertWindowsArchiveEntries(names, '1.2.3')).toThrow();
  });
  it('binds an unexpired artifact to the workflow run and archive digest', () => {
    const bytes = Buffer.from('archive');
    const artifact = { name: 'windows-x64-release', expired: false, digest: `sha256:${hash(bytes)}`, workflow_run: { id: 42, head_sha: sha, repository_id: 12, head_repository_id: 12 } };
    expect(() => assertWindowsArtifact(artifact, bytes, run)).not.toThrow();
    for (const value of [{ ...artifact, expired: true }, { ...artifact, digest: null }, { ...artifact, workflow_run: { ...artifact.workflow_run, id: 43 } }]) expect(() => assertWindowsArtifact(value, bytes, run)).toThrow();
    expect(() => assertWindowsArtifact(artifact, Buffer.from('tampered'), run)).toThrow();
  });
});
describe('Windows candidate bytes within an authenticated archive', () => {
  it.runIf(process.platform === 'win32')('extracts a real flat archive on the Windows signing host', async () => {
    const f = fixture();
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-win-zip-'));
    roots.push(container);
    const zip = path.join(container, 'candidate.zip');
    const result = spawnSync('tar', [
      '-a',
      '-c',
      '-f',
      zip,
      '-C',
      f.root,
      ...fs.readdirSync(f.root),
    ]);
    expect(result.status).toBe(0);
    const extracted = path.join(container, 'extracted');
    await extractWindowsArchive(zip, extracted, '1.2.3');
    expect(assertWindowsCandidate(extracted, f.expected).assetPaths).toHaveLength(3);
  });
  it.runIf(process.platform === 'darwin')('extracts a real flat archive and validates its immutable candidate', async () => {
    const f = fixture();
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-win-zip-'));
    roots.push(container);
    const zip = path.join(container, 'candidate.zip');
    const result = spawnSync('/usr/bin/zip', ['-q', zip, ...fs.readdirSync(f.root)], { cwd: f.root });
    expect(result.status).toBe(0);
    const extracted = path.join(container, 'extracted');
    await extractWindowsArchive(zip, extracted, '1.2.3');
    expect(assertWindowsCandidate(extracted, f.expected).assetPaths).toHaveLength(3);
  });
  it('accepts exactly setup, original full package and one valid RELEASES entry', () => {
    const f = fixture();
    const result = assertWindowsCandidate(f.root, f.expected);
    expect(result.assetPaths.map(p => path.basename(p)).sort()).toEqual([f.setup, f.nupkg, 'RELEASES'].sort());
  });
  it('blocks missing, false or unbound installed upgrade evidence', () => {
    for (const alter of [r => { r.smoke.installedUpgradeVerified = false; }, r => { delete r.installedUpgradeProof; }, r => { r.installedUpgradeProof.toVersion = '1.2.4'; }, r => { r.installedUpgradeProof.commitSha = 'b'.repeat(40); }, r => { r.installedUpgradeProof.runId = '43'; }, r => { r.installedUpgradeProof.fromVersion = '1.2.3'; }, r => { r.installedUpgradeProof.assetSha256.RELEASES = 'f'.repeat(64); }, r => { r.installedUpgradeProof.checks.userDataPreserved = false; }]) {
      const f = fixture(); alter(f.receipt);
      fs.writeFileSync(path.join(f.root, 'windows-release-receipt.json'), JSON.stringify(f.receipt));
      expect(() => assertWindowsCandidate(f.root, f.expected)).toThrow(/installed.*upgrade.*proof/i);
    }
  });
  describe('operator waiver for a NOT PRODUCED upgrade proof', () => {
    const reason = 'upgrade 1.2.2→1.2.3 testado à mão na máquina Windows do operador em 2026-09-15';
    const notProduced = r => { r.smoke.installedUpgradeVerified = false; delete r.installedUpgradeProof; };
    const write = f => fs.writeFileSync(path.join(f.root, 'windows-release-receipt.json'), JSON.stringify(f.receipt));
    it('parses only a single-line reason of useful length from the environment', () => {
      expect(parseUpgradeProofWaiver({})).toBeUndefined();
      expect(parseUpgradeProofWaiver({ NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER: `  ${reason}  ` })).toEqual({ reason });
      for (const bad of ['', 'sim', 'x'.repeat(19), `${reason}\nsegunda linha`, 'y'.repeat(601)]) {
        expect(() => parseUpgradeProofWaiver({ NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER: bad })).toThrow(/NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER/);
      }
    });
    it('accepts the candidate and records a waiver bound to version, commit, run and reason', () => {
      const f = fixture(); notProduced(f.receipt); write(f);
      const candidate = assertWindowsCandidate(f.root, f.expected, { upgradeProofWaiver: { reason } });
      expect(candidate.assetPaths).toHaveLength(3);
      expect(path.basename(candidate.waiverPath)).toBe('windows-upgrade-proof-waiver.json');
      const record = JSON.parse(fs.readFileSync(candidate.waiverPath, 'utf8'));
      expect(record).toMatchObject({ schemaVersion: 1, kind: 'windows-upgrade-proof-waiver', version: '1.2.3', commitSha: sha, runId: '42', receiptInstalledUpgradeVerified: false, reason });
      expect(candidate.waiverAsset).toEqual({ name: 'windows-upgrade-proof-waiver.json', size: fs.statSync(candidate.waiverPath).size, sha256: hash(fs.readFileSync(candidate.waiverPath)) });
      const merged = appendWindowsAssets({ canonicalAssets: [], publicAssets: [], canonicalAssetPaths: ['mac.dmg'], publicAssetPaths: ['mac.dmg'] }, candidate);
      expect(merged.canonicalAssetPaths).toEqual(['mac.dmg', ...candidate.assetPaths, candidate.receiptPath, candidate.waiverPath]);
      expect(merged.canonicalAssets.at(-1)).toEqual(candidate.waiverAsset);
      expect(merged.publicAssetPaths).toEqual(['mac.dmg', ...candidate.assetPaths]);
      expect(merged.publicAssets).toEqual(candidate.assets);
    });
    it('never covers a produced-but-failed proof, an unbound proof, or a receipt claiming verification without proof', () => {
      for (const alter of [r => { r.installedUpgradeProof.status = 'fail'; r.smoke.installedUpgradeVerified = false; }, r => { r.installedUpgradeProof.toVersion = '1.2.4'; }, r => { r.installedUpgradeProof.checks.userDataPreserved = false; }, r => { delete r.installedUpgradeProof; }, r => { r.smoke.installedUpgradeVerified = false; }]) {
        const f = fixture(); alter(f.receipt); write(f);
        expect(() => assertWindowsCandidate(f.root, f.expected, { upgradeProofWaiver: { reason } })).toThrow(/installed.*upgrade.*proof/i);
      }
    });
    it('without a waiver the not-produced receipt still fails and no waiver file is written', () => {
      const f = fixture(); notProduced(f.receipt); write(f);
      expect(() => assertWindowsCandidate(f.root, f.expected)).toThrow(/installed.*upgrade.*proof/i);
      expect(fs.existsSync(path.join(f.root, 'windows-upgrade-proof-waiver.json'))).toBe(false);
      const g = fixture(); const candidate = assertWindowsCandidate(g.root, g.expected, { upgradeProofWaiver: { reason } });
      expect(candidate.waiverPath).toBeUndefined();
      expect(fs.existsSync(path.join(g.root, 'windows-upgrade-proof-waiver.json'))).toBe(false);
    });
  });
  it('accepts an unsigned candidate: the channel no longer depends on a paid signing service', () => {
    const f = fixture();
    expect(f.receipt.signatures).toBeUndefined();
    expect(() => assertWindowsCandidate(f.root, f.expected)).not.toThrow();
  });
  it('rejects old signed receipts, missing executable hashes, a setup hash not bound to the asset, failed smoke, stale commit/version', () => {
    for (const alter of [r => { r.schemaVersion = 1; }, r => { r.signing = 'authenticode'; }, r => { delete r.executables.stub; }, r => { r.executables.app.sha256 = 'not-a-hash'; }, r => { r.executables.app.sha256 = ['b'.repeat(64)]; }, r => { r.executables.setup.sha256 = [r.executables.setup.sha256]; }, r => { r.executables.setup.sha256 = 'e'.repeat(64); }, r => { r.smoke.status = 'fail'; }, r => { r.commitSha = 'b'.repeat(40); }, r => { r.version = '1.2.4'; }]) {
      const f = fixture(); alter(f.receipt);
      fs.writeFileSync(path.join(f.root, 'windows-release-receipt.json'), JSON.stringify(f.receipt));
      expect(() => assertWindowsCandidate(f.root, f.expected)).toThrow();
    }
  });
  it('rejects changed bytes, extra files, symlinks, and multiple RELEASES entries', () => {
    const f = fixture(); fs.appendFileSync(path.join(f.root, f.nupkg), 'tamper');
    expect(() => assertWindowsCandidate(f.root, f.expected)).toThrow();
    const g = fixture(); fs.writeFileSync(path.join(g.root, 'extra.exe'), 'extra');
    expect(() => assertWindowsCandidate(g.root, g.expected)).toThrow();
    const h = fixture(); fs.unlinkSync(path.join(h.root, h.setup)); fs.symlinkSync(path.join(h.root, h.nupkg), path.join(h.root, h.setup));
    expect(() => assertWindowsCandidate(h.root, h.expected)).toThrow();
    const j = fixture(); const releases = fs.readFileSync(path.join(j.root, 'RELEASES')); const twice = Buffer.concat([releases, releases]); fs.writeFileSync(path.join(j.root, 'RELEASES'), twice);
    j.receipt.assets.find(a => a.name === 'RELEASES').sha256 = hash(twice); j.receipt.assets.find(a => a.name === 'RELEASES').size = twice.length;
    fs.writeFileSync(path.join(j.root, 'windows-release-receipt.json'), JSON.stringify(j.receipt));
    expect(() => assertWindowsCandidate(j.root, j.expected)).toThrow(/RELEASES/);
  });
  it('adds the identical Windows payload to both inventories, receipt private only', () => {
    const f = fixture(); const candidate = assertWindowsCandidate(f.root, f.expected);
    const mac = { canonicalAssets: [], publicAssets: [], canonicalAssetPaths: ['mac.dmg', 'mac.zip', 'security.json'], publicAssetPaths: ['mac.dmg', 'mac.zip'] };
    const merged = appendWindowsAssets(mac, candidate);
    expect(merged.canonicalAssetPaths).toEqual([...mac.canonicalAssetPaths, ...candidate.assetPaths, candidate.receiptPath]);
    expect(merged.publicAssetPaths).toEqual([...mac.publicAssetPaths, ...candidate.assetPaths]);
    expect(mac.publicAssetPaths).toHaveLength(2);
  });
  it('orders the Windows channel without letting a newer Mac-only release block it', () => {
    expect(() => assertMonotonicWindowsRelease([
      {
        tag_name: 'v1.2.4',
        draft: false,
        prerelease: false,
        assets: ['NexusIDE-1.2.4-arm64.dmg', 'NexusIDE-darwin-arm64-1.2.4.zip'],
      },
    ], '1.2.3')).not.toThrow();
    expect(() => assertMonotonicWindowsRelease([
      {
        tag_name: 'v1.2.4',
        draft: false,
        prerelease: false,
        assets: ['NexusIDE-1.2.4-win32-x64-Setup.exe'],
      },
    ], '1.2.3')).toThrow(/newer stable/);
    expect(() => assertMonotonicWindowsRelease([
      { tag_name: 'v1.2.3', assets: ['NexusIDE-1.2.3-win32-x64-Setup.exe'] },
      { tag_name: 'v9.0.0', draft: true, assets: ['NexusIDE-9.0.0-win32-x64-Setup.exe'] },
    ], '1.2.3')).not.toThrow();
  });
});

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { extractWindowsArchive, assertWindowsArchiveEntries, assertWindowsRun, assertWindowsArtifact, assertWindowsCandidate, assertMonotonicWindowsRelease, appendWindowsAssets, requireWindowsRunId } from './windows-release-candidate.mjs';

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
  const payloads = { [setup]: Buffer.from('signed setup'), [nupkg]: Buffer.from('signed package') };
  payloads.RELEASES = Buffer.from(`${hash(payloads[nupkg], 'sha1')} ${nupkg} ${payloads[nupkg].length}\n`);
  const signature = { status: 'Valid', subject: 'CN=HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA, O=HIPERSEND', thumbprint: 'B'.repeat(40), timestampThumbprint: 'C'.repeat(40) };
  const receipt = { schemaVersion: 1, version: '1.2.3', commitSha: sha, runId: '42', platform: 'win32', arch: 'x64', smoke: { status: 'pass' }, signatures: { setup: signature, app: signature, updater: signature, stub: signature }, assets: Object.entries(payloads).map(([name, bytes]) => ({ name, size: bytes.length, sha256: hash(bytes) })) };
  for (const [name, bytes] of Object.entries(payloads)) fs.writeFileSync(path.join(root, name), bytes);
  fs.writeFileSync(path.join(root, 'windows-release-receipt.json'), JSON.stringify(receipt));
  return { root, receipt, setup, nupkg, expected: { version: '1.2.3', commitSha: sha, runId: '42' } };
}
describe('signed Windows workflow authority', () => {
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
    const artifact = { name: 'windows-x64-signed-release', expired: false, digest: `sha256:${hash(bytes)}`, workflow_run: { id: 42, head_sha: sha, repository_id: 12, head_repository_id: 12 } };
    expect(() => assertWindowsArtifact(artifact, bytes, run)).not.toThrow();
    for (const value of [{ ...artifact, expired: true }, { ...artifact, digest: null }, { ...artifact, workflow_run: { ...artifact.workflow_run, id: 43 } }]) expect(() => assertWindowsArtifact(value, bytes, run)).toThrow();
    expect(() => assertWindowsArtifact(artifact, Buffer.from('tampered'), run)).toThrow();
  });
});
describe('Windows candidate bytes within an authenticated archive', () => {
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
  it('rejects unsigned, wrong publisher, missing timestamp, failed smoke, stale commit/version', () => {
    for (const alter of [r => { r.signatures.app.status = 'NotSigned'; }, r => { r.signatures.setup.subject = 'CN=Other'; }, r => { r.signatures.updater.timestampThumbprint = ''; }, r => { r.smoke.status = 'fail'; }, r => { r.commitSha = 'b'.repeat(40); }, r => { r.version = '1.2.4'; }]) {
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
  it('blocks old stable publication but permits exact-version replay and ignores drafts', () => {
    expect(() => assertMonotonicWindowsRelease([{ tag_name: 'v1.2.4', draft: false, prerelease: false }], '1.2.3')).toThrow(/newer stable/);
    expect(() => assertMonotonicWindowsRelease([{ tag_name: 'v1.2.3' }, { tag_name: 'v9.0.0', draft: true }], '1.2.3')).not.toThrow();
  });
});

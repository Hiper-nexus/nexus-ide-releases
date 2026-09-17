import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_REPO,
  MIRROR_REPO,
  PENDING,
  RECEIPT,
  WAIVER,
  assertFinalWindowsReleaseSnapshots,
  buildGitHubReleaseDeletePendingArgs,
  buildGitHubReleaseUploadArgs,
  classifyWindowsReleaseSnapshots,
  compareReceiptBytes,
  markerAsset,
  windowsAssetNames,
} from './publish-windows-release.mjs';

const version = '1.2.3';
const tag = `v${version}`;
const commitSha = 'a'.repeat(40);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const asset = (name, value = name) => ({
  name,
  size: Buffer.byteLength(value),
  sha256: digest(value),
});
const remoteAsset = (entry, patch = {}) => ({
  name: entry.name,
  size: entry.size,
  state: 'uploaded',
  digest: `sha256:${entry.sha256}`,
  ...patch,
});
const release = (assets, patch = {}) => ({
  tagName: tag,
  isDraft: false,
  publishedAt: '2026-09-15T12:00:00Z',
  assets,
  ...patch,
});

const windowsAssets = windowsAssetNames(version).map((name) => asset(name));
const receiptAsset = asset(RECEIPT);
const waiverAsset = asset(WAIVER);
const canonicalAssets = [...windowsAssets, receiptAsset];
const canonicalAssetsWithWaiver = [...canonicalAssets, waiverAsset];
const mirrorAssets = windowsAssets;

describe('Windows-only release publication helpers', () => {
  it('classifies the expected pending and idempotent release states', () => {
    const pending = markerAsset(version, commitSha);
    expect(classifyWindowsReleaseSnapshots({
      canonical: release([remoteAsset(pending), remoteAsset(asset('NexusIDE.dmg'))]),
      mirror: release([remoteAsset(asset('NexusIDE.zip'))]),
      tag,
      version,
      commitSha,
      canonicalAssets,
      mirrorAssets,
    })).toEqual({ kind: 'pending' });

    expect(classifyWindowsReleaseSnapshots({
      canonical: release(canonicalAssets.map((entry) => remoteAsset(entry))),
      mirror: release(mirrorAssets.map((entry) => remoteAsset(entry))),
      tag,
      version,
      commitSha,
      canonicalAssets,
      mirrorAssets,
    })).toEqual({ kind: 'already-attached' });
  });

  it('allows a canonical waiver only when the verified candidate produced one', () => {
    expect(classifyWindowsReleaseSnapshots({
      canonical: release(canonicalAssetsWithWaiver.map((entry) => remoteAsset(entry))),
      mirror: release(mirrorAssets.map((entry) => remoteAsset(entry))),
      tag,
      version,
      commitSha,
      canonicalAssets: canonicalAssetsWithWaiver,
      mirrorAssets,
    })).toEqual({ kind: 'already-attached' });

    expect(() => classifyWindowsReleaseSnapshots({
      canonical: release(canonicalAssetsWithWaiver.map((entry) => remoteAsset(entry))),
      mirror: release(mirrorAssets.map((entry) => remoteAsset(entry))),
      tag,
      version,
      commitSha,
      canonicalAssets,
      mirrorAssets,
    })).toThrow(/unexpected Windows assets/);
  });

  it('blocks drafts, partial uploads, stale pending markers and mirror-private evidence', () => {
    const pending = markerAsset(version, commitSha);
    const badPending = { ...pending, sha256: digest('wrong marker') };
    for (const snapshot of [
      {
        canonical: release([remoteAsset(pending)], { isDraft: true }),
        mirror: release([]),
      },
      {
        canonical: release([remoteAsset(pending), remoteAsset(windowsAssets[0])]),
        mirror: release([]),
      },
      {
        canonical: release([remoteAsset(badPending)]),
        mirror: release([]),
      },
      {
        canonical: release(canonicalAssets.map((entry) => remoteAsset(entry))),
        mirror: release([...mirrorAssets, receiptAsset].map((entry) => remoteAsset(entry))),
      },
      {
        canonical: release(canonicalAssets.map((entry) => remoteAsset(entry))),
        mirror: release(mirrorAssets.map((entry, index) =>
          remoteAsset(entry, index === 0 ? { digest: `sha256:${digest('tampered')}` } : {}),
        )),
      },
    ]) {
      expect(() => classifyWindowsReleaseSnapshots({
        canonical: snapshot.canonical,
        mirror: snapshot.mirror,
        tag,
        version,
        commitSha,
        canonicalAssets,
        mirrorAssets,
      })).toThrow();
    }
  });

  it('asserts the final exact Windows asset names, sizes, digests and states', () => {
    expect(() => assertFinalWindowsReleaseSnapshots({
      canonical: release(canonicalAssets.map((entry) => remoteAsset(entry))),
      mirror: release(mirrorAssets.map((entry) => remoteAsset(entry))),
      tag,
      version,
      commitSha,
      canonicalAssets,
      mirrorAssets,
    })).not.toThrow();
    expect(() => assertFinalWindowsReleaseSnapshots({
      canonical: release(canonicalAssets.map((entry, index) =>
        remoteAsset(entry, index === 0 ? { state: 'new' } : {}),
      )),
      mirror: release(mirrorAssets.map((entry) => remoteAsset(entry))),
      tag,
      version,
      commitSha,
      canonicalAssets,
      mirrorAssets,
    })).toThrow();
    expect(() => assertFinalWindowsReleaseSnapshots({
      canonical: release([remoteAsset(markerAsset(version, commitSha))]),
      mirror: release([]),
      tag,
      version,
      commitSha,
      canonicalAssets,
      mirrorAssets,
    })).toThrow(/not fully attached/);
  });

  it('builds pinned gh upload and delete commands', () => {
    expect(buildGitHubReleaseUploadArgs({
      tag,
      repo: CANONICAL_REPO,
      assetPaths: ['/tmp/z.exe', '/tmp/a.nupkg'],
    })).toEqual([
      'release',
      'upload',
      tag,
      '--repo',
      `github.com/${CANONICAL_REPO}`,
      '--clobber',
      '/tmp/a.nupkg',
      '/tmp/z.exe',
    ]);
    expect(buildGitHubReleaseDeletePendingArgs({ tag, repo: MIRROR_REPO })).toEqual([
      'release',
      'delete-asset',
      tag,
      PENDING,
      '--repo',
      `github.com/${MIRROR_REPO}`,
      '--yes',
    ]);
  });

  it('compares the local receipt to the worker receipt byte-for-byte', () => {
    expect(compareReceiptBytes(Buffer.from('same'), Buffer.from('same'))).toMatchObject({
      equal: true,
      localSha256: digest('same'),
      artifactSha256: digest('same'),
    });
    expect(compareReceiptBytes(Buffer.from('same'), Buffer.from('same\n'))).toMatchObject({
      equal: false,
      localSha256: digest('same'),
      artifactSha256: digest('same\n'),
    });
  });
});

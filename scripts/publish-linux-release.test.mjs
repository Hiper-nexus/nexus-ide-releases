import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_REPO,
  MIRROR_REPO,
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  LEGACY_RECEIPT_SCHEMA,
  SHA256SUMS_FILE,
  assertLinuxInventory,
  assertLinuxReceipt,
  assertLinuxRun,
  linuxAssetNames,
  planLinuxAssetUploads,
  publishLinuxReleaseCore,
  sha256SumsContent,
} from './publish-linux-release.mjs';

const VERSION = '0.76.151';
const TAG = `v${VERSION}`;
const RUN_ID = '424242';
const COMMIT = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);
const DISPATCH_SHA = 'c'.repeat(40);
const digest = (value) => createHash('sha256').update(value).digest('hex');

const roots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-linux-publish-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeRoot(version = VERSION) {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'nexus-ide', version }),
  );
  return root;
}

function makeReceipt(patch = {}) {
  const names = linuxAssetNames(VERSION);
  return {
    schema: RECEIPT_SCHEMA,
    version: VERSION,
    commit: COMMIT,
    tagObject: TAG_OBJECT,
    dispatchSha: DISPATCH_SHA,
    runId: RUN_ID,
    runAttempt: '1',
    node: '22.23.2',
    npm: '12.0.0',
    runner: 'ubuntu-22.04',
    arch: 'x64',
    smoke: { packaged: true, debInstalled: true, zipExtracted: true },
    files: [
      { name: names[0], bytes: 11, sha256: digest('deb-payload') },
      { name: names[1], bytes: 11, sha256: digest('rpm-payload') },
      { name: names[2], bytes: 11, sha256: digest('zip-payload') },
    ],
    ...patch,
  };
}

function makeRun(patch = {}) {
  return {
    databaseId: Number(RUN_ID),
    workflowName: 'Linux x64 release',
    event: 'workflow_dispatch',
    headBranch: 'main',
    headSha: DISPATCH_SHA,
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
    ...patch,
  };
}

const remoteAsset = (name, sha256, patch = {}) => ({
  name,
  size: 1,
  state: 'uploaded',
  digest: `sha256:${sha256}`,
  ...patch,
});

function makeRelease(patch = {}) {
  return { tagName: TAG, isDraft: false, assets: [], ...patch };
}

/**
 * Injectable seams driving publishLinuxReleaseCore without touching git or
 * GitHub: `overrides.releases` maps repo → release JSON (or null for 404);
 * `overrides.payloads` maps file name → bytes for the artifact download.
 */
function makeSeams(overrides = {}) {
  const receipts = overrides.receipts ?? [makeReceipt()];
  const runs = overrides.runs ?? [makeRun()];
  const releases = overrides.releases ?? {
    [CANONICAL_REPO]: makeRelease(),
    [MIRROR_REPO]: makeRelease(),
  };
  const payloads = overrides.payloads ?? {
    [linuxAssetNames(VERSION)[0]]: 'deb-payload',
    [linuxAssetNames(VERSION)[1]]: 'rpm-payload',
    [linuxAssetNames(VERSION)[2]]: 'zip-payload',
  };
  const uploads = [];
  const downloads = [];
  const ghJson = vi.fn((args) => {
    if (args[0] === 'run' && args[1] === 'view') {
      const run = runs.shift();
      if (!run) throw new Error('run view failed');
      return run;
    }
    if (args[0] === 'release' && args[1] === 'view') {
      const repo = args[args.indexOf('--repo') + 1].replace('github.com/', '');
      const release = releases[repo];
      if (release === null || release === undefined) {
        throw new Error('release view failed');
      }
      return release;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
  const ghRun = vi.fn((args) => {
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('--dir') + 1];
      const name = args[args.indexOf('--name') + 1];
      downloads.push(name);
      fs.mkdirSync(dir, { recursive: true });
      if (name === 'linux-x64-receipt') {
        const receipt = receipts.shift() ?? makeReceipt();
        fs.writeFileSync(
          path.join(dir, RECEIPT_FILE),
          JSON.stringify(receipt),
        );
      } else {
        for (const [name, bytes] of Object.entries(payloads)) {
          fs.writeFileSync(path.join(dir, name), bytes);
        }
        const receipt = overrides.assetsReceipt ?? makeReceipt();
        fs.writeFileSync(
          path.join(dir, RECEIPT_FILE),
          JSON.stringify(receipt),
        );
      }
      return;
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      const repo = args[args.indexOf('--repo') + 1].replace('github.com/', '');
      const file = args[args.length - 1];
      uploads.push({ repo, file: path.basename(file) });
      // Reflect the upload into the fake release so the post-upload check sees it.
      const release = releases[repo];
      if (release) {
        release.assets.push(
          remoteAsset(path.basename(file), digest(fs.readFileSync(file))),
        );
      }
      return;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
  const git = vi.fn((args) => {
    const key = args.slice(0, 2).join(' ');
    if (key === 'fetch origin') return '';
    if (key === 'cat-file -t') return 'tag';
    if (args[0] === 'rev-parse' && args[1].endsWith('^{}')) return COMMIT;
    if (args[0] === 'rev-parse') return TAG_OBJECT;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  return {
    seams: {
      ghJson,
      ghRun,
      git,
      tempDir: () => tempRoot(),
    },
    uploads,
    downloads,
  };
}

describe('publish-linux-release', () => {
  it('publishes deb, rpm, portable zip and SHA256SUMS to canonical first then the mirror', async () => {
    const root = makeRoot();
    const { seams, uploads } = makeSeams();
    const summary = await publishLinuxReleaseCore({
      root,
      argv: { version: VERSION, run: RUN_ID },
      seams,
    });
    expect(summary.status).toBe('pass');
    expect(summary.version).toBe(VERSION);
    expect(summary.commit).toBe(COMMIT);
    expect(summary.assets.map((a) => a.name)).toEqual([
      ...linuxAssetNames(VERSION),
      SHA256SUMS_FILE,
    ]);
    // Canonical uploads strictly precede the mirror's.
    const canonicalUploads = uploads.filter((u) => u.repo === CANONICAL_REPO);
    const mirrorUploads = uploads.filter((u) => u.repo === MIRROR_REPO);
    expect(canonicalUploads).toHaveLength(4);
    expect(mirrorUploads).toHaveLength(4);
    expect(uploads.slice(0, 4).every((u) => u.repo === CANONICAL_REPO)).toBe(true);
    expect(uploads.slice(4).every((u) => u.repo === MIRROR_REPO)).toBe(true);
    // SHA256SUMS uses the sha256sum two-space text format.
    const names = linuxAssetNames(VERSION);
    expect(sha256SumsContent(makeReceipt().files)).toBe(
      `${digest('deb-payload')}  ${names[0]}\n${digest('rpm-payload')}  ${names[1]}\n${digest('zip-payload')}  ${names[2]}\n`,
    );
  });

  it('skips identical existing assets and uploads only the missing ones', async () => {
    const root = makeRoot();
    const names = linuxAssetNames(VERSION);
    const existing = remoteAsset(names[0], digest('deb-payload'));
    const releases = {
      [CANONICAL_REPO]: makeRelease({ assets: [existing] }),
      [MIRROR_REPO]: makeRelease({ assets: [{ ...existing }, remoteAsset(names[1], digest('rpm-payload')), remoteAsset(names[2], digest('zip-payload')), remoteAsset(SHA256SUMS_FILE, digest('x'))] }),
    };
    // Mirror already has all four with correct digests → nothing to upload there.
    releases[MIRROR_REPO].assets[3] = remoteAsset(
      SHA256SUMS_FILE,
      digest(sha256SumsContent(makeReceipt().files)),
    );
    const { seams, uploads } = makeSeams({ releases });
    const summary = await publishLinuxReleaseCore({
      root,
      argv: { version: VERSION, run: RUN_ID },
      seams,
    });
    expect(summary.repositories[0].skipped).toEqual([names[0]]);
    expect(summary.repositories[0].uploaded.sort()).toEqual(
      [names[1], names[2], SHA256SUMS_FILE].sort(),
    );
    expect(summary.repositories[1].uploaded).toEqual([]);
    expect(uploads.every((u) => u.repo === CANONICAL_REPO)).toBe(true);
  });

  it('fails when an existing asset carries a different digest', async () => {
    const root = makeRoot();
    const releases = {
      [CANONICAL_REPO]: makeRelease({
        assets: [remoteAsset(linuxAssetNames(VERSION)[0], digest('tampered'))],
      }),
      [MIRROR_REPO]: makeRelease(),
    };
    const { seams, uploads } = makeSeams({ releases });
    await expect(
      publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
    ).rejects.toThrow(/different payload/);
    expect(uploads).toHaveLength(0);
  });

  it('fails when the release is missing or still a draft', async () => {
    const root = makeRoot();
    for (const releases of [
      { [CANONICAL_REPO]: null, [MIRROR_REPO]: makeRelease() },
      { [CANONICAL_REPO]: makeRelease({ isDraft: true }), [MIRROR_REPO]: makeRelease() },
    ]) {
      const { seams } = makeSeams({ releases });
      await expect(
        publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
      ).rejects.toThrow(/must exist and be published/);
    }
  });

  it.each([
    [{ conclusion: 'failure' }, /successful/],
    [{ event: 'push' }, /dispatched/],
    [{ headBranch: 'feat/other' }, /main/],
    [{ workflowName: 'Something else' }, /workflow/],
  ])('rejects a run that does not match the protected workflow %j', async (patch) => {
    const root = makeRoot();
    const { seams, downloads } = makeSeams({ runs: [makeRun(patch)] });
    await expect(
      publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
    ).rejects.toThrow();
    expect(downloads).toHaveLength(0);
  });

  it.each([
    [{ version: '9.9.9' }],
    [{ commit: 'd'.repeat(40) }],
    [{ tagObject: 'e'.repeat(40) }],
    [{ runId: '999' }],
  ])('rejects a receipt that is not bound to the tag and run %j', async (patch) => {
    const root = makeRoot();
    const { seams } = makeSeams({ receipts: [makeReceipt(patch)] });
    await expect(
      publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects payload bytes that differ from the receipt', async () => {
    const root = makeRoot();
    const { seams } = makeSeams({
      payloads: {
        [linuxAssetNames(VERSION)[0]]: 'deb-payload',
        [linuxAssetNames(VERSION)[1]]: 'tampered-bytes',
      },
    });
    await expect(
      publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
    ).rejects.toThrow(/bytes do not match/);
  });

  it('rejects an asset artifact with a missing or extra file', async () => {
    const root = makeRoot();
    for (const payloads of [
      { [linuxAssetNames(VERSION)[0]]: 'deb-payload' },
      {
        [linuxAssetNames(VERSION)[0]]: 'deb-payload',
        [linuxAssetNames(VERSION)[1]]: 'rpm-payload',
        'unexpected.txt': 'x',
      },
    ]) {
      const { seams } = makeSeams({ payloads });
      await expect(
        publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
      ).rejects.toThrow();
    }
  });

  it('requires a lightweight tag to be rejected', async () => {
    const root = makeRoot();
    const { seams } = makeSeams();
    seams.git = vi.fn((args) => {
      if (args.slice(0, 2).join(' ') === 'cat-file -t') return 'commit';
      if (args[0] === 'rev-parse') return COMMIT;
      return '';
    });
    await expect(
      publishLinuxReleaseCore({ root, argv: { version: VERSION, run: RUN_ID }, seams }),
    ).rejects.toThrow(/annotated/);
  });
});

describe('pure helpers', () => {
  it('requires ZIP smoke for v2 and preserves only the explicit historical v1 pair', async () => {
    const expected = { version: VERSION, commitSha: COMMIT, tagObjectSha: TAG_OBJECT, runId: RUN_ID, runAttempt: 1, dispatchSha: DISPATCH_SHA };
    const legacy = makeReceipt({ schema: LEGACY_RECEIPT_SCHEMA, smoke: { packaged: true, debInstalled: true } });
    legacy.files = legacy.files.slice(0, 2);
    expect(() => assertLinuxReceipt(legacy, expected)).not.toThrow();
    expect(() => assertLinuxInventory(legacy.files, VERSION, legacy.schema)).not.toThrow();
    expect(() => assertLinuxInventory(legacy.files, VERSION)).toThrow();
    expect(() => assertLinuxInventory(makeReceipt().files, VERSION, LEGACY_RECEIPT_SCHEMA)).toThrow();
    expect(() => assertLinuxReceipt(makeReceipt({ smoke: { packaged: true, debInstalled: true } }), expected)).toThrow();
    expect(() => assertLinuxInventory(legacy.files, VERSION, 'nexus.linux-preview/v1')).toThrow();
    const names = linuxAssetNames(VERSION, LEGACY_RECEIPT_SCHEMA);
    const { seams } = makeSeams({ receipts: [legacy], assetsReceipt: legacy, payloads: { [names[0]]: 'deb-payload', [names[1]]: 'rpm-payload' } });
    const result = await publishLinuxReleaseCore({ root: makeRoot(), argv: { version: VERSION, run: RUN_ID }, seams });
    expect(result.assets.map((file) => file.name)).toEqual([...names, SHA256SUMS_FILE]);
  });
  it('assertLinuxRun accepts only the successful workflow_dispatch on main', () => {
    expect(() => assertLinuxRun(makeRun(), RUN_ID)).not.toThrow();
    expect(() => assertLinuxRun(null, RUN_ID)).toThrow();
    expect(() => assertLinuxRun(makeRun({ databaseId: 1 }), RUN_ID)).toThrow();
  });

  it('assertLinuxReceipt binds schema, version, commit, tag object and run', () => {
    const expected = {
      version: VERSION,
      commitSha: COMMIT,
      tagObjectSha: TAG_OBJECT,
      runId: RUN_ID,
      runAttempt: 1,
      dispatchSha: DISPATCH_SHA,
    };
    expect(() => assertLinuxReceipt(makeReceipt(), expected)).not.toThrow();
    expect(() =>
      assertLinuxReceipt({ ...makeReceipt(), schema: 'other/v9' }, expected),
    ).toThrow();
    expect(() =>
      assertLinuxReceipt(
        { ...makeReceipt(), smoke: { packaged: false, debInstalled: true } },
        expected,
      ),
    ).toThrow();
  });

  it('assertLinuxInventory requires exactly the maker names', () => {
    const names = linuxAssetNames(VERSION);
    expect(() =>
      assertLinuxInventory(
        names.map((name) => ({ name })),
        VERSION,
      ),
    ).not.toThrow();
    expect(() =>
      assertLinuxInventory([{ name: names[0] }], VERSION),
    ).toThrow();
    expect(() =>
      assertLinuxInventory(
        [...names.map((name) => ({ name })), { name: 'extra.deb' }],
        VERSION,
      ),
    ).toThrow();
  });

  it('planLinuxAssetUploads skips only digest-identical assets', () => {
    const files = [
      { name: 'a.deb', sha256: digest('a') },
      { name: 'b.rpm', sha256: digest('b') },
    ];
    expect(
      planLinuxAssetUploads([remoteAsset('a.deb', digest('a'))], files),
    ).toEqual({ upload: [files[1]], skipped: ['a.deb'] });
    expect(() =>
      planLinuxAssetUploads([remoteAsset('a.deb', digest('other'))], files),
    ).toThrow(/different payload/);
    expect(() =>
      planLinuxAssetUploads([{ name: 'a.deb' }], files),
    ).toThrow(/different payload/);
  });
});

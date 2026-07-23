import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertReleaseRepositoryState,
  parseVerifiedTagSignerFingerprint,
  readAndAssertReleaseAuthority,
} from './release-authority.mjs';

const roots = [];
const FINGERPRINT = 'A'.repeat(40);

function authorityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-authority-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'nexus-ide',
      version: '1.2.3',
      packageManager: 'npm@12.0.0',
      nexusRelease: { node: '22.23.1' },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'server', 'package.json'),
    JSON.stringify({ name: '@nexus/server', version: '1.2.3' }),
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      version: '1.2.3',
      lockfileVersion: 3,
      packages: {
        '': { name: 'nexus-ide', version: '1.2.3' },
        server: { name: '@nexus/server', version: '1.2.3' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'shared', 'release-notes.ts'),
    "export const CURRENT_RELEASE = { version: '1.2.3', date: '2026-07-23' };\n",
  );
  fs.writeFileSync(
    path.join(root, 'CHANGELOG.md'),
    '## 1.2.3 — Release\n',
  );
  fs.writeFileSync(
    path.join(root, 'build', 'release-tag-signers.json'),
    JSON.stringify({
      schemaVersion: 1,
      fingerprints: [FINGERPRINT],
    }),
  );
  fs.writeFileSync(
    path.join(root, 'build', 'release-npm-integrity.json'),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        '12.0.0':
          'sha512-qzvPQfNSY7louiM6rv7dL0hi5esBGLn1lLwxbdyL5XOIssWzoYMwn8xqvWhYcZL6onTkenYSxrtKxsFrFbUFyw==',
      },
    }),
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('release metadata and signed-tag authority', () => {
  it('accepts one coherent metadata version and a repository-pinned signer', () => {
    const root = authorityFixture();
    expect(readAndAssertReleaseAuthority(root)).toMatchObject({
      version: '1.2.3',
      tag: 'v1.2.3',
      nodeVersion: '22.23.1',
      npmVersion: '12.0.0',
      npmPackageIntegrity:
        'sha512-qzvPQfNSY7louiM6rv7dL0hi5esBGLn1lLwxbdyL5XOIssWzoYMwn8xqvWhYcZL6onTkenYSxrtKxsFrFbUFyw==',
      allowedTagSignerFingerprints: [FINGERPRINT],
    });
  });

  it('requires an exact repository-pinned Node patch for release builds', () => {
    const root = authorityFixture();
    const packagePath = path.join(root, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.nexusRelease.node = '>=22.12.0 <23';
    fs.writeFileSync(packagePath, JSON.stringify(packageJson));

    expect(() => readAndAssertReleaseAuthority(root)).toThrow(
      /exact Node release version/i,
    );
  });

  it('fails when server/lock/release notes/changelog diverge', () => {
    const root = authorityFixture();
    fs.writeFileSync(
      path.join(root, 'server', 'package.json'),
      JSON.stringify({ name: '@nexus/server', version: '1.2.2' }),
    );
    expect(() => readAndAssertReleaseAuthority(root)).toThrow(/metadata.*version/i);
  });

  it('records an unsigned annotated-tag policy when no signer is pinned', () => {
    const root = authorityFixture();
    fs.writeFileSync(
      path.join(root, 'build', 'release-tag-signers.json'),
      JSON.stringify({ schemaVersion: 1, fingerprints: [] }),
    );
    const authority = readAndAssertReleaseAuthority(root);
    expect(authority.allowedTagSignerFingerprints).toEqual([]);
    expect(assertReleaseRepositoryState({
      statusPorcelain: '',
      headSha: 'a'.repeat(40),
      tagCommitSha: 'a'.repeat(40),
      tagObjectSha: 'b'.repeat(40),
      tagObjectType: 'tag',
      tagSignerFingerprint: null,
      version: '1.2.3',
      allowedTagSignerFingerprints: [],
    })).toMatchObject({
      tagSignatureVerified: false,
      tagSignerFingerprint: null,
    });
  });

  it('requires an annotated, validly signed tag from the pinned identity', () => {
    const valid = {
      statusPorcelain: '',
      headSha: 'a'.repeat(40),
      tagCommitSha: 'a'.repeat(40),
      tagObjectSha: 'b'.repeat(40),
      tagObjectType: 'tag',
      tagSignerFingerprint: FINGERPRINT,
      version: '1.2.3',
      allowedTagSignerFingerprints: [FINGERPRINT],
    };
    expect(assertReleaseRepositoryState(valid)).toMatchObject({
      commitSha: 'a'.repeat(40),
      tag: 'v1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: FINGERPRINT,
    });
    expect(() => assertReleaseRepositoryState({
      ...valid,
      tagObjectType: 'commit',
    })).toThrow(/annotated/i);
    expect(() => assertReleaseRepositoryState({
      ...valid,
      tagSignerFingerprint: 'C'.repeat(40),
    })).toThrow(/signer/i);
  });

  it('extracts GPG and SSH verified signer fingerprints without trusting prose', () => {
    expect(parseVerifiedTagSignerFingerprint(
      `[GNUPG:] VALIDSIG ${FINGERPRINT} 2026-07-23 0 4 0 1 10 00 ${FINGERPRINT}\n`,
    )).toBe(FINGERPRINT);
    expect(parseVerifiedTagSignerFingerprint(
      'Good "git" signature for release@example.com with ED25519 key SHA256:abcdefghijklmnop\n',
    )).toBe('SHA256:abcdefghijklmnop');
    expect(() => parseVerifiedTagSignerFingerprint('Good signature')).toThrow(
      /fingerprint/i,
    );
  });
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  assertReleaseBuildPreconditions,
  bootstrapPinnedNpm,
  cleanReleaseMakeOutput,
  runCleanReleaseBuild,
} from './make-release.mjs';

describe('publishable macOS build target', () => {
  const npmArchive = 'test npm 12.0.0 archive';
  const npmPackageIntegrity = `sha512-${createHash('sha512')
    .update(npmArchive)
    .digest('base64')}`;
  const repository = {
    statusPorcelain: '',
    headSha: 'a'.repeat(40),
    tagCommitSha: 'a'.repeat(40),
    tagObjectSha: 'b'.repeat(40),
    tagObjectType: 'tag',
    tagSignerFingerprint: null,
  };
  const authority = {
    version: '1.2.3',
    tag: 'v1.2.3',
    nodeVersion: '22.23.1',
    npmVersion: '12.0.0',
    npmPackageIntegrity,
    allowedTagSignerFingerprints: [],
  };

  it('requires the exact Team ID/profile and the release tag on clean HEAD', () => {
    expect(() => assertReleaseBuildPreconditions({
      environment: {},
      repository,
      version: '1.2.3',
      allowedTagSignerFingerprints: [],
    })).toThrow(/NEXUS_MAC_PUBLISH_RELEASE/);
    expect(() => assertReleaseBuildPreconditions({
      environment: {
        NEXUS_MAC_PUBLISH_RELEASE: '1',
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus_notary',
      },
      repository,
      version: '1.2.3',
      allowedTagSignerFingerprints: [],
    })).toThrow(/nexus-notary/);
    expect(() => assertReleaseBuildPreconditions({
      environment: {
        NEXUS_MAC_PUBLISH_RELEASE: '1',
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
      },
      repository: { ...repository, tagCommitSha: 'b'.repeat(40) },
      version: '1.2.3',
      allowedTagSignerFingerprints: [],
    })).toThrow(/tag.*HEAD/i);
    expect(assertReleaseBuildPreconditions({
      environment: {
        NEXUS_MAC_PUBLISH_RELEASE: '1',
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
      },
      repository,
      version: '1.2.3',
      allowedTagSignerFingerprints: [],
    })).toEqual({
      commitSha: 'a'.repeat(40),
      tag: 'v1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: null,
      tagSignatureVerified: false,
    });
  });

  it('builds only after npm ci in a disposable detached worktree and seals provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clean-release-'));
    const calls = [];
    try {
      fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock');
      const runCommand = vi.fn((command, args, options) => {
        calls.push([command, [...args], options.cwd]);
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
          fs.mkdirSync(args[3], { recursive: true });
          fs.copyFileSync(
            path.join(root, 'package-lock.json'),
            path.join(args[3], 'package-lock.json'),
          );
        }
        if (command === 'git' && args[0] === 'rev-parse') {
          return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
        }
        if (command === 'git' && args[0] === 'status') {
          return { stdout: '', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'pack') {
          const downloadDir = args[args.indexOf('--pack-destination') + 1];
          fs.writeFileSync(
            path.join(downloadDir, 'npm-12.0.0.tgz'),
            npmArchive,
          );
        }
        if (command === '/usr/bin/tar') {
          const installDir = args[args.indexOf('-C') + 1];
          const packageRoot = path.join(installDir, 'package');
          fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
          fs.writeFileSync(
            path.join(packageRoot, 'package.json'),
            JSON.stringify({ name: 'npm', version: '12.0.0' }),
          );
          fs.writeFileSync(path.join(packageRoot, 'bin', 'npm-cli.js'), 'cli');
        }
        if (
          command === process.execPath &&
          args[0]?.endsWith('/npm-cli.js') &&
          args[1] === '--version'
        ) {
          return { stdout: '12.0.0\n', stderr: '' };
        }
        if (
          command === process.execPath &&
          args.some((value) => /electron-forge\.js$/u.test(value))
        ) {
          const make = path.join(options.cwd, 'out', 'make', 'nested');
          fs.mkdirSync(make, { recursive: true });
          const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
          fs.writeFileSync(path.join(make, `NexusIDE-${arch}.dmg`), 'dmg');
          fs.writeFileSync(path.join(make, `NexusIDE-${arch}.zip`), 'zip');
        }
        return { stdout: '', stderr: '' };
      });
      const result = runCleanReleaseBuild({
        root,
        platform: 'darwin',
        environment: {
          PATH: process.env.PATH,
          HOME: os.homedir(),
          NEXUS_MAC_PUBLISH_RELEASE: '1',
          APPLE_TEAM_ID: '35P5XL3JN6',
          APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
        },
        authority,
        repository,
        nodeVersion: 'v22.23.1',
        runCommand,
      });
      expect(calls.some(([, args]) =>
        args.slice(0, 3).join(' ') === 'worktree add --detach',
      )).toBe(true);
      const npmCi = calls.findIndex(
        ([command, args]) =>
          command === process.execPath &&
          args[0]?.endsWith('/npm-cli.js') &&
          args[1] === 'ci',
      );
      const forge = calls.findIndex(
        ([command, args]) =>
          command === process.execPath &&
          args.some((value) => /electron-forge\.js$/u.test(value)),
      );
      expect(npmCi).toBeGreaterThan(-1);
      expect(npmCi).toBeLessThan(forge);
      const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
      expect(receipt).toMatchObject({
        schemaVersion: 2,
        tagObjectSha: 'b'.repeat(40),
        tagSignatureVerified: false,
        provenance: {
          mode: 'clean-git-worktree',
          npmCi: true,
          sourceCommitSha: 'a'.repeat(40),
          nodeVersion: 'v22.23.1',
          npmVersion: '12.0.0',
          npmPackageIntegrity,
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a different Node 22 patch', () => {
    expect(() =>
      runCleanReleaseBuild({
        root: '/unused',
        platform: 'darwin',
        authority,
        nodeVersion: 'v22.23.0',
      }),
    ).toThrow(/requires Node 22\.23\.1/);
  });

  it('rejects a bootstrapped npm archive outside the pinned integrity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-npm-pin-'));
    try {
      expect(() => bootstrapPinnedNpm({
        buildBase: root,
        version: '12.0.0',
        expectedIntegrity: `sha512-${'A'.repeat(86)}==`,
        environment: {},
        execute(command, args) {
          if (command === 'npm' && args[0] === 'pack') {
            const downloadDir = args[args.indexOf('--pack-destination') + 1];
            fs.writeFileSync(
              path.join(downloadDir, 'npm-12.0.0.tgz'),
              npmArchive,
            );
          }
          return { stdout: '', stderr: '' };
        },
      })).toThrow(/integrity/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans only stale generated maker output before measuring freshness', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-make-release-'));
    try {
      const make = path.join(root, 'out', 'make');
      const sibling = path.join(root, 'out', 'keep.txt');
      fs.mkdirSync(make, { recursive: true });
      fs.writeFileSync(path.join(make, 'stale.dmg'), 'stale');
      fs.writeFileSync(sibling, 'keep');
      cleanReleaseMakeOutput(root);
      expect(fs.existsSync(make)).toBe(false);
      expect(fs.readFileSync(sibling, 'utf8')).toBe('keep');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

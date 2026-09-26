import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  assertDeveloperIdIdentity,
  assertNotaryProfileHistory,
  assertReleaseBuildPreconditions,
  bootstrapPinnedNpm,
  cleanReleaseMakeOutput,
  runCleanReleaseBuild,
  verifyMacReleaseCredentials,
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

  it('authenticates the exact notary profile and usable Developer ID identity before build', () => {
    const calls = [];
    const execute = vi.fn((command, args, options) => {
      calls.push([command, [...args], options]);
      if (args[0] === 'notarytool') {
        return {
          stdout: JSON.stringify({ history: [] }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/security') {
        return {
          stdout:
            '1) ABC "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)"\n' +
            '1 valid identities found\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    expect(
      verifyMacReleaseCredentials({
        execute,
        environment: {},
        root: '/release',
      }),
    ).toBeUndefined();
    expect(calls.map(([command, args]) => [command, args])).toEqual([
      ['/usr/bin/xcrun', ['--find', 'notarytool']],
      ['/usr/bin/xcrun', ['--find', 'stapler']],
      [
        '/usr/bin/xcrun',
        [
          'notarytool',
          'history',
          '--keychain-profile',
          'nexus-notary',
          '--output-format',
          'json',
        ],
      ],
      [
        '/usr/bin/security',
        ['find-identity', '-v', '-p', 'codesigning'],
      ],
    ]);
    expect(calls.every(([, , options]) => options.timeout === 30_000)).toBe(
      true,
    );
    expect(calls[2]?.[2]).toMatchObject({
      maxBuffer: 64 * 1024 * 1024,
    });
  });

  it('fails fast on a missing profile, malformed history or wrong signing identity', () => {
    expect(() => assertNotaryProfileHistory('not-json')).toThrow(
      /invalid JSON/i,
    );
    expect(() => assertNotaryProfileHistory({ message: 'ok' })).toThrow(
      /submission history/i,
    );
    expect(() => assertDeveloperIdIdentity('0 valid identities found')).toThrow(
      /usable code-signing identity/i,
    );
    expect(() =>
      verifyMacReleaseCredentials({
        root: '/release',
        environment: {},
        execute() {
          throw new Error('No Keychain password item found');
        },
      }),
    ).toThrow(/nexus-notary.*unavailable/i);
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
            args[0]?.replaceAll('\\', '/')?.endsWith('/npm-cli.js') &&
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
          NEXUS_MAC_TIMESTAMP_URL: 'http://17.32.213.161/ts01',
          UNRELATED_SECRET: 'nao-passa',
        },
        authority,
        repository,
        nodeVersion: 'v22.23.1',
        runCommand,
        verifyReleaseCredentials: vi.fn(),
      });
      // F-652: a autoridade de carimbo alternativa chega ao Forge; o resto do
      // ambiente continua filtrado.
      const forgeEnv = runCommand.mock.calls.find(
        ([command, args]) =>
          command === process.execPath &&
          args.some((value) => /electron-forge\.js$/u.test(value)),
      )[2].env;
      expect(forgeEnv.NEXUS_MAC_TIMESTAMP_URL).toBe('http://17.32.213.161/ts01');
      expect(forgeEnv.UNRELATED_SECRET).toBeUndefined();
      expect(calls.some(([, args]) =>
        args.slice(0, 3).join(' ') === 'worktree add --detach',
      )).toBe(true);
      const npmCi = calls.findIndex(
          ([command, args]) =>
            command === process.execPath &&
            args[0]?.replaceAll('\\', '/')?.endsWith('/npm-cli.js') &&
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

  it('stops before creating a worktree when Apple credential preflight fails', () => {
    const runCommand = vi.fn(() => {
      throw new Error('worktree must not be created');
    });
    const verifyReleaseCredentials = vi.fn(() => {
      throw new Error('nexus-notary unavailable');
    });

    expect(() =>
      runCleanReleaseBuild({
        root: '/unused',
        platform: 'darwin',
        environment: {
          NEXUS_MAC_PUBLISH_RELEASE: '1',
          APPLE_TEAM_ID: '35P5XL3JN6',
          APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
        },
        authority,
        repository,
        nodeVersion: 'v22.23.1',
        runCommand,
        verifyReleaseCredentials,
      }),
    ).toThrow(/nexus-notary unavailable/i);
    expect(verifyReleaseCredentials).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('fails closed on a different Node 22 patch', () => {
    expect(() =>
      runCleanReleaseBuild({
        root: '/unused',
        platform: 'darwin',
        authority,
        nodeVersion: 'v22.23.0',
        verifyReleaseCredentials: vi.fn(),
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
        platform: 'darwin',
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

  it('uses the Windows npm shim and bundled tar for the pinned npm bootstrap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-npm-pin-win-'));
    try {
      const calls = [];
      bootstrapPinnedNpm({
        buildBase: root,
        version: '12.0.0',
        expectedIntegrity: npmPackageIntegrity,
        environment: {},
        platform: 'win32',
        execute(command, args) {
          calls.push([command, [...args]]);
          if (command === 'npm.cmd' && args[0] === 'pack') {
            const downloadDir = args[args.indexOf('--pack-destination') + 1];
            fs.writeFileSync(
              path.join(downloadDir, 'npm-12.0.0.tgz'),
              npmArchive,
            );
            return { stdout: '', stderr: '' };
          }
          if (command === 'tar' && args[0] === '-xzf') {
            const installDir = args[args.indexOf('-C') + 1];
            const packageDir = path.join(installDir, 'package');
            fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
            fs.writeFileSync(
              path.join(packageDir, 'package.json'),
              JSON.stringify({ name: 'npm', version: '12.0.0' }),
            );
            fs.writeFileSync(path.join(packageDir, 'bin', 'npm-cli.js'), '');
            return { stdout: '', stderr: '' };
          }
          if (command === process.execPath && args.at(-1) === '--version') {
            return { stdout: '12.0.0' + String.fromCharCode(10), stderr: '' };
          }
          throw new Error(`unexpected bootstrap command: ${command}`);
        },
      });
      expect(calls.map(([command]) => command)).toEqual([
        'npm.cmd',
        'tar',
        process.execPath,
      ]);
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

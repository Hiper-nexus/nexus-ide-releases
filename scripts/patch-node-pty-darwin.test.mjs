import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NODE_PTY_DARWIN_VERSION,
  SYSTEM_PERL_HELPER_SOURCE,
  UPSTREAM_HELPER_SOURCE,
  patchNodePtyDarwin,
} from './patch-node-pty-darwin.mjs';

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fixture({ source, helper = true, version = NODE_PTY_DARWIN_VERSION }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-node-pty-patch-'));
  tempDirs.push(root);
  const packageRoot = path.join(
    root,
    'node_modules',
    '@fixture',
    'node-pty-darwin-arm64',
  );
  const sourcePath = path.join(packageRoot, 'lib', 'unixTerminal.js');
  const helperPath = path.join(
    packageRoot,
    'prebuilds',
    'darwin-arm64',
    'spawn-helper',
  );
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@fixture/node-pty-darwin-arm64',
      version,
    }),
  );
  fs.writeFileSync(sourcePath, source);
  if (helper) fs.writeFileSync(helperPath, 'mutable executable');
  return { root, packageRoot, sourcePath, helperPath };
}

function spec(source, patchedSource) {
  return {
    name: '@fixture/node-pty-darwin-arm64',
    arch: 'arm64',
    upstreamSha256: sha256(source),
    patchedSha256: sha256(patchedSource),
  };
}

describe('pinned node-pty Darwin patch', () => {
  it('replaces the exact helper path and removes the bundled executable', () => {
    const source = [
      '"use strict";',
      UPSTREAM_HELPER_SOURCE,
      'exports.ready = true;',
      '',
    ].join('\n');
    const patchedSource = source.replace(
      UPSTREAM_HELPER_SOURCE,
      SYSTEM_PERL_HELPER_SOURCE,
    );
    const tree = fixture({ source });

    expect(
      patchNodePtyDarwin({
        root: tree.root,
        packages: [spec(source, patchedSource)],
      }),
    ).toEqual([
      {
        packageName: '@fixture/node-pty-darwin-arm64',
        installed: true,
        patched: true,
      },
    ]);
    expect(fs.readFileSync(tree.sourcePath, 'utf8')).toBe(patchedSource);
    expect(fs.existsSync(tree.helperPath)).toBe(false);

    expect(
      patchNodePtyDarwin({
        root: tree.root,
        packages: [spec(source, patchedSource)],
      }),
    ).toEqual([
      {
        packageName: '@fixture/node-pty-darwin-arm64',
        installed: true,
        patched: false,
      },
    ]);
  });

  it('fails closed on an unpinned source, version, or helper copy', () => {
    const source = `${UPSTREAM_HELPER_SOURCE}\n`;
    const patchedSource = `${SYSTEM_PERL_HELPER_SOURCE}\n`;

    const mutated = fixture({ source: `${source}// mutation\n` });
    expect(() =>
      patchNodePtyDarwin({
        root: mutated.root,
        packages: [spec(source, patchedSource)],
      }),
    ).toThrow(/hash is outside/);

    const wrongVersion = fixture({ source, version: '1.2.0-beta.13' });
    expect(() =>
      patchNodePtyDarwin({
        root: wrongVersion.root,
        packages: [spec(source, patchedSource)],
      }),
    ).toThrow(/identity\/version/);

    const copied = fixture({ source });
    const unexpected = path.join(copied.packageRoot, 'copy', 'spawn-helper');
    fs.mkdirSync(path.dirname(unexpected), { recursive: true });
    fs.writeFileSync(unexpected, 'copied helper');
    expect(() =>
      patchNodePtyDarwin({
        root: copied.root,
        packages: [spec(source, patchedSource)],
      }),
    ).toThrow(/unexpected bundled/);
  });
});

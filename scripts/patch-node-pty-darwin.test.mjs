import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EAGAIN_PACING_MARKERS,
  NODE_PTY_DARWIN_VERSION,
  SYSTEM_PERL_HELPER_SOURCE,
  UPSTREAM_HELPER_SOURCE,
  applyEagainPacing,
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

function spec(source, patchedSource, sealedSource = null) {
  return {
    name: '@fixture/node-pty-darwin-arm64',
    arch: 'arm64',
    upstreamSha256: sha256(source),
    sealedSha256: sealedSource === null ? sha256(source) : sha256(sealedSource),
    patchedSha256: sha256(patchedSource),
  };
}

const WRITE_LOOP_SHAPE = [
  'exports.UnixTerminal = UnixTerminal;',
  '/**',
  ' * docs',
  ' */',
  'var CustomWriteStream = 0;',
  '    CustomWriteStream.prototype.dispose = function () {',
  '        clearImmediate(this._writeImmediate);',
  '        this._writeImmediate = undefined;',
  '    };',
  '    CustomWriteStream.prototype.write = function (data) {',
  '        // Writes are put in a queue and processed asynchronously in order to handle',
  '        this._writeQueue.push(1);',
  '    };',
  '        this._writeImmediate = undefined;',
  '        if (this._writeQueue.length === 0) {',
  '            return;',
  '        }',
  "                    // `setImmediate` is used to yield to the event loop and re-attempt",
  '                    // the write later.',
  '                    _this._writeImmediate = setImmediate(function () { return _this._processWriteQueue(); });',
].join('\n');

function sealOnly(source) {
  return source.replace(UPSTREAM_HELPER_SOURCE, SYSTEM_PERL_HELPER_SOURCE);
}

function fullyPatched(source) {
  return applyEagainPacing(sealOnly(source));
}

describe('pinned node-pty Darwin patch', () => {
  it('replaces the exact helper path, paces the EAGAIN retry, and removes the bundled executable', () => {
    const source = [
      '"use strict";',
      UPSTREAM_HELPER_SOURCE,
      'exports.ready = true;',
      WRITE_LOOP_SHAPE,
      '',
    ].join('\n');
    const patchedSource = fullyPatched(source);
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
    const written = fs.readFileSync(tree.sourcePath, 'utf8');
    expect(written).toBe(patchedSource);
    for (const marker of EAGAIN_PACING_MARKERS) {
      expect(written).toContain(marker);
    }
    expect(written).toContain('EAGAIN_RETRY_DELAY_MS');
    expect(written).not.toContain(
      '_this._writeImmediate = setImmediate(function () { return _this._processWriteQueue(); });',
    );
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

  it('upgrades a helper-sealed copy by applying only the EAGAIN pacing', () => {
    const source = [
      '"use strict";',
      UPSTREAM_HELPER_SOURCE,
      'exports.ready = true;',
      WRITE_LOOP_SHAPE,
      '',
    ].join('\n');
    const sealedSource = sealOnly(source);
    const patchedSource = fullyPatched(source);
    const tree = fixture({ source: sealedSource });

    expect(
      patchNodePtyDarwin({
        root: tree.root,
        packages: [spec(source, patchedSource, sealedSource)],
      }),
    ).toEqual([
      {
        packageName: '@fixture/node-pty-darwin-arm64',
        installed: true,
        patched: true,
      },
    ]);
    expect(fs.readFileSync(tree.sourcePath, 'utf8')).toBe(patchedSource);
  });

  it('fails closed when the write-loop shape drifts', () => {
    const source = [
      '"use strict";',
      UPSTREAM_HELPER_SOURCE,
      'exports.ready = true;',
      WRITE_LOOP_SHAPE.replace(
        '_this._writeImmediate = setImmediate(function () { return _this._processWriteQueue(); });',
        '_this._writeImmediate = setImmediate(function () { return _this._drain(); });',
      ),
      '',
    ].join('\n');
    const drifted = fixture({ source });
    // Achado Rabbit: o spec aponta upstream==on-disk para exercitar o caminho
    // de produção (seal ok → pacing joga), não o helper do teste.
    const packageSpec = {
      name: '@fixture/node-pty-darwin-arm64',
      arch: 'arm64',
      upstreamSha256: sha256(source),
      sealedSha256: sha256(sealOnly(source)),
      patchedSha256: sha256(source),
    };
    expect(() =>
      patchNodePtyDarwin({ root: drifted.root, packages: [packageSpec] }),
    ).toThrow(/pinned upstream shape/);
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

    const fullSource = `${source}\n${WRITE_LOOP_SHAPE}\n`;
    const copied = fixture({ source: fullSource });
    const unexpected = path.join(copied.packageRoot, 'copy', 'spawn-helper');
    fs.mkdirSync(path.dirname(unexpected), { recursive: true });
    fs.writeFileSync(unexpected, 'copied helper');
    expect(() =>
      patchNodePtyDarwin({
        root: copied.root,
        packages: [spec(fullSource, fullyPatched(fullSource))],
      }),
    ).toThrow(/unexpected bundled/);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertAdvisoryConfinement,
  requiresAdvisoryProcessSandbox,
  resolveAdvisoryProcessSandbox,
} from './advisory-process-sandbox';

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-advisory-sandbox-'));
  created.push(dir);
  return fs.realpathSync.native(dir);
}

function fakeBinary(root: string, name = 'cli'): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe('requiresAdvisoryProcessSandbox', () => {
  it('claims the advisory CLIs that have no native read-only boundary', () => {
    for (const id of ['kimi', 'agy', 'opencode', 'omp', 'claude']) {
      expect(requiresAdvisoryProcessSandbox(id, true)).toBe(true);
    }
  });

  it('leaves mechanically confined CLIs to their own boundary', () => {
    // codex/grok enforce read-only in their own binary; wrapping them would
    // nest Seatbelt profiles, which macOS cannot do reliably.
    expect(requiresAdvisoryProcessSandbox('codex', true)).toBe(false);
    expect(requiresAdvisoryProcessSandbox('grok', true)).toBe(false);
  });

  it('never claims a writable lane', () => {
    expect(requiresAdvisoryProcessSandbox('kimi', false)).toBe(false);
  });
});

describe('resolveAdvisoryProcessSandbox', () => {
  it('confines the CLI to its private HOME and pins network to its binary', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const binary = fakeBinary(root);

    const sandbox = resolveAdvisoryProcessSandbox({
      adapterId: 'kimi',
      readOnlyLane: true,
      privateHome: home,
      binaryPath: binary,
    });

    expect(sandbox?.sandboxDir).toBe(home);
    expect(sandbox?.networkAllowedProcessPaths).toEqual([binary]);
  });

  it('adds a private temp only when it lives outside the private HOME', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const outsideTmp = path.join(root, 'tmp');
    fs.mkdirSync(home);
    fs.mkdirSync(outsideTmp);
    const nestedTmp = path.join(home, 'tmp');
    fs.mkdirSync(nestedTmp);
    const binary = fakeBinary(root);

    expect(
      resolveAdvisoryProcessSandbox({
        adapterId: 'omp',
        readOnlyLane: true,
        privateHome: home,
        privateTmp: outsideTmp,
        binaryPath: binary,
      })?.extraWritePaths,
    ).toEqual([outsideTmp]);

    // Already reachable through sandboxDir: granting it again would only widen
    // the profile for nothing.
    expect(
      resolveAdvisoryProcessSandbox({
        adapterId: 'omp',
        readOnlyLane: true,
        privateHome: home,
        privateTmp: nestedTmp,
        binaryPath: binary,
      })?.extraWritePaths,
    ).toEqual([]);
  });

  it('resolves nothing when the private HOME or binary is missing', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const binary = fakeBinary(root);

    expect(
      resolveAdvisoryProcessSandbox({
        adapterId: 'kimi',
        readOnlyLane: true,
        privateHome: undefined,
        binaryPath: binary,
      }),
    ).toBeNull();

    expect(
      resolveAdvisoryProcessSandbox({
        adapterId: 'kimi',
        readOnlyLane: true,
        privateHome: path.join(root, 'absent'),
        binaryPath: binary,
      }),
    ).toBeNull();

    expect(
      resolveAdvisoryProcessSandbox({
        adapterId: 'kimi',
        readOnlyLane: true,
        privateHome: home,
        binaryPath: path.join(root, 'absent-binary'),
      }),
    ).toBeNull();
  });
});

describe('assertAdvisoryConfinement', () => {
  it('refuses to spawn an advisory read-only lane without the kernel boundary', () => {
    expect(() =>
      assertAdvisoryConfinement('kimi', true, null, 'darwin'),
    ).toThrow(/no enforceable/i);
  });

  it('refuses the advisory lane where the sandbox does not exist', () => {
    const root = tempDir();
    const sandbox = {
      sandboxDir: root,
      extraWritePaths: [],
      networkAllowedProcessPaths: [fakeBinary(root)],
    };
    expect(() =>
      assertAdvisoryConfinement('kimi', true, sandbox, 'linux'),
    ).toThrow(/only available on macOS/i);
  });

  it('stays out of the way for mechanically confined and writable lanes', () => {
    expect(() =>
      assertAdvisoryConfinement('codex', true, null, 'darwin'),
    ).not.toThrow();
    expect(() =>
      assertAdvisoryConfinement('kimi', false, null, 'darwin'),
    ).not.toThrow();
  });
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  collectLinuxRelease,
  linuxPackageBasenames,
  parseCollectArgs,
} from './collect-linux-release.mjs';

const VERSION = '0.76.151';
const COMMIT = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const roots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-linux-collect-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function makeApp(root, { deb = true, rpm = true, zip = true, debName, rpmName, zipName } = {}) {
  const app = path.join(root, 'app');
  const names = linuxPackageBasenames(VERSION);
  if (deb) {
    const file = path.join(app, 'out', 'make', 'deb', 'x64', debName ?? names.deb);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'deb-payload');
  }
  if (rpm) {
    const file = path.join(app, 'out', 'make', 'rpm', 'x64', rpmName ?? names.rpm);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'rpm-payload');
  }
  if (zip) {
    const file = path.join(app, 'out', 'make', 'zip', 'linux', 'x64', zipName ?? names.zip);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'zip-payload');
  }
  return app;
}

function fakeGit() {
  const calls = [];
  return {
    calls,
    fn: (args) => {
      calls.push(args.join(' '));
      const key = args.slice(0, 2).join(' ');
      if (key === 'cat-file -t') return 'tag';
      if (args[0] === 'rev-parse' && args[1].endsWith('^{}')) return COMMIT;
      if (args[0] === 'rev-parse') return TAG_OBJECT;
      return '';
    },
  };
}

const environment = {
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'c'.repeat(40),
};

describe('collect-linux-release', () => {
  it('collects exactly one deb, rpm and portable zip and writes a v2 bound receipt', () => {
    const root = tempRoot();
    const app = makeApp(root);
    const out = path.join(root, 'linux-release-assets');
    const git = fakeGit();

    const { receipt } = collectLinuxRelease({
      app,
      version: VERSION,
      out,
      environment,
      git: git.fn,
      npmVersion: () => '12.0.0',
    });

    const names = linuxPackageBasenames(VERSION);
    expect(fs.readdirSync(out).sort()).toEqual(
      [names.deb, names.rpm, names.zip, RECEIPT_FILE].sort(),
    );
    expect(receipt.schema).toBe(RECEIPT_SCHEMA);
    expect(receipt.version).toBe(VERSION);
    expect(receipt.commit).toBe(COMMIT);
    expect(receipt.tagObject).toBe(TAG_OBJECT);
    expect(receipt.dispatchSha).toBe(environment.GITHUB_SHA);
    expect(receipt.runId).toBe(environment.GITHUB_RUN_ID);
    expect(receipt.runAttempt).toBe(environment.GITHUB_RUN_ATTEMPT);
    expect(receipt.runner).toBe('ubuntu-22.04');
    expect(receipt.arch).toBe('x64');
    expect(receipt.npm).toBe('12.0.0');
    expect(receipt.node).toBe(process.versions.node);
    expect(receipt.smoke).toEqual({ packaged: true, debInstalled: true, zipExtracted: true });
    expect(
      receipt.files
        .map((file) => file.name)
        .sort(),
    ).toEqual([names.deb, names.rpm, names.zip].sort());
    for (const file of receipt.files) {
      const bytes = fs.readFileSync(path.join(out, file.name));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(sha256(bytes));
    }
  });

  it('fails when a required payload is absent or duplicated', () => {
    const root = tempRoot();
    const app = makeApp(root);
    fs.writeFileSync(
      path.join(app, 'out', 'make', 'deb', 'x64', 'extra_1.0.0_amd64.deb'),
      'dup',
    );
    expect(() =>
      collectLinuxRelease({
        app,
        version: VERSION,
        out: path.join(root, 'out1'),
        environment,
        git: fakeGit().fn,
        npmVersion: () => '12.0.0',
      }),
    ).toThrow(/exactly one \.deb/);

    const missing = tempRoot();
    const missingApp = makeApp(missing, { rpm: false });
    expect(() =>
      collectLinuxRelease({
        app: missingApp,
        version: VERSION,
        out: path.join(missing, 'out2'),
        environment,
        git: fakeGit().fn,
        npmVersion: () => '12.0.0',
      }),
    ).toThrow(/rpm/);

    const missingZipRoot = tempRoot();
    const missingZipApp = makeApp(missingZipRoot, { zip: false });
    expect(() => collectLinuxRelease({
      app: missingZipApp, version: VERSION, out: path.join(missingZipRoot, 'out3'),
      environment, git: fakeGit().fn, npmVersion: () => '12.0.0',
    })).toThrow(/zip/);
  });

  it('rejects payloads whose names do not match the maker contract', () => {
    const root = tempRoot();
    const app = makeApp(root, { debName: 'nexus-ide_0.0.0_amd64.deb' });
    expect(() =>
      collectLinuxRelease({
        app,
        version: VERSION,
        out: path.join(root, 'out'),
        environment,
        git: fakeGit().fn,
        npmVersion: () => '12.0.0',
      }),
    ).toThrow(/unexpected deb name/);
  });

  it('requires an annotated tag object and the runner identity env', () => {
    const root = tempRoot();
    const app = makeApp(root);
    const lightweight = (args) =>
      args.slice(0, 2).join(' ') === 'cat-file -t' ? 'commit' : COMMIT;
    expect(() =>
      collectLinuxRelease({
        app,
        version: VERSION,
        out: path.join(root, 'o1'),
        environment,
        git: lightweight,
        npmVersion: () => '12.0.0',
      }),
    ).toThrow(/annotated/);

    expect(() =>
      collectLinuxRelease({
        app,
        version: VERSION,
        out: path.join(root, 'o2'),
        environment: { ...environment, GITHUB_RUN_ID: '' },
        git: fakeGit().fn,
        npmVersion: () => '12.0.0',
      }),
    ).toThrow(/GITHUB_RUN_ID/);
  });

  it('parses the required --app/--version/--out arguments', () => {
    expect(
      parseCollectArgs(['--app', 'a', '--version', '1.2.3', '--out', 'o']),
    ).toEqual({ app: 'a', version: '1.2.3', out: 'o' });
    expect(() => parseCollectArgs(['--app', 'a'])).toThrow(/usage/);
    expect(() => parseCollectArgs(['--bogus', 'x'])).toThrow(/usage/);
  });

  it('encodes the exact maker file names for any stable version', () => {
    expect(linuxPackageBasenames('1.2.3')).toEqual({
      deb: 'nexus-ide_1.2.3_amd64.deb',
      rpm: 'nexus-ide-1.2.3-1.x86_64.rpm',
      zip: 'NexusIDE-linux-x64-1.2.3.zip',
    });
    expect(() => linuxPackageBasenames('1.2.3-rc1')).toThrow(/stable/);
  });
});

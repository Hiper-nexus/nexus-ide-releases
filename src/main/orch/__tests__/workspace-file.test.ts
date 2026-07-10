import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openWorkspaceFileForRead,
  removeWorkspaceFile,
  replaceWorkspaceTextFileAtomically,
  writeWorkspaceTextFile,
} from '../workspace-file';
import { testProjectScope } from './scope-fixture';

const testDir = path.join(os.tmpdir(), 'nexus-workspace-file-security');
const wsDir = path.join(testDir, 'workspace');

function scope() {
  return testProjectScope({ rootRealPath: fs.realpathSync(wsDir) });
}

describe('workspace-file descriptor hardening', () => {
  beforeAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects a regular-file rename swap between validation and descriptor open', () => {
    const realWorkspace = fs.realpathSync(wsDir);
    const victim = path.join(realWorkspace, 'rename-victim.txt');
    const displaced = path.join(realWorkspace, 'rename-victim.displaced');
    const replacement = path.join(realWorkspace, 'rename-replacement.txt');
    fs.writeFileSync(victim, 'intended-file');
    fs.writeFileSync(replacement, 'replacement-file');
    const realOpen = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      if (!swapped && path.resolve(String(target)) === victim) {
        swapped = true;
        fs.renameSync(victim, displaced);
        fs.renameSync(replacement, victim);
      }
      return realOpen(target, flags, mode);
    });

    expect(() =>
      writeWorkspaceTextFile(scope(), 'rename-victim.txt', 'must-not-land'),
    ).toThrow(/changed while it was being opened/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('replacement-file');
    expect(fs.readFileSync(displaced, 'utf8')).toBe('intended-file');
  });

  it('rejects a symlink introduced immediately before exclusive creation', () => {
    const target = path.join(fs.realpathSync(wsDir), 'create-race.txt');
    const outside = path.join(testDir, 'create-race-outside.txt');
    fs.rmSync(target, { force: true });
    fs.writeFileSync(outside, 'outside-original');
    const realOpen = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (!swapped && path.resolve(String(file)) === target) {
        swapped = true;
        fs.symlinkSync(outside, target, 'file');
      }
      return realOpen(file, flags, mode);
    });

    expect(() =>
      writeWorkspaceTextFile(scope(), 'create-race.txt', 'must-not-land'),
    ).toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-original');
  });

  it('revalidates the descriptor before truncation when the path is renamed', () => {
    const realWorkspace = fs.realpathSync(wsDir);
    const victim = path.join(realWorkspace, 'post-open-victim.txt');
    const displaced = path.join(realWorkspace, 'post-open-victim.displaced');
    const outside = path.join(testDir, 'post-open-outside.txt');
    fs.writeFileSync(victim, 'intended-file');
    fs.writeFileSync(outside, 'outside-original');
    const realFstat = fs.fstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
      calls += 1;
      if (calls === 2) {
        fs.renameSync(victim, displaced);
        fs.symlinkSync(outside, victim, 'file');
      }
      return realFstat(fd, options);
    });

    expect(() =>
      writeWorkspaceTextFile(scope(), 'post-open-victim.txt', 'must-not-land'),
    ).toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-original');
    expect(fs.readFileSync(displaced, 'utf8')).toBe('intended-file');
  });

  it('keeps reads bound to the validated descriptor after a path rename', () => {
    const realWorkspace = fs.realpathSync(wsDir);
    const victim = path.join(realWorkspace, 'read-bound.txt');
    const displaced = path.join(realWorkspace, 'read-bound.displaced');
    const outside = path.join(testDir, 'read-bound-outside.txt');
    fs.writeFileSync(victim, 'validated-content');
    fs.writeFileSync(outside, 'outside-secret');
    const handle = openWorkspaceFileForRead(scope(), 'read-bound.txt');
    try {
      fs.renameSync(victim, displaced);
      fs.symlinkSync(outside, victim, 'file');
      expect(fs.readFileSync(handle.fd, 'utf8')).toBe('validated-content');
    } finally {
      handle.close();
    }
  });

  it('rejects directories as non-regular read targets', () => {
    expect(() => openWorkspaceFileForRead(scope(), '.')).toThrow(/regular file/i);
  });

  it('atomically replaces authority text and removes it only with the expected bytes', () => {
    const target = path.join(fs.realpathSync(wsDir), 'authority.md');
    fs.writeFileSync(target, 'old-authority');

    const replaced = replaceWorkspaceTextFileAtomically(
      scope(),
      'authority.md',
      'new-authority',
    );
    expect(replaced).toEqual({ existed: true, written: 13 });
    expect(fs.readFileSync(target, 'utf8')).toBe('new-authority');
    expect(fs.readdirSync(wsDir).filter((name) => name.includes('.nexus-tmp-'))).toEqual([]);

    expect(() => removeWorkspaceFile(scope(), 'authority.md', {
      expectedSha256: '0'.repeat(64),
    })).toThrow(/hash/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('new-authority');
    expect(removeWorkspaceFile(scope(), 'authority.md')).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(removeWorkspaceFile(scope(), 'authority.md', { missingOk: true })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO before read or mutation so a special file cannot block the process',
    () => {
      const fifo = path.join(wsDir, 'blocking.fifo');
      fs.rmSync(fifo, { force: true });
      execFileSync('mkfifo', [fifo]);

      expect(() => openWorkspaceFileForRead(scope(), 'blocking.fifo')).toThrow(
        /regular file/i,
      );
      expect(() =>
        writeWorkspaceTextFile(scope(), 'blocking.fifo', 'must-not-block'),
      ).toThrow(/regular file/i);
    },
  );
});

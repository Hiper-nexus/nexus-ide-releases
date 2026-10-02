import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REDLINE_LINUX_SETTINGS_FILE,
  readRedlineLinuxEnabled,
  writeRedlineLinuxEnabled,
} from './redline-linux-settings';

describe('redline linux settings (opt-in, default OFF)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'redline-linux-settings-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const file = () => path.join(dir, REDLINE_LINUX_SETTINGS_FILE);

  it('is OFF when nothing was ever saved', () => {
    expect(readRedlineLinuxEnabled(dir)).toBe(false);
  });

  it('is OFF when the directory does not exist', () => {
    expect(readRedlineLinuxEnabled(path.join(dir, 'nope', 'deeper'))).toBe(false);
  });

  it('persists ON and reads it back', () => {
    writeRedlineLinuxEnabled(dir, true);
    expect(readRedlineLinuxEnabled(dir)).toBe(true);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ enabled: true });
  });

  it('persists OFF after ON', () => {
    writeRedlineLinuxEnabled(dir, true);
    writeRedlineLinuxEnabled(dir, false);
    expect(readRedlineLinuxEnabled(dir)).toBe(false);
  });

  it('creates the directory when it is missing', () => {
    const nested = path.join(dir, 'a', 'b');
    writeRedlineLinuxEnabled(nested, true);
    expect(readRedlineLinuxEnabled(nested)).toBe(true);
  });

  // O Windows não tem bits de modo POSIX (statSync devolve 0o666/0o444).
  it.skipIf(process.platform === 'win32')('writes the file private to the user (0600)', () => {
    writeRedlineLinuxEnabled(dir, true);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['garbage', 'not json'],
    ['empty', ''],
    ['array', '[true]'],
    ['null', 'null'],
    ['string flag', '{"enabled":"true"}'],
    ['number flag', '{"enabled":1}'],
    ['wrong key', '{"on":true}'],
  ])('a %s file reads as OFF (strict boolean only)', (_name, body) => {
    writeFileSync(file(), body);
    expect(readRedlineLinuxEnabled(dir)).toBe(false);
  });

  it('an oversized file reads as OFF without being parsed', () => {
    writeFileSync(file(), `{"enabled":true,"pad":"${'x'.repeat(100_000)}"}`);
    expect(readRedlineLinuxEnabled(dir)).toBe(false);
  });

  it('a directory squatting on the file name reads as OFF instead of throwing', () => {
    mkdirSync(file());
    expect(readRedlineLinuxEnabled(dir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a FIFO squatting on the file name never hangs the boot', () => {
    execFileSync('mkfifo', [file()]);
    expect(readRedlineLinuxEnabled(dir)).toBe(false);
  });

  it('write failures surface to the caller (so the UI can say it did not save)', () => {
    // Um arquivo no lugar do diretório de userData impede o mkdir/rename.
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(() => writeRedlineLinuxEnabled(path.join(blocker, 'sub'), true)).toThrow();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFileAtomic } from './atomic-json-file';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-settings-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'nested', 'settings.json');
}

describe('writeJsonFileAtomic', () => {
  it('writes complete JSON and leaves no temporary payload behind', () => {
    const filePath = temporaryFile();

    writeJsonFileAtomic(filePath, { provider: 'gemini-live', enabled: true });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      provider: 'gemini-live',
      enabled: true,
    });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['settings.json']);
  });

  it('keeps the previous destination intact when atomic replacement fails', () => {
    const filePath = temporaryFile();
    writeJsonFileAtomic(filePath, { provider: 'openai' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    expect(() => writeJsonFileAtomic(filePath, { provider: 'gemini-live' })).toThrow(
      'disk unavailable',
    );
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      provider: 'openai',
    });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['settings.json']);
  });

  it('preserves the exact bytes the pre-delegation implementation wrote', () => {
    // writeJsonFileAtomic is now a shim over util/atomic-write, whose own
    // writeJsonAtomic omits the trailing newline. The shim keeps it, so an
    // existing settings.json on disk is byte-identical after the change.
    const filePath = temporaryFile();

    writeJsonFileAtomic(filePath, { provider: 'openai' });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(
      `${JSON.stringify({ provider: 'openai' }, null, 2)}\n`,
    );
  });
});

// Mode bits are not meaningful on Windows, so the permission guarantees the
// shim inherits from util/atomic-write are asserted on POSIX only.
describe.skipIf(process.platform === 'win32')(
  'writeJsonFileAtomic permission guarantees inherited from util/atomic-write',
  () => {
    it('creates the file 0o600', () => {
      const filePath = temporaryFile();

      writeJsonFileAtomic(filePath, { provider: 'openai' });

      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it('creates a missing parent directory 0o700', () => {
      // The pre-delegation implementation called mkdirSync with no mode, so a
      // freshly created ~/.nexus depended on the process umask. This is the
      // guarantee the delegation adds.
      const filePath = temporaryFile();
      const created = path.dirname(filePath);
      expect(fs.existsSync(created)).toBe(false);

      writeJsonFileAtomic(filePath, { provider: 'openai' });

      expect(fs.statSync(created).mode & 0o777).toBe(0o700);
    });

    it('leaves a pre-existing parent directory mode alone', () => {
      // Documents actual behaviour rather than asserting a wish: mkdirSync with
      // recursive:true does not chmod a directory that already exists, so a
      // pre-existing 0o755 parent stays 0o755. secrets-store.ts chmods
      // explicitly where that matters; this writer does not.
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-settings-wide-'));
      temporaryDirectories.push(directory);
      fs.chmodSync(directory, 0o755);
      const filePath = path.join(directory, 'settings.json');

      writeJsonFileAtomic(filePath, { provider: 'openai' });

      expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    });
  },
);


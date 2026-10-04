import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  writeFileAtomic,
  writeFileAtomicAsync,
  writeJsonAtomic,
  writeTimestampedBackup,
} from './atomic-write';

// This module is the canonical crash-safe writer for eight callers, including
// remote-device-token-store.ts (remote pairing tokens) and remote-bridge.ts.
// It had no test sibling, which AGENTS.md requires and which matters more here
// than elsewhere: its guarantees are about failure modes, so reading the code
// is not evidence they hold.

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-atomic-write-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A destination inside a parent directory that does not exist yet. */
function nestedFile(): string {
  return path.join(temporaryDirectory(), 'nested', 'tokens.json');
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe('writeFileAtomic', () => {
  it('publishes the payload and leaves no temporary file behind', () => {
    const file = nestedFile();

    writeFileAtomic(file, 'payload');

    expect(fs.readFileSync(file, 'utf8')).toBe('payload');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tokens.json']);
  });

  it('creates a missing parent directory', () => {
    const file = nestedFile();
    expect(fs.existsSync(path.dirname(file))).toBe(false);

    writeFileAtomic(file, 'payload');

    expect(fs.readFileSync(file, 'utf8')).toBe('payload');
  });

  it('keeps the previous destination intact and reports the original error when rename fails', () => {
    const file = path.join(temporaryDirectory(), 'tokens.json');
    writeFileAtomic(file, 'first');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    expect(() => writeFileAtomic(file, 'second')).toThrow('disk unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    // The temp file is unlinked on the failure path, not left beside the target.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tokens.json']);
  });

  it('writes binary payloads byte-for-byte', () => {
    const file = path.join(temporaryDirectory(), 'blob.bin');
    const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x80]);

    writeFileAtomic(file, bytes);

    expect(fs.readFileSync(file)).toEqual(Buffer.from(bytes));
  });

  it('replaces a symlink at the destination instead of writing through it', () => {
    // rename(2) swaps the directory entry, so a pre-planted symlink at the
    // destination is replaced by a regular file rather than followed. Without
    // that, an attacker who can create the destination path could redirect a
    // token write into a file the user owns elsewhere.
    const directory = temporaryDirectory();
    const victim = path.join(directory, 'victim.txt');
    fs.writeFileSync(victim, 'untouched', 'utf8');
    const link = path.join(directory, 'tokens.json');
    fs.symlinkSync(victim, link);

    writeFileAtomic(link, 'payload');

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('payload');
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
  });
});

describe.skipIf(process.platform === 'win32')('writeFileAtomic permissions', () => {
  it('creates the file 0o600 by default', () => {
    const file = path.join(temporaryDirectory(), 'tokens.json');

    writeFileAtomic(file, '{"token":"secret"}');

    expect(modeOf(file)).toBe(0o600);
  });

  it('honours an explicit mode', () => {
    const file = path.join(temporaryDirectory(), 'shared.json');

    writeFileAtomic(file, 'payload', 0o640);

    expect(modeOf(file)).toBe(0o640);
  });

  it('creates a missing parent directory 0o700', () => {
    const file = nestedFile();

    writeFileAtomic(file, 'payload');

    expect(modeOf(path.dirname(file))).toBe(0o700);
  });

  it('leaves a pre-existing parent directory mode alone', () => {
    // mkdirSync recursive does not chmod an existing directory. Documented
    // rather than asserted as a wish: secrets-store.ts chmods explicitly where
    // the directory mode is load-bearing, this writer does not.
    const directory = temporaryDirectory();
    fs.chmodSync(directory, 0o755);

    writeFileAtomic(path.join(directory, 'tokens.json'), 'payload');

    expect(modeOf(directory)).toBe(0o755);
  });

  it('re-tightens a destination that was left world-readable', () => {
    // fchmodSync on the descriptor means the published file carries the
    // requested mode even if a previous writer or a umask left it wider.
    const file = path.join(temporaryDirectory(), 'tokens.json');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(modeOf(file)).toBe(0o644);

    writeFileAtomic(file, 'new');

    expect(modeOf(file)).toBe(0o600);
  });
});

describe('writeFileAtomicAsync (F-764: fora do event loop do Main)', () => {
  it('rejects a revoked deferred commit after flushing and retains the original bytes', async () => {
    const file = path.join(temporaryDirectory(), 'tokens.json');
    await writeFileAtomicAsync(file, 'original');
    await expect(writeFileAtomicAsync(file, 'obsolete', 0o600, { createDirectory: false,
      beforeCommit: () => { throw new Error('reservation revoked'); } })).rejects.toThrow('reservation revoked');
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tokens.json']);
  });
  it('does not recreate a retired private directory when creation is forbidden', async () => {
    const parent = path.join(temporaryDirectory(), 'retired'), file = path.join(parent, 'config.toml');
    await expect(writeFileAtomicAsync(file, 'obsolete', 0o600, { createDirectory: false })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(parent)).toBe(false);
  });
  it('publishes the payload in a new parent and leaves no temporary file behind', async () => {
    const file = nestedFile();

    await writeFileAtomicAsync(file, 'payload');

    expect(fs.readFileSync(file, 'utf8')).toBe('payload');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tokens.json']);
    if (process.platform !== 'win32') {
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(path.dirname(file))).toBe(0o700);
    }
  });

  it('keeps the previous destination intact and unlinks the temp when rename fails', async () => {
    const file = path.join(temporaryDirectory(), 'tokens.json');
    await writeFileAtomicAsync(file, 'first');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      new Error('disk unavailable'),
    );

    await expect(writeFileAtomicAsync(file, 'second')).rejects.toThrow(
      'disk unavailable',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tokens.json']);
  });

  it('replaces a symlink at the destination instead of writing through it', async () => {
    const directory = temporaryDirectory();
    const victim = path.join(directory, 'victim.txt');
    fs.writeFileSync(victim, 'untouched', 'utf8');
    const link = path.join(directory, 'tokens.json');
    fs.symlinkSync(victim, link);

    await writeFileAtomicAsync(link, 'payload');

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('payload');
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('never touches the blocking fs API', async () => {
    const blocking = [
      vi.spyOn(fs, 'mkdirSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'fsyncSync'),
      vi.spyOn(fs, 'renameSync'),
    ];

    await writeFileAtomicAsync(nestedFile(), 'payload');

    for (const spy of blocking) expect(spy).not.toHaveBeenCalled();
  });
});

describe('writeJsonAtomic', () => {
  it('omits the trailing newline the persistence shim adds', () => {
    // Pinned because persistence/atomic-json-file.ts delegates here and keeps
    // its own trailing newline for byte-compatibility with settings.json files
    // already on disk. If this ever starts emitting a newline, that shim's
    // guarantee silently changes meaning.
    const file = path.join(temporaryDirectory(), 'tokens.json');

    writeJsonAtomic(file, { tokens: [] });

    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ tokens: [] }, null, 2));
  });

  it('round-trips through JSON.parse', () => {
    const file = path.join(temporaryDirectory(), 'tokens.json');
    const value = { tokens: [{ id: 'dev-1', scope: 'operator' }] };

    writeJsonAtomic(file, value);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(value);
  });
});

describe('writeTimestampedBackup', () => {
  it('returns a readable sibling and leaves the original untouched', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'tokens.json');
    writeFileAtomic(file, 'current');

    const backup = writeTimestampedBackup(file, 'snapshot');

    expect(fs.readFileSync(backup, 'utf8')).toBe('snapshot');
    expect(fs.readFileSync(file, 'utf8')).toBe('current');
    expect(path.dirname(backup)).toBe(directory);
    expect(backup).not.toBe(file);
  });

  it('gives each call a distinct name so two backups never collide', () => {
    const file = path.join(temporaryDirectory(), 'tokens.json');

    const first = writeTimestampedBackup(file, 'one');
    const second = writeTimestampedBackup(file, 'two');

    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, 'utf8')).toBe('one');
    expect(fs.readFileSync(second, 'utf8')).toBe('two');
  });

  it.skipIf(process.platform === 'win32')('creates the backup 0o600', () => {
    const backup = writeTimestampedBackup(
      path.join(temporaryDirectory(), 'tokens.json'),
      'snapshot',
    );

    expect(modeOf(backup)).toBe(0o600);
  });
});

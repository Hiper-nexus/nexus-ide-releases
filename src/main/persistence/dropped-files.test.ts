import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DROPPED_ATTACHMENT_MAX_BYTES,
  droppedFileName,
  saveDroppedFile,
  snapshotDroppedAttachmentPaths,
  validateDroppedAttachmentPaths,
} from './dropped-files';

let tempRoot = '';
let homeDir = '';

function droppedDir(): string {
  return path.join(homeDir, '.nexus', 'dropped');
}

function regularFile(name: string, size: number): string {
  fs.mkdirSync(droppedDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(droppedDir(), 0o700);
  const file = path.join(droppedDir(), name);
  fs.writeFileSync(file, '');
  fs.truncateSync(file, size);
  fs.chmodSync(file, 0o600);
  return file;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dropped-test-'));
  homeDir = path.join(tempRoot, 'home');
  fs.mkdirSync(homeDir, { mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('secure dropped-file staging', () => {
  it('creates a private directory and an exclusive regular file', () => {
    const result = saveDroppedFile(
      'print erro.png',
      Buffer.from('evidência').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    expect(result).toMatchObject({ ok: true });
    const file = result.ok ? result.path : '';
    expect(fs.readFileSync(file, 'utf8')).toBe('evidência');
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.statSync(droppedDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not follow or replace a pre-existing symlink', () => {
    fs.mkdirSync(droppedDir(), { recursive: true, mode: 0o700 });
    const outside = path.join(tempRoot, 'outside.txt');
    fs.writeFileSync(outside, 'não tocar');
    const candidate = path.join(
      droppedDir(),
      droppedFileName('attack.txt', 'fixed-token'),
    );
    fs.symlinkSync(outside, candidate);

    const result = saveDroppedFile(
      'attack.txt',
      Buffer.from('forjado').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('não tocar');
    expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
  });

  it('does not create the dropped directory through a symlinked ~/.nexus', () => {
    const outside = path.join(tempRoot, 'outside-nexus');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(homeDir, '.nexus'));

    const result = saveDroppedFile(
      'attack.txt',
      Buffer.from('forjado').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'dropped'))).toBe(false);
  });

  it('rejects a decoded item above 14 MiB before creating a file', () => {
    const oversized = Buffer.alloc(DROPPED_ATTACHMENT_MAX_BYTES + 1, 1);
    const result = saveDroppedFile('large.bin', oversized.toString('base64'), {
      homeDir,
      token: () => 'oversized',
    });

    expect(result).toMatchObject({ ok: false });
    expect(fs.existsSync(droppedDir())).toBe(false);
  });
});

describe('durable mission attachment validation', () => {
  it('returns canonical regular files and accepts an absent list unchanged', () => {
    expect(
      validateDroppedAttachmentPaths(undefined, { homeDir }),
    ).toBeUndefined();
    const file = regularFile('proof.txt', 128);
    expect(validateDroppedAttachmentPaths([file], { homeDir })).toEqual([
      fs.realpathSync(file),
    ]);
  });

  it('snapshots the exact bytes, path and size for approval fences', () => {
    const file = regularFile('digest.txt', 0);
    fs.writeFileSync(file, 'conteúdo aprovado');
    const snapshots = snapshotDroppedAttachmentPaths([file], { homeDir });

    expect(snapshots).toEqual([
      {
        path: fs.realpathSync(file),
        sha256: createHash('sha256').update('conteúdo aprovado').digest('hex'),
        size: Buffer.byteLength('conteúdo aprovado'),
      },
    ]);
  });

  it.each([
    ['outside dropped', (_file: string) => {
      const outside = path.join(tempRoot, 'outside.txt');
      fs.writeFileSync(outside, 'outside');
      return outside;
    }],
    ['symlink', (file: string) => {
      const link = path.join(droppedDir(), 'proof-link.txt');
      fs.symlinkSync(file, link);
      return link;
    }],
    ['non-regular', () => {
      const dir = path.join(droppedDir(), 'nested-dir');
      fs.mkdirSync(dir);
      return dir;
    }],
  ])('rejects %s attachment paths', (_label, candidate) => {
    const file = regularFile('proof.txt', 128);
    expect(() =>
      validateDroppedAttachmentPaths([candidate(file)], { homeDir }),
    ).toThrow();
  });

  it('rejects an item above 14 MiB and an aggregate above 40 MiB', () => {
    const tooLarge = regularFile(
      'too-large.bin',
      DROPPED_ATTACHMENT_MAX_BYTES + 1,
    );
    expect(() =>
      validateDroppedAttachmentPaths([tooLarge], { homeDir }),
    ).toThrow(/14 MiB/i);

    const files = [1, 2, 3].map((index) =>
      regularFile(`aggregate-${index}.bin`, DROPPED_ATTACHMENT_MAX_BYTES),
    );
    expect(() =>
      validateDroppedAttachmentPaths(files, { homeDir }),
    ).toThrow(/40 MiB/i);
  });

  it('rejects more than six attachment entries before reading them', () => {
    expect(() =>
      validateDroppedAttachmentPaths(
        Array.from({ length: 7 }, (_, index) => `/missing/${index}`),
        { homeDir },
      ),
    ).toThrow(/6-file/i);
  });

  it('rejects hard-linked and control-character paths', () => {
    const file = regularFile('proof.txt', 128);
    const alias = path.join(droppedDir(), 'proof-alias.txt');
    fs.linkSync(file, alias);
    expect(() =>
      validateDroppedAttachmentPaths([file], { homeDir }),
    ).toThrow(/link/i);

    const controlPath = regularFile('line\nbreak.txt', 128);
    expect(() =>
      validateDroppedAttachmentPaths([controlPath], { homeDir }),
    ).toThrow(/path is invalid/i);
  });

  it('rejects a regular file owned by a different POSIX uid', () => {
    if (typeof process.getuid !== 'function') return;
    const currentUid = process.getuid();
    const file = regularFile('owner.txt', 128);
    expect(() =>
      validateDroppedAttachmentPaths([file], {
        homeDir,
        expectedUid: currentUid + 1,
      }),
    ).toThrow(/owner|uid/i);
  });
});

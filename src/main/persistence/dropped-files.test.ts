import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROPPED_ATTACHMENT_MAX_BYTES,
  droppedFileName,
  saveDroppedFile,
  releaseSealedAttachmentSnapshots,
  revalidateSealedAttachmentSnapshots,
  snapshotGovernedAttachmentPaths,
  sealGovernedAttachmentPath,
  snapshotDroppedAttachmentPaths,
  sweepSealedAttachmentOrphans,
  validateDroppedAttachmentPaths,
  workspaceRootAuthorityFromScope,
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

function workspaceAuthority(workspace: string) {
  const rootRealPath = fs.realpathSync(workspace);
  const stat = fs.lstatSync(rootRealPath, { bigint: true });
  return workspaceRootAuthorityFromScope({
    rootRealPath,
    workspaceRootDevice: stat.dev.toString(),
    workspaceRootInode: stat.ino.toString(),
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dropped-test-'));
  homeDir = path.join(tempRoot, 'home');
  fs.mkdirSync(homeDir, { mode: 0o700 });
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('governed workspace attachment validation', () => {
  it('accepts a platform-canonicalized workspace ancestor', () => {
    const workspace = path.join(tempRoot, 'workspace');
    const rootDir = path.join(workspace, '.nexus', 'attachments');
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const file = path.join(rootDir, 'reference.png');
    const contents = Buffer.from('approved pet reference');
    fs.writeFileSync(file, contents);

    expect(
      snapshotGovernedAttachmentPaths([file], {
        workspaceRootAuthority: workspaceAuthority(workspace),
        rootLabel: 'workspace .nexus/attachments',
      }),
    ).toEqual([
      {
        path: fs.realpathSync(file),
        sha256: createHash('sha256').update(contents).digest('hex'),
        size: contents.length,
      },
    ]);
  });

  it.each(['.nexus', 'attachments'] as const)(
    'rejects a direct %s governed-directory symlink',
    (linkedComponent) => {
      const workspace = path.join(tempRoot, 'workspace');
      const nexusDir = path.join(workspace, '.nexus');
      const rootDir = path.join(nexusDir, 'attachments');
      const externalNexus = path.join(tempRoot, 'external-nexus');
      const externalRoot = path.join(externalNexus, 'attachments');
      fs.mkdirSync(workspace, { mode: 0o700 });
      fs.mkdirSync(externalRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(externalRoot, 'reference.png'), 'approved');

      if (linkedComponent === '.nexus') {
        fs.symlinkSync(externalNexus, nexusDir, 'dir');
      } else {
        fs.mkdirSync(nexusDir, { mode: 0o700 });
        fs.symlinkSync(externalRoot, rootDir, 'dir');
      }

      expect(() =>
        snapshotGovernedAttachmentPaths(
          [path.join(rootDir, 'reference.png')],
          {
            workspaceRootAuthority: workspaceAuthority(workspace),
            rootLabel: 'workspace .nexus/attachments',
          },
        ),
      ).toThrow(/real directory|symlink/i);
    },
  );

  it('rejects substituting the authorized workspace path with a symlink', () => {
    const workspace = path.join(tempRoot, 'workspace');
    const rootDir = path.join(workspace, '.nexus', 'attachments');
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const authority = workspaceAuthority(workspace);
    const moved = path.join(tempRoot, 'moved-workspace');
    fs.renameSync(workspace, moved);
    fs.symlinkSync(moved, workspace, 'dir');

    expect(() =>
      snapshotGovernedAttachmentPaths(
        [path.join(workspace, '.nexus', 'attachments', 'reference.png')],
        { workspaceRootAuthority: authority },
      ),
    ).toThrow(/workspace|real directory|authority|changed/i);
  });
});

describe('sealed mission attachment lifecycle', () => {
  function fixture() {
    const workspace = path.join(tempRoot, 'workspace-seal');
    const sourceRoot = path.join(workspace, '.nexus', 'attachments');
    fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(sourceRoot, 'reference.png');
    const bytes = Buffer.from('already-open-reviewed-pet-bytes');
    fs.writeFileSync(sourcePath, bytes);
    const authority = workspaceAuthority(workspace);
    const options = {
      workspaceRootAuthority: authority,
      checkoutId: 'checkout-test',
      homeDir,
      sealId: () => '0123456789abcdef0123456789abcdef',
    };
    return { workspace, sourcePath, bytes, authority, options };
  }

  it('seals the exact reviewed fd bytes into a private immutable artifact', () => {
    const { workspace, sourcePath, bytes, options } = fixture();
    const copy = vi
      .spyOn(fs, 'copyFileSync')
      .mockImplementation(() => {
        throw new Error('source pathname copy is forbidden');
      });

    const sealed = sealGovernedAttachmentPath(sourcePath, options);

    expect(copy).not.toHaveBeenCalled();
    expect(sealed.sourcePath).toBe(fs.realpathSync(sourcePath));
    expect(sealed.path).not.toBe(sealed.sourcePath);
    expect(sealed.path.startsWith(`${workspace}${path.sep}`)).toBe(false);
    expect(fs.readFileSync(sealed.path)).toEqual(bytes);
    expect(sealed.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(sealed.size).toBe(bytes.length);
    expect(sealed.sealId).toBe('0123456789abcdef0123456789abcdef');
    expect(sealed.device).toMatch(/^[0-9]+$/);
    expect(sealed.inode).toMatch(/^[0-9]+$/);
    expect(fs.lstatSync(sealed.path).mode & 0o777).toBe(0o400);
    expect(fs.lstatSync(sealed.path).nlink).toBe(1);
  });

  it('keeps execution bytes independent from source mutation after sealing', () => {
    const { sourcePath, bytes, authority, options } = fixture();
    const sealed = sealGovernedAttachmentPath(sourcePath, options);
    fs.writeFileSync(sourcePath, 'renderer-mutated-source-after-review');

    expect(
      revalidateSealedAttachmentSnapshots([sealed], {
        workspaceRootAuthority: authority,
        checkoutId: options.checkoutId,
        homeDir,
      }),
    ).toEqual([sealed]);
    expect(fs.readFileSync(sealed.path)).toEqual(bytes);
  });

  it('fails closed on sealed inode replacement and same-inode hash drift', () => {
    const first = fixture();
    const replaced = sealGovernedAttachmentPath(
      first.sourcePath,
      first.options,
    );
    fs.unlinkSync(replaced.path);
    fs.writeFileSync(replaced.path, first.bytes, { mode: 0o400 });
    expect(() =>
      revalidateSealedAttachmentSnapshots([replaced], {
        workspaceRootAuthority: first.authority,
        checkoutId: first.options.checkoutId,
        homeDir,
      }),
    ).toThrow(/identity|changed|sealed/i);

    const second = fixture();
    const drifted = sealGovernedAttachmentPath(second.sourcePath, {
      ...second.options,
      sealId: () => 'fedcba9876543210fedcba9876543210',
    });
    fs.chmodSync(drifted.path, 0o600);
    fs.writeFileSync(drifted.path, Buffer.alloc(drifted.size, 0x78));
    fs.chmodSync(drifted.path, 0o400);
    expect(() =>
      revalidateSealedAttachmentSnapshots([drifted], {
        workspaceRootAuthority: second.authority,
        checkoutId: second.options.checkoutId,
        homeDir,
      }),
    ).toThrow(/hash|changed|sealed/i);
  });

  it('releases only the exact sealed identity after lifecycle teardown', () => {
    const { sourcePath, options } = fixture();
    const sealed = sealGovernedAttachmentPath(sourcePath, options);

    expect(
      releaseSealedAttachmentSnapshots([sealed], {
        checkoutId: options.checkoutId,
        homeDir,
      }),
    ).toBe(1);
    expect(fs.existsSync(sealed.path)).toBe(false);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(
      releaseSealedAttachmentSnapshots([sealed], {
        checkoutId: options.checkoutId,
        homeDir,
      }),
    ).toBe(0);
  });

  it('never deletes a replacement occupying a retired seal pathname', () => {
    const { sourcePath, bytes, options } = fixture();
    const sealed = sealGovernedAttachmentPath(sourcePath, options);
    fs.unlinkSync(sealed.path);
    fs.writeFileSync(sealed.path, bytes, { mode: 0o400 });

    expect(
      releaseSealedAttachmentSnapshots([sealed], {
        checkoutId: options.checkoutId,
        homeDir,
      }),
    ).toBe(0);
    expect(fs.existsSync(sealed.path)).toBe(true);
  });

  it('sweeps only aged checkout-local artifacts absent from live mission references', () => {
    const first = fixture();
    const live = sealGovernedAttachmentPath(first.sourcePath, first.options);
    const orphan = sealGovernedAttachmentPath(first.sourcePath, {
      ...first.options,
      sealId: () => 'fedcba9876543210fedcba9876543210',
    });
    const old = new Date(1_000);
    fs.utimesSync(live.path, old, old);
    fs.utimesSync(orphan.path, old, old);

    expect(
      sweepSealedAttachmentOrphans({
        checkoutId: first.options.checkoutId,
        homeDir,
        liveSnapshots: [live],
        now: 10_000,
        minimumAgeMs: 1_000,
      }),
    ).toBe(1);
    expect(fs.existsSync(live.path)).toBe(true);
    expect(fs.existsSync(orphan.path)).toBe(false);
  });

});
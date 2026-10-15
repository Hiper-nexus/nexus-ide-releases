import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROPPED_ATTACHMENT_MAX_BYTES,
  droppedFileName,
  importWorkspaceMissionAttachment,
  importWorkspaceMissionAttachmentFromFile,
  MISSION_CONTEXT_ATTACHMENT_PREFIX,
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
  it('creates a private directory and an exclusive regular file', async () => {
    const result = await saveDroppedFile(
      'print erro.png',
      Buffer.from('evidência').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    expect(result).toMatchObject({ ok: true });
    const file = result.ok ? result.path : '';
    expect(fs.readFileSync(file, 'utf8')).toBe('evidência');
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    // Windows não tem modo POSIX: diretório/arquivo reportam 0o666.
    const dirMode = process.platform === 'win32' ? 0o666 : 0o700;
    const fileMode = process.platform === 'win32' ? 0o666 : 0o600;
    expect(fs.statSync(droppedDir()).mode & 0o777).toBe(dirMode);
    expect(fs.statSync(file).mode & 0o777).toBe(fileMode);
  });

  it('does not follow or replace a pre-existing symlink', async () => {
    fs.mkdirSync(droppedDir(), { recursive: true, mode: 0o700 });
    const outside = path.join(tempRoot, 'outside.txt');
    fs.writeFileSync(outside, 'não tocar');
    const candidate = path.join(
      droppedDir(),
      droppedFileName('attack.txt', 'fixed-token'),
    );
    fs.symlinkSync(outside, candidate);

    const result = await saveDroppedFile(
      'attack.txt',
      Buffer.from('forjado').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('não tocar');
    expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
  });

  it('does not create the dropped directory through a symlinked ~/.nexus', async () => {
    const outside = path.join(tempRoot, 'outside-nexus');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(homeDir, '.nexus'));

    const result = await saveDroppedFile(
      'attack.txt',
      Buffer.from('forjado').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'dropped'))).toBe(false);
  });

  it('rejects a decoded item above 14 MiB before creating a file', async () => {
    const oversized = Buffer.alloc(DROPPED_ATTACHMENT_MAX_BYTES + 1, 1);
    const result = await saveDroppedFile('large.bin', oversized.toString('base64'), {
      homeDir,
      token: () => 'oversized',
    });

    expect(result).toMatchObject({ ok: false });
    expect(fs.existsSync(droppedDir())).toBe(false);
  });
});

describe('workspace mission-context import', () => {
  function workspace(): string {
    const root = path.join(tempRoot, 'project');
    fs.mkdirSync(root, { mode: 0o755 });
    return fs.realpathSync(root);
  }

  it('copies bytes into a root-relative .nexus/attachments/mission-context path and mirrors to home', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(homeDir, '.nexus'), { recursive: true, mode: 0o700 });
    const result = await importWorkspaceMissionAttachment(
      root,
      'cliente.m4a',
      Buffer.from('audio-bytes').toString('base64'),
      { homeDir, token: () => 'fixed-token' },
    );

    const stored = `${MISSION_CONTEXT_ATTACHMENT_PREFIX}${droppedFileName('cliente.m4a', 'fixed-token')}`;
    expect(result).toEqual({
      ok: true,
      path: stored,
      // F-760: onde o arquivo está de fato — é o que se digita no pane.
      absolutePath: path.join(root, stored),
    });
    if (!result.ok) return;
    expect(fs.existsSync(result.absolutePath ?? '')).toBe(true);
    const abs = path.join(root, result.path);
    expect(fs.readFileSync(abs, 'utf8')).toBe('audio-bytes');
    const dirMode = process.platform === 'win32' ? 0o666 : 0o700;
    const fileMode = process.platform === 'win32' ? 0o666 : 0o600;
    expect(fs.statSync(path.dirname(abs)).mode & 0o777).toBe(dirMode);
    expect(fs.statSync(abs).mode & 0o777).toBe(fileMode);
    expect(path.isAbsolute(result.path)).toBe(false);

    const mirror = path.join(
      homeDir,
      '.nexus',
      'attachments',
      'mission-context',
      droppedFileName('cliente.m4a', 'fixed-token'),
    );
    expect(fs.existsSync(mirror)).toBe(true);
    expect(fs.readFileSync(mirror, 'utf8')).toBe('audio-bytes');
  });

  it('streams a local fd into mission-context (F-582)', async () => {
    const root = workspace();
    const source = path.join(tempRoot, 'video.mp4');
    fs.writeFileSync(source, 'v'.repeat(1024 * 1024 + 7));
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY);
    try {
      const result = await importWorkspaceMissionAttachmentFromFile(
        root,
        'video.mp4',
        sourceFd,
        fs.fstatSync(sourceFd).size,
        { token: () => 'stream-tok' },
      );
      const stored = `${MISSION_CONTEXT_ATTACHMENT_PREFIX}${droppedFileName('video.mp4', 'stream-tok')}`;
      expect(result).toEqual({
        ok: true,
        path: stored,
        absolutePath: path.join(root, stored),
      });
      if (result.ok) {
        expect(
          fs.statSync(path.join(root, result.path)).size,
        ).toBe(1024 * 1024 + 7);
      }
    } finally {
      fs.closeSync(sourceFd);
    }
  });

  it('does not mirror a streamed file above 14 MiB into ~/.nexus (F-582 review)', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(homeDir, '.nexus'), { mode: 0o700 });
    const source = path.join(tempRoot, 'grande.mp4');
    fs.writeFileSync(source, '');
    fs.truncateSync(source, DROPPED_ATTACHMENT_MAX_BYTES + 1024);
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY);
    try {
      const result = await importWorkspaceMissionAttachmentFromFile(
        root,
        'grande.mp4',
        sourceFd,
        fs.fstatSync(sourceFd).size,
        { homeDir, token: () => 'big-tok' },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(fs.statSync(path.join(root, result.path)).size).toBe(
          DROPPED_ATTACHMENT_MAX_BYTES + 1024,
        );
      }
      const mirrorDir = path.join(
        homeDir,
        '.nexus',
        'attachments',
        'mission-context',
      );
      const mirrorFile = path.join(
        mirrorDir,
        droppedFileName('grande.mp4', 'big-tok'),
      );
      expect(fs.existsSync(mirrorFile)).toBe(false);
    } finally {
      fs.closeSync(sourceFd);
    }
  });

  it('still mirrors a streamed file at or under 14 MiB into ~/.nexus', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(homeDir, '.nexus'), { mode: 0o700 });
    const source = path.join(tempRoot, 'pequeno.mp4');
    fs.writeFileSync(source, 'v'.repeat(1024));
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY);
    try {
      const result = await importWorkspaceMissionAttachmentFromFile(
        root,
        'pequeno.mp4',
        sourceFd,
        fs.fstatSync(sourceFd).size,
        { homeDir, token: () => 'small-tok' },
      );
      expect(result.ok).toBe(true);
      const mirrorFile = path.join(
        homeDir,
        '.nexus',
        'attachments',
        'mission-context',
        droppedFileName('pequeno.mp4', 'small-tok'),
      );
      expect(fs.existsSync(mirrorFile)).toBe(true);
    } finally {
      fs.closeSync(sourceFd);
    }
  });

  it('aborts the streamed copy when the source grew past expectedSize and removes the staged file', async () => {
    const root = workspace();
    const source = path.join(tempRoot, 'mutante.bin');
    fs.writeFileSync(source, 'x'.repeat(4096));
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY);
    const dir = path.join(
      root,
      ...MISSION_CONTEXT_ATTACHMENT_PREFIX.split('/'),
    );
    try {
      const result = await importWorkspaceMissionAttachmentFromFile(
        root,
        'mutante.bin',
        sourceFd,
        2048, // o arquivo real tem 4096 — mudou depois do fstat
        { token: () => 'grow-tok' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/changed during|durável|durable/i);
      }
      const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      expect(leftovers.filter((f) => f.includes('mutante'))).toEqual([]);
    } finally {
      fs.closeSync(sourceFd);
    }
  });

  it('does not follow a symlink out of the workspace', async () => {
    const root = workspace();
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(outside);
    const nexus = path.join(root, '.nexus');
    fs.symlinkSync(outside, nexus);

    const result = await importWorkspaceMissionAttachment(
      root,
      'attack.txt',
      Buffer.from('forjado').toString('base64'),
      { token: () => 'attack' },
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'attachments'))).toBe(false);
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

    // O Windows não permite criar arquivo com caractere de controle no nome.
    if (process.platform !== 'win32') {
      const controlPath = regularFile('line\nbreak.txt', 128);
      expect(() =>
        validateDroppedAttachmentPaths([controlPath], { homeDir }),
      ).toThrow(/path is invalid/i);
    }
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
    // Read-only no Windows reporta 0o444; 0o400 exato é POSIX.
    const sealedMode = process.platform === 'win32' ? 0o444 : 0o400;
    expect(fs.lstatSync(sealed.path).mode & 0o777).toBe(sealedMode);
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

describe('anexo grande sem bloquear o Main (#21)', () => {
  it('salva 14 MiB exatos (a regex antiga estourava a pilha acima de ~3 MiB) cedendo o loop', async () => {
    const bytes = randomBytes(DROPPED_ATTACHMENT_MAX_BYTES);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const pending = saveDroppedFile('grande.bin', bytes.toString('base64'), {
      homeDir,
      token: () => 'big',
    });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    expect(yielded).toBe(true);
    if (result.ok) expect(fs.readFileSync(result.path).equals(bytes)).toBe(true);
  });

  it.each([
    ['bits finais sujos', 'QR=='],
    ['caractere fora do alfabeto', 'QU!D'],
    ['comprimento fora de múltiplo de 4', 'QUJ'],
    ['padding no fim de uma fatia que não é a última', `${'QUJD'.repeat(262_143)}QQ==${'QUJD'.repeat(4)}`],
    ['padding no meio', `QQ==${'QUJD'.repeat(400_000)}`],
  ])('recusa base64 não canônico (%s) antes de criar arquivo', async (_label, base64) => {
    const result = await saveDroppedFile('x.bin', base64, { homeDir, token: () => 'bad' });
    expect(result).toMatchObject({ ok: false });
    expect(fs.existsSync(droppedDir())).toBe(false);
  });

  it('copia o arquivo local em blocos sem bloquear o loop', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'stream-')));
    const source = path.join(tempRoot, 'video-grande.mp4');
    const bytes = randomBytes(3 * 1024 * 1024 + 5);
    fs.writeFileSync(source, bytes);
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY);
    try {
      let yielded = false;
      setImmediate(() => { yielded = true; });
      const pending = importWorkspaceMissionAttachmentFromFile(
        root, 'video-grande.mp4', sourceFd, bytes.length, { token: () => 'stream-big' },
      );
      expect(pending).toBeInstanceOf(Promise);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(yielded).toBe(true);
      if (result.ok) expect(fs.readFileSync(path.join(root, result.path)).equals(bytes)).toBe(true);
    } finally {
      fs.closeSync(sourceFd);
    }
  });
});

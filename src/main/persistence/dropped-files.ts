import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DROPPED_ATTACHMENT_MAX_COUNT = 6;
export const DROPPED_ATTACHMENT_MAX_PATH_CHARS = 4_096;
export const DROPPED_ATTACHMENT_MAX_BYTES = 14 * 1024 * 1024;
export const DROPPED_ATTACHMENTS_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const DROPPED_ATTACHMENT_MAX_BASE64_CHARS =
  Math.ceil(DROPPED_ATTACHMENT_MAX_BYTES / 3) * 4;

interface DroppedFileSecurityOptions {
  readonly homeDir?: string;
  readonly expectedUid?: number | null;
}

export interface SaveDroppedFileOptions extends DroppedFileSecurityOptions {
  readonly token?: () => string;
}

export type SaveDroppedFileResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

export interface DroppedAttachmentSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

function expectedUid(options: DroppedFileSecurityOptions): number | null {
  if (options.expectedUid !== undefined) return options.expectedUid;
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function canonicalHome(options: DroppedFileSecurityOptions): string {
  return fs.realpathSync(options.homeDir ?? os.homedir());
}

function assertOwned(
  stat: fs.Stats,
  uid: number | null,
  label: string,
): void {
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`${label} owner uid does not match the Nexus process`);
  }
}

function assertSingleLink(stat: fs.Stats, label: string): void {
  if (stat.nlink !== 1) {
    throw new Error(`${label} must have exactly one filesystem link`);
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDroppedDirectory(
  options: DroppedFileSecurityOptions,
  create: boolean,
): string {
  const home = canonicalHome(options);
  const uid = expectedUid(options);
  const nexusDir = path.join(home, '.nexus');
  const root = path.join(nexusDir, 'dropped');
  if (create && !fs.existsSync(nexusDir)) {
    fs.mkdirSync(nexusDir, { mode: 0o700 });
  }
  const nexusStat = fs.lstatSync(nexusDir);
  if (nexusStat.isSymbolicLink() || !nexusStat.isDirectory()) {
    throw new Error('~/.nexus must be a real directory');
  }
  assertOwned(nexusStat, uid, '~/.nexus');
  if (fs.realpathSync(nexusDir) !== path.resolve(nexusDir)) {
    throw new Error('~/.nexus cannot traverse a symlink');
  }
  if (create && !fs.existsSync(root)) {
    fs.mkdirSync(root, { mode: 0o700 });
  }
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('~/.nexus/dropped must be a real directory');
  }
  assertOwned(rootStat, uid, '~/.nexus/dropped');
  const realRoot = fs.realpathSync(root);
  if (realRoot !== path.resolve(root)) {
    throw new Error('~/.nexus/dropped cannot traverse a symlink');
  }
  if (create) fs.chmodSync(root, 0o700);
  return realRoot;
}

function safeToken(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'drop';
}

export function droppedFileName(name: string, token: string): string {
  const safeName =
    path
      .basename(name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(-80) || 'pasted';
  return `${safeToken(token)}-${safeName}`;
}

function decodeBase64(base64: string): Buffer {
  if (
    base64.length > DROPPED_ATTACHMENT_MAX_BASE64_CHARS ||
    !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(
      base64,
    )
  ) {
    throw new Error('invalid or oversized dropped-file payload');
  }
  const decoded = Buffer.from(base64, 'base64');
  if (
    decoded.length > DROPPED_ATTACHMENT_MAX_BYTES ||
    decoded.toString('base64') !== base64
  ) {
    throw new Error('dropped file exceeds the 14 MiB item limit');
  }
  return decoded;
}

/**
 * Stages one renderer-provided blob without following links or replacing an
 * existing path. The returned path is already canonical and private.
 */
export function saveDroppedFile(
  name: string,
  base64: string,
  options: SaveDroppedFileOptions = {},
): SaveDroppedFileResult {
  let file = '';
  let fd: number | null = null;
  let created = false;
  let createdIdentity: fs.Stats | null = null;
  try {
    const decoded = decodeBase64(base64);
    const root = requireDroppedDirectory(options, true);
    const token =
      options.token?.() ??
      `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
    file = path.join(root, droppedFileName(name, token));
    const noFollow =
      'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    created = true;
    const opened = fs.fstatSync(fd);
    createdIdentity = opened;
    if (!opened.isFile()) {
      throw new Error('dropped-file target is not a regular file');
    }
    assertOwned(opened, expectedUid(options), 'dropped file');
    assertSingleLink(opened, 'dropped file');
    fs.writeFileSync(fd, decoded);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    if (
      !written.isFile() ||
      written.size !== decoded.length ||
      !sameFileIdentity(opened, written)
    ) {
      throw new Error('dropped-file write was not durable');
    }
    assertSingleLink(written, 'dropped file');
    const canonical = fs.realpathSync(file);
    const current = fs.lstatSync(file);
    const canonicalStat = fs.lstatSync(canonical);
    if (
      !isInside(root, canonical) ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !canonicalStat.isFile() ||
      !sameFileIdentity(written, current) ||
      !sameFileIdentity(written, canonicalStat)
    ) {
      throw new Error('dropped-file path changed during staging');
    }
    assertOwned(current, expectedUid(options), 'dropped file');
    assertSingleLink(current, 'dropped file');
    fs.closeSync(fd);
    fd = null;
    return { ok: true, path: canonical };
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup below.
      }
    }
    if (created && file && createdIdentity) {
      try {
        const current = fs.lstatSync(file);
        if (
          !current.isSymbolicLink() &&
          sameFileIdentity(createdIdentity, current)
        ) {
          fs.unlinkSync(file);
        }
      } catch {
        // The exclusively-created file was already removed.
      }
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'save failed',
    };
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Canonicalizes the attachment list at approval and again immediately before
 * bootstrap. Files must remain private regular files under the exact dropped
 * directory; a renderer path is never trusted because it was staged earlier.
 */
function inspectDroppedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: DroppedFileSecurityOptions = {},
): DroppedAttachmentSnapshot[] | undefined {
  if (paths === undefined) return undefined;
  if (paths.length > DROPPED_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `mission attachments exceed the ${DROPPED_ATTACHMENT_MAX_COUNT}-file limit`,
    );
  }
  if (paths.length === 0) return [];
  const root = requireDroppedDirectory(options, false);
  const uid = expectedUid(options);
  const validated: DroppedAttachmentSnapshot[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const raw of paths) {
    if (
      raw.length === 0 ||
      raw.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
      !path.isAbsolute(raw) ||
      /[\u0000-\u001f\u007f]/.test(raw)
    ) {
      throw new Error('mission attachment path is invalid');
    }
    let fd: number | null = null;
    try {
      const before = fs.lstatSync(raw);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(
          'mission attachment must be a regular non-symlink file',
        );
      }
      assertOwned(before, uid, 'mission attachment');
      assertSingleLink(before, 'mission attachment');

      const noFollow =
        'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
      fd = fs.openSync(raw, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameFileIdentity(before, opened)) {
        throw new Error('mission attachment changed during validation');
      }
      assertOwned(opened, uid, 'mission attachment');
      assertSingleLink(opened, 'mission attachment');

      const canonical = fs.realpathSync(raw);
      if (!isInside(root, canonical)) {
        throw new Error('mission attachment is outside ~/.nexus/dropped');
      }
      const current = fs.lstatSync(raw);
      const canonicalStat = fs.lstatSync(canonical);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        !canonicalStat.isFile() ||
        !sameFileIdentity(opened, current) ||
        !sameFileIdentity(opened, canonicalStat)
      ) {
        throw new Error('mission attachment changed during validation');
      }
      assertOwned(current, uid, 'mission attachment');
      assertSingleLink(current, 'mission attachment');
      if (opened.size > DROPPED_ATTACHMENT_MAX_BYTES) {
        throw new Error('mission attachment exceeds the 14 MiB item limit');
      }
      if (seen.has(canonical)) {
        throw new Error('mission attachment paths must be unique');
      }
      seen.add(canonical);
      totalBytes += opened.size;
      if (totalBytes > DROPPED_ATTACHMENTS_MAX_TOTAL_BYTES) {
        throw new Error('mission attachments exceed the 40 MiB total limit');
      }
      const contents = fs.readFileSync(fd);
      const afterRead = fs.fstatSync(fd);
      const afterPathRead = fs.lstatSync(canonical);
      if (
        !sameFileIdentity(opened, afterRead) ||
        !sameFileIdentity(opened, afterPathRead) ||
        opened.size !== afterRead.size ||
        opened.mtimeMs !== afterRead.mtimeMs ||
        opened.ctimeMs !== afterRead.ctimeMs ||
        contents.length !== opened.size
      ) {
        throw new Error('mission attachment changed while hashing');
      }
      validated.push(Object.freeze({
        path: canonical,
        sha256: createHash('sha256').update(contents).digest('hex'),
        size: opened.size,
      }));
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return validated;
}

export function snapshotDroppedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: DroppedFileSecurityOptions = {},
): DroppedAttachmentSnapshot[] | undefined {
  return inspectDroppedAttachmentPaths(paths, options)?.map((entry) => ({ ...entry }));
}

export function validateDroppedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: DroppedFileSecurityOptions = {},
): string[] | undefined {
  return inspectDroppedAttachmentPaths(paths, options)?.map((entry) => entry.path);
}

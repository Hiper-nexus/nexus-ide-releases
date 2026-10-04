import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Flush the *directory entry* after a rename. Without this the file bytes are
 * durable but the rename that publishes them is not: a power loss can leave the
 * old contents in place while the authoritative store has already committed —
 * a silent divergence rather than a visible corruption. Best effort: Windows
 * cannot open a directory as a file descriptor.
 */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Platform does not support directory fsync (notably Windows).
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * Crash-safe JSON persistence: write to a sibling temp file then atomically
 * rename over the target, so a crash mid-write can never truncate the real
 * file into an unparseable state (which the readers here treat as "empty" and
 * would otherwise silently drop all persisted data).
 *
 * The parent directory is created with mode 0o700 and the file with mode
 * 0o600 by default — these files hold auth tokens and private keys. The temp
 * name is unpredictable and opened with O_CREAT|O_EXCL|O_NOFOLLOW so a local
 * attacker cannot pre-plant a symlink at the temp path to redirect the write.
 */
export function writeJsonAtomic(
  file: string,
  value: unknown,
  mode: number = 0o600,
): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2), mode);
}

/** Atomically replace a file without following a pre-planted temp symlink. */
export function writeFileAtomic(
  file: string,
  value: string | NodeJS.ArrayBufferView,
  mode: number = 0o600,
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
    mode,
  );
  try {
    try {
      fs.writeFileSync(fd, value);
      try {
        fs.fchmodSync(fd, mode);
      } catch {
        // Best effort on filesystems that do not preserve POSIX mode.
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    fsyncDirectory(dir);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp file already gone.
    }
    throw err;
  }
}

/** `fsyncDirectory` without blocking the event loop. */
async function fsyncDirectoryAsync(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, fs.constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Platform does not support directory fsync (notably Windows).
  } finally {
    await handle?.close().catch(() => {
      // Already closed.
    });
  }
}

/**
 * `writeFileAtomic` for the Electron main thread (F-764): the same guarantees —
 * unpredictable O_CREAT|O_EXCL|O_NOFOLLOW temp, mode, fsync of the file and of
 * the directory entry, temp unlinked on failure — but every syscall runs on
 * the libuv pool instead of blocking the event loop.
 */
export async function writeFileAtomicAsync(
  file: string,
  value: string | NodeJS.ArrayBufferView,
  mode: number = 0o600,
  options: { beforeCommit?: () => void; createDirectory?: boolean } = {},
): Promise<void> {
  const dir = path.dirname(file);
  if (options.createDirectory !== false) await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await fs.promises.open(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
    mode,
  );
  try {
    try {
      await handle.writeFile(value);
      try {
        await handle.chmod(mode);
      } catch {
        // Best effort on filesystems that do not preserve POSIX mode.
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    options.beforeCommit?.();
    await fs.promises.rename(tmp, file);
    await fsyncDirectoryAsync(dir);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {
      // Temp file already gone.
    });
    throw err;
  }
}

/**
 * Create an immutable sibling backup with an unguessable, exclusive name.
 * Returns the path only after bytes and metadata have been flushed.
 */
export function writeTimestampedBackup(
  file: string,
  value: string | NodeJS.ArrayBufferView,
  mode: number = 0o600,
): string {
  const backup = `${file}.${Date.now()}.${randomBytes(8).toString('hex')}.bak`;
  const fd = fs.openSync(
    backup,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
    mode,
  );
  try {
    try {
      fs.writeFileSync(fd, value);
      try {
        fs.fchmodSync(fd, mode);
      } catch {
        // Best effort on filesystems that do not preserve POSIX mode.
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return backup;
  } catch (err) {
    try {
      fs.unlinkSync(backup);
    } catch {
      // Preserve the original persistence error.
    }
    throw err;
  }
}

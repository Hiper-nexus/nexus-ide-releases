import fs from 'node:fs';
import path from 'node:path';

/**
 * Crash-safe JSON persistence: write to a sibling temp file then atomically
 * rename over the target, so a crash mid-write can never truncate the real
 * file into an unparseable state (which the readers here treat as "empty" and
 * would otherwise silently drop all persisted data).
 *
 * The parent directory is created with mode 0o700 and the file with mode
 * 0o600 by default — these files hold auth tokens and private keys.
 */
export function writeJsonAtomic(
  file: string,
  value: unknown,
  mode: number = 0o600,
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    mode,
  });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    // Best effort on filesystems that do not preserve POSIX mode.
  }
  fs.renameSync(tmp, file);
}

import fs from 'node:fs';
import path from 'node:path';

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * Persist auth/session files a CLI wrote into an ephemeral overlay HOME back
 * into its real provider home before the overlay is purged.
 *
 * The overlay symlinks every file that already existed in the real home, so
 * writes to those went straight through and are already persisted. Only entries
 * that are REAL (non-symlink) in the overlay are new — most importantly a
 * first-time `/login` whose auth artifact did not exist when the overlay was
 * built. Without this sync-back that login is lost when the overlay is removed,
 * so the provider stays "login-needed" forever even though the user just
 * authenticated in the pane.
 *
 * `excludeTop` skips top-level entries — the token-bearing config the overlay
 * injected at its root (e.g. kimi's mcp.json / grok's config.toml).
 * `excludeAnywhere` skips entries by name at ANY depth — for overlays whose
 * token config is nested (e.g. AGY's .gemini/config/mcp_config.json). Neither
 * must ever leak into the user's real profile.
 *
 * Best-effort: never throws. Teardown must not be blocked by a copy failure.
 */
export function syncBackOverlayAuth(
  overlayDir: string,
  realHome: string,
  excludeTop: ReadonlySet<string>,
  excludeAnywhere: ReadonlySet<string> = NO_NAMES,
): void {
  copyNewEntries(overlayDir, realHome, excludeTop, excludeAnywhere, true);
}

function copyNewEntries(
  srcDir: string,
  dstDir: string,
  excludeTop: ReadonlySet<string>,
  excludeAnywhere: ReadonlySet<string>,
  atTop: boolean,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (excludeAnywhere.has(entry.name)) continue;
    if (atTop && excludeTop.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue;
    }
    // Symlinks point back at the real home already — nothing new to copy.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      try {
        fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      } catch {
        // Individual file copies below will surface any real failure.
      }
      copyNewEntries(src, dst, excludeTop, excludeAnywhere, false);
      continue;
    }
    if (stat.isFile()) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o600);
      } catch {
        // Best effort per file — a partial sync still beats losing the login.
      }
    }
  }
}

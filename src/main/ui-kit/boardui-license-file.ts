import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomic-write';
import { buildUiKitChildEnv } from './ui-kit-cli';

/**
 * BoardUI's own licence file — the file its CLI reads on EVERY Pro download and
 * licence check, and the whole reason a licence can work on a machine that
 * never called `activate_license`.
 *
 * The vendor counts seats at ACTIVATION only (measured 21/10/2026: a copied
 * file — same key, same instanceId — answers `license_status` "valid and
 * active", lists the Pro items and installs a real Pro template from an
 * isolated HOME). Provisioning that file on a fresh machine is therefore how
 * the operator's one licence serves every client without spending vendor
 * seats — operator decision 21/10, "opção B".
 *
 * Every path decision here MIRRORS the vendored `boardui` dist byte for byte,
 * so the file the Nexus writes is the file the MCP child (and a CLI the user
 * runs in their own terminal, with the same env) resolves:
 *
 * - root: `XDG_CONFIG_HOME` → win32 `APPDATA` → `<homedir>/.config`
 * - file: `<root>/boardui/license.json`
 * - parse: only `licenseKey` must be a non-empty string; `instanceId` /
 *   `instanceName` default to `""` when not strings
 *
 * The child env is the SOURCE OF TRUTH for the path: `callMcpToolOnce` builds
 * it with `buildUiKitChildEnv()`, so the writer resolves with the same env the
 * reader runs under — the two sides cannot drift apart on a Linux session that
 * exports `XDG_CONFIG_HOME` somewhere other than `~/.config`.
 */

export interface BoardUiLicenseFile {
  readonly licenseKey: string;
  readonly instanceId: string;
  readonly instanceName: string;
}

/**
 * The config root the vendored BoardUI CLI resolves for the given environment.
 * Pure: the caller decides whose env (ours, the child's, a fixture's).
 */
export function boarduiConfigRoot(
  env: { readonly XDG_CONFIG_HOME?: string; readonly APPDATA?: string; readonly HOME?: string },
  platform: NodeJS.Platform,
  homedir: () => string = os.homedir,
): string {
  // Truthy check, like the dist: a non-empty string, any platform.
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    return env.XDG_CONFIG_HOME;
  }
  if (platform === 'win32' && typeof env.APPDATA === 'string' && env.APPDATA.length > 0) {
    return env.APPDATA;
  }
  // Node's os.homedir() reads HOME on POSIX and USERPROFILE on Windows — the
  // child runs with the same forwarded HOME, so both sides agree here too.
  return path.join(env.HOME ?? homedir(), '.config');
}

/** `<configRoot>/boardui/license.json`, the dist's own licence path. */
export function boarduiLicenseFilePath(root: string): string {
  return path.join(root, 'boardui', 'license.json');
}

/**
 * Parse the licence file the way `getLicense()` does. Only `licenseKey` is
 * required (non-empty string); the other two fall back to `""` — so a file
 * our payload wrote round-trips, and so does one the vendor's own CLI wrote.
 */
export function parseBoardUiLicenseFile(raw: string): BoardUiLicenseFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.licenseKey !== 'string' || candidate.licenseKey.length === 0) {
    return null;
  }
  return {
    licenseKey: candidate.licenseKey,
    instanceId: typeof candidate.instanceId === 'string' ? candidate.instanceId : '',
    instanceName: typeof candidate.instanceName === 'string' ? candidate.instanceName : '',
  };
}

/** The exact bytes the vendor's own `activateLicense` writes. */
export function serializeBoardUiLicenseFile(file: BoardUiLicenseFile): string {
  return `${JSON.stringify(
    {
      licenseKey: file.licenseKey,
      instanceId: file.instanceId,
      instanceName: file.instanceName,
    },
    null,
    2,
  )}\n`;
}

/**
 * Whether `file` is exactly the payload this build provisions. THAT predicate,
 * not "was the vault empty", is what keeps a provisioned machine's "Remover"
 * local: the bundled instanceId belongs to the operator's own seat, and
 * releasing it from a client would kill Pro for the whole fleet.
 */
export function isProvisionedBoardUiLicense(
  file: BoardUiLicenseFile | null,
  payload: BoardUiLicenseFile,
): boolean {
  return (
    file !== null &&
    file.licenseKey === payload.licenseKey &&
    file.instanceId === payload.instanceId
  );
}

/**
 * What an honest read of the licence file can report. Security review 21/10:
 * the old `read(): BoardUiLicenseFile | null` answered null for BOTH a
 * missing file and an unreadable one (EACCES, EISDIR…), so "absence" was
 * never positively established — and the atomic write renames over the old
 * file with only DIRECTORY write permission, which would destroy a licence
 * the process could not even read.
 *
 * - `absent`: ENOENT — the only positive proof a file is not there.
 * - `unreadable`: a file IS there and its bytes could not be read. Callers
 *   treat it like a native file: refuse to touch it.
 * - `parsed`: the bytes read fine. `file: null` means corrupted/unparseable
 *   content — the CLI reads no licence from it either, so re-provisioning
 *   heals rather than destroys.
 */
export type BoardUiLicenseRead =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'parsed'; readonly file: BoardUiLicenseFile | null };

/** Filesystem access to the licence file, injectable in tests. */
export interface BoardUiLicenseFileOps {
  /** Absence, unreadability or the parsed licence — never a guess. */
  read(): BoardUiLicenseRead;
  /** Write the payload atomically (tmp + rename, the repo's own pattern). */
  write(payload: BoardUiLicenseFile): { ok: boolean; error?: string };
  /** Remove the file only; the `boardui/` directory stays. */
  remove(): { ok: boolean; error?: string };
}

/**
 * The real filesystem ops, bound to the path the spawned MCP child resolves.
 * Main-process only by construction: it needs the child env.
 */
export function realBoardUiLicenseFileOps(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = buildUiKitChildEnv(),
): BoardUiLicenseFileOps {
  const file = boarduiLicenseFilePath(boarduiConfigRoot(env, platform));
  return {
    read: () => {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (error) {
        // ENOENT is the ONLY proof of absence. Anything else (EACCES, EISDIR,
        // EPERM, transient IO) means a file is THERE and unread — reporting it
        // as absent is what lets a write destroy it.
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { status: 'absent' }
          : { status: 'unreadable' };
      }
      return { status: 'parsed', file: parseBoardUiLicenseFile(raw) };
    },
    write: (payload) => {
      try {
        // The repo's own atomic write: parent dir 0o700, file 0o600, temp
        // with O_NOFOLLOW, rename — a CLI reading at the wrong moment must
        // never see half a file, and the key never lands world-readable.
        writeFileAtomic(file, serializeBoardUiLicenseFile(payload));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `could not write the BoardUI licence file: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 400),
        };
      }
    },
    remove: () => {
      try {
        // A single regular file; no recursion, so no junction can be followed.
        fs.rmSync(file, { force: true });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `could not remove the BoardUI licence file: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 400),
        };
      }
    },
  };
}

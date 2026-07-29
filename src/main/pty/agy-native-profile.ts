import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface NativeUserInfo {
  readonly homedir: string;
  readonly uid: number;
}

export interface NativeUserHomeResolutionOptions {
  /** Test seam; production always uses the OS account database. */
  readonly userInfo?: () => NativeUserInfo;
  /**
   * Last-resort OS resolver. It is accepted only when it does not resolve to
   * the inherited Electron HOME, which may be a Nexus isolation directory.
   */
  readonly fallbackHome?: () => string;
  readonly inheritedHome?: string | undefined;
}

export interface AgyNativeProfile {
  readonly processHome: string;
  readonly providerStateReadPaths: readonly string[];
  readonly providerStateWritePaths: readonly string[];
}

function canonicalOwnedDirectory(
  candidate: string | undefined,
  expectedUid: number | undefined,
): string | null {
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    return null;
  }
  try {
    const real = fs.realpathSync.native(candidate);
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) return null;
    if (
      expectedUid !== undefined &&
      expectedUid >= 0 &&
      stat.uid !== expectedUid
    ) {
      return null;
    }
    return real;
  } catch {
    return null;
  }
}

function samePath(left: string | undefined, right: string): boolean {
  if (!left || !path.isAbsolute(left) || left.includes("\0")) return false;
  return path.resolve(left) === path.resolve(right);
}

/**
 * Resolve the real OS-account HOME without trusting Electron's environment.
 *
 * `os.homedir()` may return process.env.HOME, so the primary source is the
 * account database exposed by `os.userInfo()`. The fallback is deliberately
 * refused when it points at the inherited HOME; failing closed is safer than
 * silently launching AGY against an empty isolation profile.
 */
export function resolveNativeUserHome(
  options: NativeUserHomeResolutionOptions = {},
): string {
  const userInfo = options.userInfo ?? (() => os.userInfo());
  let account: NativeUserInfo | null = null;
  try {
    account = userInfo();
  } catch {
    account = null;
  }
  const accountHome = canonicalOwnedDirectory(account?.homedir, account?.uid);
  if (accountHome) return accountHome;

  const fallbackHome = options.fallbackHome ?? (() => os.homedir());
  let fallbackCandidate: string | null = null;
  try {
    fallbackCandidate = fallbackHome();
  } catch {
    fallbackCandidate = null;
  }
  const inheritedHome = options.inheritedHome ?? process.env.HOME;
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const fallback =
    fallbackCandidate && !samePath(inheritedHome, fallbackCandidate)
      ? canonicalOwnedDirectory(fallbackCandidate, currentUid)
      : null;
  if (fallback) return fallback;

  throw new Error(
    "AGY advisory spawn cannot resolve the native OS account HOME safely",
  );
}

function requiredDirectory(candidate: string, label: string): string {
  const directory = canonicalOwnedDirectory(candidate, undefined);
  if (directory) return directory;
  throw new Error(
    `AGY advisory spawn requires the native ${label} directory; ` +
      "run agy directly once and complete Google authentication",
  );
}

/**
 * AGY 1.1 stores its live profile under ~/.gemini/antigravity-cli and its
 * OAuth token in the native keychain. This returns the complete, minimal
 * Seatbelt grant set; no overlay, MCP projection, or real config mutation.
 */
export function resolveAgyNativeProfile(
  options: NativeUserHomeResolutionOptions = {},
): AgyNativeProfile {
  const processHome = resolveNativeUserHome(options);
  const geminiHome = requiredDirectory(
    path.join(processHome, ".gemini"),
    "~/.gemini",
  );
  const antigravityState = requiredDirectory(
    path.join(geminiHome, "antigravity-cli"),
    "~/.gemini/antigravity-cli",
  );
  const keychains = requiredDirectory(
    path.join(processHome, "Library", "Keychains"),
    "~/Library/Keychains",
  );

  return Object.freeze({
    processHome,
    providerStateReadPaths: Object.freeze([geminiHome, keychains]),
    providerStateWritePaths: Object.freeze([antigravityState]),
  });
}

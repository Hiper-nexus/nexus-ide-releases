// Codex CLI version resolution for spawn-time feature gating.
//
// `--dangerously-bypass-hook-trust` exists only in codex >= ~0.129 and was
// IGNORED by the TUI in 0.131–0.133 (upstream bug, fixed after). Passing an
// unknown flag to an older codex breaks the spawn outright, so the flag is
// only added when the resolved version is >= 0.134.0; when the version cannot
// be determined the flag is omitted (fail-safe: the pane boots, hooks fall
// back to the review prompt).

import { execFileSync } from 'node:child_process';
import { resolveLoginShellPath } from '../adapters/adapter-registry';

/** Minimum codex version that honors --dangerously-bypass-hook-trust. */
const HOOK_TRUST_BYPASS_MIN_VERSION: [number, number, number] = [0, 134, 0];

export type CodexVersionExec = (
  bin: string,
  args: string[],
  options: {
    stdio: 'pipe';
    encoding: 'utf-8';
    timeout: number;
    env?: NodeJS.ProcessEnv;
  },
) => string;

/** Parse the first semver triple out of `codex --version` output. */
export function parseCodexCliVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function versionAtLeast(version: string, min: [number, number, number]): boolean {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i += 1) {
    const a = parts[i] ?? 0;
    if (a !== min[i]!) return a > min[i]!;
  }
  return true;
}

let versionCache = new Map<string, string | null>();

/**
 * Resolve the installed codex version (`codex --version`), memoised per bin
 * for the process lifetime. Returns null when the binary or its version
 * cannot be determined — callers must treat null as "feature unavailable".
 */
export function resolveCodexCliVersion(
  bin = 'codex',
  execImpl: CodexVersionExec = execFileSync as unknown as CodexVersionExec,
): string | null {
  const cached = versionCache.get(bin);
  if (cached !== undefined) return cached;

  let version: string | null = null;
  const options = {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 5_000,
  } as const;
  try {
    version = parseCodexCliVersion(execImpl(bin, ['--version'], options));
  } catch {
    // GUI apps inherit a minimal PATH; retry with the login-shell PATH (same
    // doctrine as isBinInstalled in adapter-registry).
    try {
      const loginPath = resolveLoginShellPath();
      version = parseCodexCliVersion(
        execImpl(bin, ['--version'], {
          ...options,
          env: { ...process.env, PATH: loginPath },
        }),
      );
    } catch {
      version = null;
    }
  }
  versionCache.set(bin, version);
  return version;
}

/**
 * Spawn args that let Nexus-managed hooks run without the interactive TUI
 * trust review. The Nexus installers are exactly the "automation that already
 * vets hook sources" the flag exists for (Nexus writes the hooks), and the
 * per-session `-c hooks.*` status hooks (codexStatusHookArgs) have no on-disk
 * identity that could be pre-trusted. Empty when the codex version is too old
 * or unknown — never breaks the spawn.
 */
export function codexHookTrustBypassArgs(
  bin = 'codex',
  execImpl?: CodexVersionExec,
): string[] {
  const version = resolveCodexCliVersion(bin, execImpl);
  if (version === null) return [];
  return versionAtLeast(version, HOOK_TRUST_BYPASS_MIN_VERSION)
    ? ['--dangerously-bypass-hook-trust']
    : [];
}

/** Test hook: drop the memoised versions. */
export function resetCodexCliVersionCacheForTests(): void {
  versionCache = new Map();
}

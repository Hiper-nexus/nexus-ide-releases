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
import { windowsNpmShimSpawn } from '../adapters/windows-npm-shim';
import { resolveCliBinary, resolveWindowsCodexNpmShimLaunch } from '../path-resolver';

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

/** Executable + prefix args that really run `bin` (Windows npm launcher). */
export type CodexVersionLaunch = (
  bin: string,
) => { file: string; argsPrefix: readonly string[] } | null;

/**
 * F-687: no Windows o `codex` do npm é um `.cmd`. `execFileSync('codex')` dá
 * ENOENT (o CreateProcess só completa `.exe`) e `codex.cmd` dá EINVAL (o Node
 * recusa batch sem shell), então a versão ficava null, a flag de confiança
 * nunca ia e todo pane Codex abria parado em "Hooks need review". Lê a versão
 * pelo mesmo lançador verificado do spawn (`node.exe` + `codex.js` do pacote),
 * sem cmd.exe.
 */
export function windowsCodexVersionLaunch(
  bin: string,
): { file: string; argsPrefix: readonly string[] } | null {
  if (process.platform !== 'win32') return null;
  const binPath = resolveCliBinary(bin)?.binPath;
  if (!binPath) return null;
  if (/\.(?:exe|com)$/iu.test(binPath)) return { file: binPath, argsPrefix: [] };
  return (
    resolveWindowsCodexNpmShimLaunch(binPath) ?? windowsNpmShimSpawn('codex', binPath)
  );
}

/**
 * Resolve the installed codex version (`codex --version`), memoised per bin
 * for the process lifetime. Returns null when the binary or its version
 * cannot be determined — callers must treat null as "feature unavailable".
 */
export function resolveCodexCliVersion(
  bin = 'codex',
  execImpl: CodexVersionExec = execFileSync as unknown as CodexVersionExec,
  launchImpl: CodexVersionLaunch = windowsCodexVersionLaunch,
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
    version = null;
  }
  if (version === null) {
    try {
      const launch = launchImpl(bin);
      if (launch) {
        version = parseCodexCliVersion(
          execImpl(launch.file, [...launch.argsPrefix, '--version'], options),
        );
      }
    } catch {
      version = null;
    }
  }
  if (version === null) {
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
  launchImpl?: CodexVersionLaunch,
): string[] {
  const version = resolveCodexCliVersion(bin, execImpl, launchImpl);
  if (version === null) return [];
  return versionAtLeast(version, HOOK_TRUST_BYPASS_MIN_VERSION)
    ? ['--dangerously-bypass-hook-trust']
    : [];
}

/** Test hook: drop the memoised versions. */
export function resetCodexCliVersionCacheForTests(): void {
  versionCache = new Map();
}

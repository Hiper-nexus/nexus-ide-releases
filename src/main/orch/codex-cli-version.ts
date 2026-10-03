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
import { readCliBinaryVersion, resolveCliBinary, resolveWindowsCodexNpmShimLaunch } from '../path-resolver';

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
 * Resolve the selected codex version, sharing the real-path/mtime cache with
 * binary selection. Injected executors retain the per-bin test cache. Returns
 * null when the binary or its version cannot be determined — callers must treat null as "feature unavailable".
 */
export function resolveCodexCliVersion(
  bin = 'codex',
  execImpl: CodexVersionExec = execFileSync as unknown as CodexVersionExec,
  launchImpl: CodexVersionLaunch = windowsCodexVersionLaunch,
): string | null {
  if (execImpl === (execFileSync as unknown as CodexVersionExec) &&
      launchImpl === windowsCodexVersionLaunch) {
    const selected = resolveCliBinary(bin);
    return selected ? readCliBinaryVersion(selected.binPath, resolveLoginShellPath(), 'codex') : null;
  }
  const cached = versionCache.get(bin);
  if (cached !== undefined) return cached;

  const version = probeCodexCli(bin, ['--version'], parseCodexCliVersion, execImpl, launchImpl);
  versionCache.set(bin, version);
  return version;
}

/**
 * Runs `bin <args>` and parses stdout: by the bare name, then through the
 * verified Windows launcher (F-687), then with the login-shell PATH (GUI apps
 * inherit a minimal PATH — same doctrine as isBinInstalled). Null when no
 * attempt yields a parse.
 */
function probeCodexCli<T>(
  bin: string,
  args: readonly string[],
  parse: (output: string) => T | null,
  execImpl: CodexVersionExec,
  launchImpl: CodexVersionLaunch,
): T | null {
  const options = {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 5_000,
  } as const;
  const attempts: Array<() => string | null> = [
    () => execImpl(bin, [...args], options),
    () => {
      const launch = launchImpl(bin);
      return launch
        ? execImpl(launch.file, [...launch.argsPrefix, ...args], options)
        : null;
    },
    () =>
      execImpl(bin, [...args], {
        ...options,
        env: { ...process.env, PATH: resolveLoginShellPath() },
      }),
  ];
  for (const attempt of attempts) {
    try {
      const output = attempt();
      const parsed = output === null ? null : parse(output);
      if (parsed !== null) return parsed;
    } catch {
      // Next attempt.
    }
  }
  return null;
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

let noDaemonCache = new Map<string, boolean>();

/**
 * F-689: o Codex >= 0.159 no Windows sobe um servidor compartilhado em
 * segundo plano e SAI quando o cliente está elevado ("start the Windows daemon
 * from a non-elevated terminal"). O Nexus aberto como administrador passa a
 * elevação a todo pane: o Codex morria em segundos, sem entrega, e o disjuntor
 * tirava a CLI da missão. `--no-daemon` roda o pane sozinho, que é também o
 * que o isolamento por pane (CODEX_HOME próprio) pressupõe. Vale antes de
 * qualquer subcomando (resume, fork, exec) e só entra quando o `--help` do
 * Codex instalado a anuncia — flag desconhecida quebraria o spawn.
 */
export function codexNoDaemonArgs(
  bin = 'codex',
  options: {
    readonly platform?: NodeJS.Platform;
    readonly execImpl?: CodexVersionExec;
    readonly launchImpl?: CodexVersionLaunch;
  } = {},
): string[] {
  if ((options.platform ?? process.platform) !== 'win32') return [];
  let supported = noDaemonCache.get(bin);
  if (supported === undefined) {
    supported =
      probeCodexCli(
        bin,
        ['--help'],
        (output) => (/(?:^|\s)--no-daemon(?![\w-])/u.test(output) ? true : null),
        options.execImpl ?? (execFileSync as unknown as CodexVersionExec),
        options.launchImpl ?? windowsCodexVersionLaunch,
      ) ?? false;
    noDaemonCache.set(bin, supported);
  }
  return supported ? ['--no-daemon'] : [];
}

/** Test hook: drop the memoised versions. */
export function resetCodexCliVersionCacheForTests(): void {
  versionCache = new Map();
  noDaemonCache = new Map();
}

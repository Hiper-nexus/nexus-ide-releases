// Codex CLI version resolution for spawn-time feature gating.
//
// `--dangerously-bypass-hook-trust` exists only in codex >= ~0.129 and was
// IGNORED by the TUI in 0.131–0.133 (upstream bug, fixed after). Passing an
// unknown flag to an older codex breaks the spawn outright, so the flag is
// only added when the resolved version is >= 0.134.0; when the version cannot
// be determined the flag is omitted (fail-safe: the pane boots, hooks fall
// back to the review prompt).

import { execFileSync } from 'node:child_process';
import { resolveAdapterBinary, resolveLoginShellPath } from '../adapters/adapter-registry';
import { windowsNpmShimSpawn } from '../adapters/windows-npm-shim';
import {
  cachedCliBinaryVersion,
  hasCliVersionProbesInFlight,
  probeCliBinaryVersion,
  resolveCliBinary,
  resolveWindowsCodexNpmShimLaunch,
  warmCliBinaryVersions,
} from '../path-resolver';

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
 *
 * F-764: o caminho real só lê o cache, aquecido no boot e no "Reexaminar
 * CLIs" (adapter-registry → `warmCliBinaryVersions`). Versão ainda não sondada
 * é versão desconhecida — o gate age como sempre agiu nesse caso — e a sonda
 * roda fora do Main; a chamada seguinte já sabe. A API continua síncrona.
 */
export function resolveCodexCliVersion(
  bin = 'codex',
  execImpl: CodexVersionExec = execFileSync as unknown as CodexVersionExec,
  launchImpl: CodexVersionLaunch = windowsCodexVersionLaunch,
): string | null {
  if (execImpl === (execFileSync as unknown as CodexVersionExec) &&
      launchImpl === windowsCodexVersionLaunch) {
    const selected = resolveCliBinary(bin);
    if (!selected) return null;
    const known = cachedCliBinaryVersion(selected.binPath, 'codex');
    if (known !== undefined) return known;
    void probeCliBinaryVersion(selected.binPath, resolveLoginShellPath(), 'codex');
    return null;
  }
  const cached = versionCache.get(bin);
  if (cached !== undefined) return cached;

  const version = probeCodexCli(bin, ['--version'], parseCodexCliVersion, execImpl, launchImpl);
  versionCache.set(bin, version);
  return version;
}

/**
 * Aquecimento do gate (F-764): sonda fora do Main a versão do Codex que a
 * resolução escolhe e deixa o cache pronto para `resolveCodexCliVersion`.
 * Nunca rejeita; null quando o binário ou a versão não se determinam.
 */
export async function warmCodexCliVersion(bin = 'codex'): Promise<string | null> {
  const selected = resolveCliBinary(bin);
  return selected
    ? probeCliBinaryVersion(selected.binPath, resolveLoginShellPath(), 'codex')
    : null;
}

/**
 * Leitura só de cache da versão do Codex selecionado (B1/F-787): sem
 * `execFileSync`, sem sonda própria, sem esperar. Cache frio = `null`. Serve à
 * telemetria do spawn, que nunca pode custar um subprocesso; quem decide a
 * flag usa `resolveCodexCliVersion` depois de `settleCodexCliVersionForSpawn`.
 */
export function peekCodexCliVersion(bin = 'codex'): string | null {
  const selected = resolveCliBinary(bin);
  if (!selected) return null;
  return cachedCliBinaryVersion(selected.binPath, 'codex') ?? null;
}

/** Teto da espera do spawn do Codex por uma sonda de versão ainda em voo. */
export const CODEX_SPAWN_VERSION_WAIT_MS = 2_000;

/** O que o spawn precisa saber do adapter para decidir se espera. */
export interface CodexSpawnVersionAdapter {
  readonly id: string;
  readonly bin: string;
  readonly quirks?: { readonly nexusMcp?: unknown };
}

/**
 * Fecha a janela do boot (F-790/F-764): enquanto o aquecimento não terminou, a
 * versão do Codex é "desconhecida" e o pane nasceria SEM
 * `--dangerously-bypass-hook-trust`, caindo na revisão de hooks. Quem decide o
 * spawn do Codex chama isto ANTES do preparo e aguarda a promessa devolvida.
 *
 * - Devolve `null` — nada a esperar — para qualquer CLI que não seja do sabor
 *   codex (a flag só existe aí) e quando a versão da instalação escolhida já
 *   está em cache e não há sonda em voo (o caso de sempre, depois do boot).
 * - Senão, aguarda as sondas daquela instalação (e das duplicadas do PATH) com
 *   o teto `timeoutMs`. Concluiu: refaz o cache de binários — o spawn e o gate
 *   enxergam a mesma instalação — e a próxima leitura do gate já sabe a
 *   versão. Estourou o teto: segue como hoje (versão desconhecida, sem a
 *   flag); a sonda termina em segundo plano e alimenta o cache.
 * Nunca rejeita e não faz chamada síncrona nova: só lê o cache.
 */
export function settleCodexCliVersionForSpawn(
  adapter: CodexSpawnVersionAdapter,
  timeoutMs = CODEX_SPAWN_VERSION_WAIT_MS,
): Promise<void> | null {
  if (adapter.quirks?.nexusMcp !== 'codex') return null;
  const selected = resolveCliBinary(adapter.bin);
  if (!selected) return null;
  if (
    cachedCliBinaryVersion(selected.binPath, 'codex') !== undefined &&
    !hasCliVersionProbesInFlight()
  ) {
    return null;
  }
  return waitForCodexCliVersion(adapter, selected.binPath, timeoutMs);
}

async function waitForCodexCliVersion(
  adapter: CodexSpawnVersionAdapter,
  binPath: string,
  timeoutMs: number,
): Promise<void> {
  const warming = Promise.all([
    warmCliBinaryVersions({ commands: [adapter.bin], alsoSingle: [adapter.bin] }),
    // A instalação escolhida é sondada de qualquer jeito: adapter de usuário
    // com `bin` fora do catálogo de CLIs de IA também alimenta o gate.
    probeCliBinaryVersion(binPath, resolveLoginShellPath(), 'codex'),
  ]).then(
    () => true,
    () => false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    warming,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (settled) {
    // O cache de binários pode ter sido montado antes das versões chegarem.
    try {
      resolveAdapterBinary(adapter.id);
    } catch {
      /* O spawn refaz a resolução por conta própria. */
    }
    return;
  }
  console.warn(
    `[codex] versão do Codex ainda não conhecida após ${timeoutMs} ms; ` +
      'o spawn segue sem a flag de confiança de hooks',
  );
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

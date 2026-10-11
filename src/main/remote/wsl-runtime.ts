/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/desktop/src/wsl/DesktopWslBackend.ts.
 * Nexus changes: Nexus pure argv/path/env planner with validated Bash exports and distro credential-slot label. No upstream Electron bridge, PTY execution, Windows run, or credential-isolation proof is copied.
 */
import {
  parseWslUncPath,
  toLinuxPath,
  toWindowsWslUncPath,
} from '../../shared/wsl-paths';
import { detectWslFromEnv, type WslPresence } from './wsl-detect';

/**
 * Backend WSL (item T3 / F-1041): executor de runtime em distro.
 *
 * Primeiro corte sem Windows real: planeja o argv do `wsl.exe`, isola o slot
 * de credencial por distro e valida o contrato de caminho. O PTY em distro e
 * a prova em Windows entram por cima desta interface — aqui não há
 * `execFileSync` de `wsl.exe` de propósito (o ratchet F-764 o recusa).
 */

export interface WslRuntimePlan {
  readonly distro: string;
  /** argv pronto para `wsl.exe` (sem o binário). */
  readonly argv: readonly string[];
  /** Cwd Linux dentro da distro. */
  readonly linuxCwd: string;
  /** Caminho UNC no host Windows para o mesmo cwd (quando derivável). */
  readonly windowsUncCwd: string | null;
  /** Slot de credencial: uma conta por distro, nunca compartilhada. */
  readonly credentialSlot: string;
}

export interface WslRuntimePlanInput {
  readonly distro: string;
  /** Cwd no host (Windows `C:\…` ou UNC `\\wsl.localhost\…`). */
  readonly hostCwd: string;
  /** Comando POSIX a rodar dentro da distro. */
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Nome seguro para o slot de credencial (sem path separators). */
export function wslCredentialSlot(distro: string): string {
  const trimmed = distro.trim();
  if (trimmed.length === 0) throw new Error('wsl distro is required');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    throw new Error(`wsl distro name is not a safe credential slot: ${distro}`);
  }
  return `wsl:${trimmed}`;
}

/**
 * Monta o argv do `wsl.exe` para rodar `command` em `distro` com cwd.
 * Ordem (estável, testada): `-d`, `--cd`, `--exec`, shell `-lc`, comando.
 * `--exec` entrega o argv ao binário, sem o shell padrão da distro.
 */
export function planWslRuntime(input: WslRuntimePlanInput): WslRuntimePlan {
  const distro = input.distro.trim();
  if (distro.length === 0) throw new Error('wsl distro is required');
  if (input.command.length === 0) throw new Error('wsl command is required');
  const unc = parseWslUncPath(input.hostCwd);
  // O componente da distro no UNC já é case-insensitive em wsl-paths.
  if (unc && unc.distro.toLowerCase() !== distro.toLowerCase()) {
    throw new Error(
      `wsl unc distro ${unc.distro} does not match selected distro ${distro}`,
    );
  }
  const linuxCwd = unc ? unc.linuxPath : toLinuxPath(input.hostCwd);
  const windowsUncCwd = toWindowsWslUncPath(linuxCwd, distro);
  const quoted = input.command.map(quotePosix).join(' ');
  const script = `${validatedEnvPrefix(input.env)}${quoted}`;
  const argv = [
    '-d',
    distro,
    '--cd',
    linuxCwd,
    '--exec',
    'bash',
    '-lc',
    script,
  ];
  return {
    distro,
    argv,
    linuxCwd,
    windowsUncCwd: windowsUncCwd || null,
    credentialSlot: wslCredentialSlot(distro),
  };
}

/** Atribuições pedidas entram no `bash -lc`. Nome inseguro não é descartado. */
function validatedEnvPrefix(
  env: Readonly<Record<string, string>> | undefined,
): string {
  if (!env) return '';
  const assignments: string[] = [];
  for (const [rawKey, value] of Object.entries(env)) {
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new Error(`wsl env name is not safe: ${rawKey}`);
    }
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      throw new Error(`wsl env value is not safe: ${key}`);
    }
    assignments.push(`export ${key}=${quotePosix(value)}`);
  }
  return assignments.length === 0 ? '' : `${assignments.join('; ')}; `;
}

function quotePosix(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Disponibilidade do runtime: presença de WSL no ambiente + nome de distro
 * utilizável. Não spawna `wsl.exe` — a lista de distros vem do IPC
 * `host.wsl.listDistros` quando o host é Windows.
 */
function isWindowsHostEnv(env: NodeJS.ProcessEnv): boolean {
  return (env.OS ?? '').toLowerCase().includes('windows') || Boolean(env.SystemRoot);
}

export function isWslRuntimeUsable(
  distro: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WslPresence & { readonly distroSlot: string | null } {
  const presence = detectWslFromEnv(env);
  const windowsHost = isWindowsHostEnv(env);
  if (!presence.available && !windowsHost) {
    return { ...presence, distroSlot: null };
  }
  if (!distro || distro.trim().length === 0) {
    if (presence.available) {
      return {
        available: false,
        reason: 'wsl-present-distro-missing',
        distroSlot: null,
      };
    }
    return { ...presence, distroSlot: null };
  }
  let distroSlot: string;
  try {
    distroSlot = wslCredentialSlot(distro);
  } catch {
    return {
      available: false,
      reason: 'wsl-distro-name-unsafe',
      distroSlot: null,
    };
  }
  if (presence.available) {
    return { available: true, reason: presence.reason, distroSlot };
  }
  // Electron no Windows não tem WSL_DISTRO_NAME. A distro já validada veio
  // de host.wsl.listDistros — essa lista é a prova de disponibilidade.
  return {
    available: true,
    reason: 'windows-host-listed-distro',
    distroSlot,
  };
}

/**
 * F-1168 B5: embrulha um spawn `{file, args}` para rodar DENTRO de uma
 * distro WSL. O binário vira o NOME do comando (o `claude.cmd`/`codex.exe`
 * resolvido no Windows não existe na distro; o `bash -lc` acha o binário
 * Linux pelo PATH da distro). As variáveis da sessão atravessam por
 * `WSLENV` — pelo ambiente, nunca pelo argv do `wsl.exe`, que qualquer
 * processo do usuário lê.
 */
export function wrapSpawnForWsl(input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly distro: string | null | undefined;
  /** Nomes de variáveis da sessão a repassar para dentro da distro. */
  readonly forwardEnvNames?: readonly string[];
  /** `WSLENV` atual do processo, preservado na frente. */
  readonly currentWslEnv?: string;
}): { readonly file: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  const distro = input.distro?.trim();
  if (!distro) {
    return { file: input.file, args: [...input.args], env: {} };
  }
  const plan = planWslRuntime({
    distro,
    hostCwd: input.cwd,
    command: [linuxCommandName(input.file), ...input.args],
  });
  const names = new Set((input.currentWslEnv ?? '').split(':').filter(Boolean));
  for (const name of input.forwardEnvNames ?? []) {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && !HOST_ONLY_ENV.has(name.toUpperCase())) names.add(name);
  }
  return { file: 'wsl.exe', args: [...plan.argv], env: names.size ? { WSLENV: [...names].join(':') } : {} };
}

/**
 * Variáveis do host Windows que nunca entram na distro: o PATH/HOME do
 * Windows quebrariam o shell Linux, e o resto descreve só o host.
 */
const HOST_ONLY_ENV = new Set([
  'WSLENV', 'PATH', 'PATHEXT', 'HOME', 'USER', 'USERNAME', 'SHELL', 'PWD', 'OLDPWD', 'TMP', 'TEMP', 'TMPDIR',
  'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMDATA', 'PROGRAMFILES',
  'PSMODULEPATH', 'NODE_OPTIONS', 'NEXUS_WSL_DISTRO',
]);

/** `C:\…\npm\claude.cmd` → `claude`. Nome sem caminho passa como veio. */
export function linuxCommandName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const name = base.replace(/\.(cmd|bat|exe|ps1|com)$/i, '');
  if (!name) throw new Error('wsl command name is empty');
  return name;
}

/** Distro da sessão atual, quando o runtime é `wsl`. */
export function wslDistroFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env.NEXUS_WSL_DISTRO?.trim();
  return value && value.length > 0 ? value : null;
}

/** Validade da lista de distros: o bastante para rajadas de aparelhos. */
export const WSL_DISTRO_LIST_TTL_MS = 30_000;

/**
 * Lister de distros com cache e pedido em voo compartilhado. `run` devolve
 * a saída do `wsl.exe -l -q` (UTF-16 com NULs) ou `null` em erro; erro não
 * fica em cache.
 */
export function createWslDistroLister(deps: {
  readonly platform: NodeJS.Platform;
  readonly run: () => Promise<string | null>;
  readonly now?: () => number;
}): () => Promise<string[]> {
  const now = deps.now ?? Date.now;
  let cached: { at: number; distros: string[] } | null = null;
  let inFlight: Promise<string[]> | null = null;
  return async () => {
    if (deps.platform !== 'win32') return [];
    if (cached && now() - cached.at < WSL_DISTRO_LIST_TTL_MS) return [...cached.distros];
    inFlight ??= deps.run().then((stdout) => {
      if (stdout === null) return [];
      const distros = stdout.split(/\r?\n/).map((line) => line.replace(/\0/g, '').trim()).filter((line) => line.length > 0);
      cached = { at: now(), distros };
      return distros;
    }).catch(() => []).finally(() => { inFlight = null; });
    return [...await inFlight];
  };
}

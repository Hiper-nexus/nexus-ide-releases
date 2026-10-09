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
 * distro WSL. O binário original vira o comando POSIX do `wsl.exe`.
 * `env.NEXUS_WSL_DISTRO` (setado pelo runtime da sessão) dispara o embrulho;
 * sem distro o spawn passa intacto.
 */
export function wrapSpawnForWsl(input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly distro: string | null | undefined;
}): { readonly file: string; readonly args: readonly string[] } {
  const distro = input.distro?.trim();
  if (!distro) {
    return { file: input.file, args: [...input.args] };
  }
  const plan = planWslRuntime({
    distro,
    hostCwd: input.cwd,
    command: [input.file, ...input.args],
  });
  return { file: 'wsl.exe', args: [...plan.argv] };
}

/** Distro da sessão atual, quando o runtime é `wsl`. */
export function wslDistroFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env.NEXUS_WSL_DISTRO?.trim();
  return value && value.length > 0 ? value : null;
}

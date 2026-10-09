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
  const linuxCwd = unc ? unc.linuxPath : toLinuxPath(input.hostCwd);
  const windowsUncCwd = toWindowsWslUncPath(linuxCwd, distro);
  const quoted = input.command.map(quotePosix).join(' ');
  const argv = [
    '-d',
    distro,
    '--cd',
    linuxCwd,
    '--exec',
    'bash',
    '-lc',
    quoted,
  ];
  return {
    distro,
    argv,
    linuxCwd,
    windowsUncCwd: windowsUncCwd || null,
    credentialSlot: wslCredentialSlot(distro),
  };
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

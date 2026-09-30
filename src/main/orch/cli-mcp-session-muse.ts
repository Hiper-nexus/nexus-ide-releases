/**
 * Muse Code (`muse`) recebe o MCP do Nexus (F-696).
 *
 * Medido no Muse Code 1.4.1 (Windows, 30/09): o CLI lê servidores MCP de
 * `mcpServers` no `settings.json` do usuário (`$XDG_CONFIG_HOME/muse`, padrão
 * `~/.config/muse`) e herda o próprio ambiente nos servidores stdio. Teste de
 * ponta a ponta com `muse exec`: a ponte stdio do Nexus fez `initialize`,
 * `tools/list` e `tools/call` com o bearer da sessão e o Muse devolveu o
 * resultado da ferramenta. `bearer_token_env_var` e `${VAR}` em `headers` NÃO
 * funcionam nesta versão (o header sai vazio ou literal).
 *
 * Por isso, igual ao MiniMax (F-678): uma entrada `nexus` → ponte stdio
 * compartilhada, registrada uma vez por mescla (servidores do usuário
 * intactos); URL e bearer da sessão só por ENV. Fora do Nexus a ponte
 * responde zero ferramentas e o Muse segue normal. Muse anterior ao 1.4 não
 * tem MCP: o arquivo não é tocado e o pane segue sem o MCP.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveCliBinary } from '../path-resolver';
import {
  ensureNexusMcpBridgeScript,
  readJsonObject,
  writeFileAtomic,
} from './cli-mcp-session-minimax';

export const MUSE_NEXUS_MCP_SERVER = 'nexus';
const MUSE_MCP_MIN_VERSION: readonly [number, number, number] = [1, 4, 0];

export function museSettingsPath(
  home = os.homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  const base = xdgConfigHome?.trim() ? xdgConfigHome.trim() : path.join(home, '.config');
  return path.join(base, 'muse', 'settings.json');
}

export function parseMuseVersion(output: string): string | null {
  const match = /Muse Code\s+(\d+)\.(\d+)\.(\d+)/iu.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function museSupportsMcp(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const actual = parts[index] ?? 0;
    const minimum = MUSE_MCP_MIN_VERSION[index]!;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

let cachedVersion: string | null | undefined;

/** `muse --version`, memorizado por processo; `null` quando não dá para ler. */
export function resolveMuseVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  const bin = resolveCliBinary('muse')?.binPath ?? 'muse';
  try {
    cachedVersion = parseMuseVersion(
      execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
        windowsHide: true,
        // O `muse.cmd` do Windows chama o launcher PowerShell do Muse.
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(bin),
      }),
    );
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

export function resetMuseVersionCacheForTests(): void {
  cachedVersion = undefined;
}

export interface MuseMcpRegistrationOptions {
  readonly home?: string;
  readonly xdgConfigHome?: string;
  readonly nodePath?: string;
  /** Versão já lida; omitida, o spawn roda `muse --version` uma vez. */
  readonly museVersion?: string | null;
}

/**
 * Garante a ponte e a entrada `nexus` em `mcpServers` do `settings.json` do
 * Muse. Idempotente: só grava quando muda. `settings.json` ilegível nunca é
 * sobrescrito — o pane segue sem o MCP em vez de apagar config do usuário.
 */
export function ensureMuseNexusMcpRegistration(
  options: MuseMcpRegistrationOptions = {},
): { registered: boolean; reason?: string } {
  const version = options.museVersion !== undefined ? options.museVersion : resolveMuseVersion();
  if (!museSupportsMcp(version)) {
    return {
      registered: false,
      reason: `Muse Code ${version ?? 'desconhecido'} sem MCP (precisa de 1.4+) — settings.json não foi alterado`,
    };
  }
  const home = options.home ?? os.homedir();
  const bridge = ensureNexusMcpBridgeScript(home);
  const settingsPath = museSettingsPath(home, options.xdgConfigHome);
  const document = readJsonObject(settingsPath);
  if (document === null) {
    return { registered: false, reason: 'settings.json do Muse ilegível — não foi alterado' };
  }
  const servers =
    document.mcpServers && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)
      ? (document.mcpServers as Record<string, unknown>)
      : {};
  const command = options.nodePath ?? resolveCliBinary('node')?.binPath ?? 'node';
  const entry = { command, args: [bridge] };
  if (JSON.stringify(servers[MUSE_NEXUS_MCP_SERVER]) === JSON.stringify(entry)) {
    return { registered: true };
  }
  const next = { ...document, mcpServers: { ...servers, [MUSE_NEXUS_MCP_SERVER]: entry } };
  writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { registered: true };
}

/** ENV do pane Muse: a ponte registrada lê a sessão daqui. */
export function prepareMuseMcpSession(
  mcpUrl: string,
  token: string,
  options: MuseMcpRegistrationOptions = {},
): { env: Record<string, string>; registered: boolean; reason?: string } {
  const registration = ensureMuseNexusMcpRegistration(options);
  return {
    env: registration.registered ? { NEXUS_MCP_URL: mcpUrl, NEXUS_MCP_TOKEN: token } : {},
    ...registration,
  };
}

/**
 * Muse Code (`muse`) recebe o MCP do Nexus (F-696).
 *
 * Medido no Muse Code 1.4.1 (Windows, 30/09): o CLI lê servidores MCP de
 * `mcpServers` no `settings.json` do usuário (`$XDG_CONFIG_HOME/muse`, padrão
 * `~/.config/muse`). Teste de ponta a ponta com `muse exec`: a ponte stdio
 * do Nexus fez `initialize`, `tools/list` e `tools/call` levando a sessão, e
 * o Muse devolveu o resultado da ferramenta. `bearer_token_env_var` e
 * `${VAR}` em `headers` NÃO funcionam nesta versão (o header sai vazio ou
 * literal).
 *
 * F-1338 (medido no Muse Code 1.4.4, macOS, 12/10): o CLI NÃO repassa o
 * ambiente do processo aos servidores stdio — a ponte nascia sem a sessão e
 * respondia zero ferramentas, e o pane ficava sem o MCP do Nexus mesmo com
 * entrada registrada e ENV do pane correto. Por isso URL e sessão viajam no
 * `env` da própria entrada `nexus` (único canal que o CLI entrega ao
 * servidor, provado com servidor marcador: `env` da entrada chega,
 * ambiente do processo não).
 *
 * Por isso, igual ao MiniMax (F-678): uma entrada `nexus` → ponte stdio
 * compartilhada, registrada uma vez por mescla (servidores do usuário
 * intactos). Sem sessão a ponte responde zero ferramentas e o Muse segue
 * normal. Muse anterior ao 1.4 não tem MCP: o arquivo não é tocado e o pane
 * segue sem o MCP.
 *
 * Segurança: a entrada carrega a sessão do pane, então o `settings.json`
 * é travado em 0600 sempre que a registramos. A sessão é por pane e
 * revogada no teardown; cada spawn regenera a entrada com a sessão viva.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliBinary } from '../path-resolver';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkDirectoryEntries,
  withCliMcpArtifactTransaction,
} from './cli-mcp-session-artifacts';
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

/** Sessão MCP do pane: viaja no `env` da entrada, nunca no ambiente. */
export interface MuseMcpSession {
  readonly url: string;
  readonly token: string;
}

export interface MuseMcpRegistrationOptions {
  readonly home?: string;
  readonly xdgConfigHome?: string;
  readonly nodePath?: string;
  /** Versão já lida; omitida, o spawn roda `muse --version` uma vez. */
  readonly museVersion?: string | null;
  /**
   * Sessão do pane (F-1338: sem ela a entrada é inútil — o CLI não repassa
   * o ambiente do processo ao servidor). Ausente, nada é registrado.
   */
  readonly session?: MuseMcpSession;
}

/**
 * Garante a ponte e a entrada `nexus` em `mcpServers` do `settings.json` do
 * Muse. Idempotente: só grava quando muda. `settings.json` ilegível nunca é
 * sobrescrito — o pane segue sem o MCP em vez de apagar config do usuário.
 * Como a entrada carrega a sessão do pane, o arquivo é travado em 0600.
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
  if (!options.session) {
    return {
      registered: false,
      reason: 'sessão MCP ausente — sem URL/sessão no env da entrada a ponte responde zero ferramentas (F-1338)',
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
  const entry = {
    command,
    args: [bridge],
    env: { NEXUS_MCP_URL: options.session.url, NEXUS_MCP_TOKEN: options.session.token },
  };
  if (JSON.stringify(servers[MUSE_NEXUS_MCP_SERVER]) === JSON.stringify(entry)) {
    lockMuseSettingsPermissions(settingsPath);
    return { registered: true };
  }
  let previous: string | null = null;
  try {
    previous = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    previous = null;
  }
  // F-1338: o Muse 1.4.4 recusa o arquivo inteiro sem `schema_version`
  // ("malformed settings file"); preserva o existente, assume 1 ao criar.
  const next = { schema_version: 1, ...document, mcpServers: { ...servers, [MUSE_NEXUS_MCP_SERVER]: entry } };
  writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // Fail-closed: sem o 0600 a sessão ficaria legível para outros usuários
    // da máquina — desfaz a escrita e o pane segue sem o MCP.
    try {
      if (previous === null) fs.rmSync(settingsPath, { force: true });
      else writeFileAtomic(settingsPath, previous);
    } catch {
      // Melhor esforço; o motivo abaixo continua valendo.
    }
    return { registered: false, reason: 'settings.json do Muse sem 0600 — entrada com sessão não foi mantida' };
  }
  return { registered: true };
}

/** 0600 no melhor esforço (entrada legada já registrada por versão anterior). */
function lockMuseSettingsPermissions(settingsPath: string): void {
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // Melhor esforço; a sessão da entrada segue válida para o pane vivo.
  }
}

/**
 * F-1338 (revisão Fable): a entrada carrega a sessão do pane, então NUNCA vai
 * para o `settings.json` compartilhado — dois panes Muse em paralelo trocavam
 * o token (o que bootava depois lia a sessão do outro). Cada pane ganha um
 * `XDG_CONFIG_HOME` próprio (padrão do OpenCode): links para tudo do config
 * real (git, gh… e `muse/auth.json`), mais um `muse/settings.json` privado
 * (cópia do real + entrada `nexus` com a sessão deste pane, 0600). Login novo
 * feito no pane volta ao perfil real no teardown; o settings privado, nunca.
 */
export interface MuseMcpSessionOptions extends MuseMcpRegistrationOptions {
  readonly artifactRoot?: string;
}

/** Sessão do pane Muse: viaja no `env` da entrada; o ENV do pane é redundância. */
export function prepareMuseMcpSession(
  mcpUrl: string,
  token: string,
  options: MuseMcpSessionOptions = {},
): { env: Record<string, string>; registered: boolean; reason?: string } {
  const version = options.museVersion !== undefined ? options.museVersion : resolveMuseVersion();
  if (!museSupportsMcp(version)) {
    return {
      env: {},
      registered: false,
      reason: `Muse Code ${version ?? 'desconhecido'} sem MCP (precisa de 1.4+) — settings.json não foi alterado`,
    };
  }
  const home = path.resolve(options.home ?? os.homedir());
  const realConfig = path.dirname(path.dirname(museSettingsPath(home, options.xdgConfigHome)));
  const artifactRoot = path.resolve(options.artifactRoot ?? path.join(home, '.nexus', 'ephemeral', 'mcp-clients'));
  let reason: string | undefined;
  try {
    const configHome = withCliMcpArtifactTransaction('muse', token, artifactRoot, (artifactDir) => {
      linkDirectoryEntries(realConfig, artifactDir, new Set(['muse']));
      const museDir = path.join(artifactDir, 'muse');
      ensurePrivateDirectory(museDir);
      linkDirectoryEntries(path.join(realConfig, 'muse'), museDir, new Set(['settings.json']));
      const realSettings = path.join(realConfig, 'muse', 'settings.json');
      if (fs.existsSync(realSettings)) {
        fs.copyFileSync(realSettings, path.join(museDir, 'settings.json'));
      }
      const registration = ensureMuseNexusMcpRegistration({
        ...options,
        museVersion: version,
        home,
        xdgConfigHome: artifactDir,
        session: { url: mcpUrl, token },
      });
      if (!registration.registered) {
        reason = registration.reason;
        throw new Error('muse_session_not_registered');
      }
      activateArtifact(token, {
        artifactDir,
        providerHome: realConfig,
        configFiles: [],
        // Só o settings privado carrega a sessão: ele nunca volta ao perfil real.
        syncBackExcludeAnywhere: new Set(['settings.json']),
        syncBack: true,
      });
      return artifactDir;
    });
    return {
      env: { XDG_CONFIG_HOME: configHome, NEXUS_MCP_URL: mcpUrl, NEXUS_MCP_TOKEN: token },
      registered: true,
    };
  } catch (error) {
    return {
      env: {},
      registered: false,
      reason: reason ?? `config privado do Muse falhou: ${(error as NodeJS.ErrnoException).code ?? 'erro'}`,
    };
  }
}

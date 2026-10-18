/**
 * Qwen Code (`qwen`) recebe o MCP do Nexus por `--mcp-config` (F-238).
 *
 * Qwen é fork do Gemini CLI: `QWEN_HOME` aponta o home da CLI (settings,
 * sessões, MCP). A credencial do operador vive em `settings.json`
 * (`env.BAILIAN_TOKEN_PLAN_API_KEY` + `modelProviders`) — sem injeção do
 * Nexus o overlay LIGA o arquivo, nunca copia o segredo para outro lugar.
 * F-1567: quando o spawn injeta a chave configurada (vault/conta), a CLI só a
 * honra se um `modelProviders[].envKey` apontar para ela — então o overlay
 * grava um settings.json de usuário MESCLADO (o do operador SEM as credenciais
 * Alibaba dele + as entradas com envKey e a base URL resolvida) em vez de
 * ligar, e um settings de SISTEMA à parte (`system-settings.json`) com SÓ o que
 * o Nexus impõe por cima do workspace (o catálogo gerado + endurecimento),
 * sobre o settings de sistema real do admin. O resto do operador fica no layer
 * de usuário, então a precedência user<workspace da CLI não muda. O MCP
 * da sessão chega por
 * um arquivo JSON privado (`{"mcpServers": …}`) referenciado por
 * `--mcp-config`; a ponte stdio compartilhada (`~/.nexus/mcp-bridge`) recebe
 * URL e bearer só por ENV (`NEXUS_MCP_URL`/`NEXUS_MCP_TOKEN`), como MiniMax
 * (F-678) e Muse (F-696). `--allowed-mcp-server-names` restringe os
 * servidores: worker de missão (governed) recebe só o `nexus` + hub do
 * workspace — o `mcpServers` ambiente do operador (ex.: blender) não entra.
 *
 * Conversas (`sessions`, `projects`, `todos`, `file-history`, `tmp`, `debug`,
 * `artifacts`, `usage`) ficam em `<userData>/provider-state/qwen/<checkoutId>`
 * (F-566); sync-back é desligado — nada volta ao perfil real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeQwenSettingsForInjection,
  mergeQwenSystemSettingsForInjection,
  qwenSystemSettingsPaths,
  readQwenOperatorSettings,
  readQwenSystemSettings,
} from '../adapters/qwen-settings';
import {
  activateArtifact,
  linkDirectoryEntries,
  linkProviderSessionState,
  linkSelectedEntries,
  objectValue,
  runtimeServerName,
  validateCliMcpInputs,
  withCliMcpArtifactTransaction,
  writePrivateFileAtomic,
} from './cli-mcp-session-artifacts';
import { mirrorGovernedSkills } from './cli-mcp-session-governance';
import type {
  CliMcpSessionOptions,
  CliMcpSessionResult,
} from './cli-mcp-session-types';
import { resolveGovernedCliProfile } from './governed-cli-profile';
import { claudeFamilyHubMcpServers } from '../mcp-hub/mcp-hub-spawn';
import { ensureNexusMcpBridgeScript } from './cli-mcp-session-minimax';
import { resolveCliBinary } from '../path-resolver';

/**
 * Estado de conversa do Qwen: isolado por checkout. `memories` fica do lado
 * da config (são memórias do operador, não transcript de sessão).
 */
const QWEN_SESSION_DIRECTORIES = [
  'sessions',
  'projects',
  'todos',
  'file-history',
  'tmp',
  'debug',
  'artifacts',
  'usage',
];
const QWEN_SESSION_FILES = {
  'usage_record.jsonl': '',
  'tip_history.json': '',
};
const QWEN_SESSION_ENTRIES = [
  ...QWEN_SESSION_DIRECTORIES,
  ...Object.keys(QWEN_SESSION_FILES),
];

/**
 * Único material de credencial do Qwen: `settings.json` guarda
 * `env.BAILIAN_TOKEN_PLAN_API_KEY` e o catálogo `modelProviders`. Ligado,
 * nunca copiado — a própria CLI lê/atualiza no lugar. (Com a chave do Nexus
 * injetada o overlay não liga: grava a cópia mesclada, sem essas credenciais.)
 */
const QWEN_AUTH_ENTRIES = ['settings.json', 'installation_id'];

/** Layer de SISTEMA do pane com injeção (F2/F3): só o que o Nexus impõe. */
const QWEN_SYSTEM_SETTINGS_FILE = 'system-settings.json';

interface QwenMcpSessionOptions extends CliMcpSessionOptions {
  /**
   * Onde a Qwen Code leria o settings de SISTEMA e os defaults de sistema deste
   * pane se o Nexus não os redirecionasse (`QWEN_CODE_SYSTEM_SETTINGS_PATH` /
   * `QWEN_CODE_SYSTEM_DEFAULTS_PATH` do env já preparado). Ausentes: o padrão da
   * plataforma. Só a injeção do F-1567 os lê; o admin do operador não se perde.
   */
  qwenSystemSettingsPath?: string;
  qwenSystemDefaultsPath?: string;
}

function qwenAuthGrantPaths(providerHome: string): string[] {
  const found: string[] = [];
  for (const name of QWEN_AUTH_ENTRIES) {
    const candidate = path.join(providerHome, name);
    try {
      if (fs.statSync(candidate)) found.push(candidate);
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Overlay `QWEN_HOME` por sessão: config/credencial ligada do perfil real,
 * conversas no provider-state do checkout, e `mcp-config.json` privado com o
 * servidor `nexus` (ponte stdio) + hub — MCP ambiente do operador só entra em
 * pane não-governado.
 */
export function prepareQwenMcpSession(
  url: string,
  token: string,
  options: QwenMcpSessionOptions = {},
): CliMcpSessionResult {
  validateCliMcpInputs(url, token);
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ?? process.env.QWEN_HOME ?? path.join(home, '.qwen'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  return withCliMcpArtifactTransaction('qwen', token, artifactRoot, (artifactDir) => {
    const serverName = runtimeServerName(token);
    const policy = resolveGovernedCliProfile(token, options);
    const injection = options.qwenSettingsInjection;
    // O settings do operador só é lido onde alguém precisa dele: a mescla da
    // injeção e o MCP ambiente de pane não-governado. Worker governado sem
    // injeção só LIGA o arquivo e nunca o abre; e a leitura tolera o que a CLI
    // aceita (comentários, BOM) ou não deixa abrir (EACCES) — vira `{}`.
    const operatorSettings =
      injection || !policy.governed
        ? readQwenOperatorSettings(path.join(providerHome, 'settings.json'))
        : {};
    // F-1567: com chave injetada pelo Nexus o settings.json do overlay é
    // ESCRITO (mescla o do operador com as entradas modelProviders que
    // apontam a env para a base URL certa) em vez de ligado — a CLI ignora a
    // env BAILIAN sem essas entradas e usava o apiKey velho embutido (401).
    // O que o Nexus IMPÕE por cima do workspace vai num arquivo de SISTEMA à
    // parte, sobre o settings de sistema real do admin (F2/F3): apontar
    // `QWEN_CODE_SYSTEM_SETTINGS_PATH` para a cópia inteira do operador
    // invertia a precedência user<workspace e derrubava a política do admin.
    const systemSettingsFile = path.join(artifactDir, QWEN_SYSTEM_SETTINGS_FILE);
    let systemDefaultsPath: string | null = null;
    if (injection) {
      const merged = mergeQwenSettingsForInjection(operatorSettings, injection);
      writePrivateFileAtomic(
        path.join(artifactDir, 'settings.json'),
        `${JSON.stringify(merged, null, 2)}\n`,
      );
      const adminPaths = qwenSystemSettingsPaths({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: options.qwenSystemSettingsPath,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: options.qwenSystemDefaultsPath,
      });
      systemDefaultsPath = adminPaths.defaults;
      writePrivateFileAtomic(
        systemSettingsFile,
        `${JSON.stringify(
          mergeQwenSystemSettingsForInjection(readQwenSystemSettings(adminPaths.settings), merged, injection),
          null,
          2,
        )}\n`,
      );
    }
    const linkExclusions = new Set(
      injection ? [...QWEN_SESSION_ENTRIES, 'settings.json', QWEN_SYSTEM_SETTINGS_FILE] : QWEN_SESSION_ENTRIES,
    );
    if (policy.governed) {
      linkSelectedEntries(
        providerHome,
        artifactDir,
        new Set(
          injection
            ? QWEN_AUTH_ENTRIES.filter((name) => name !== 'settings.json')
            : QWEN_AUTH_ENTRIES,
        ),
      );
    } else {
      linkDirectoryEntries(providerHome, artifactDir, linkExclusions);
    }
    const providerSessionHome = linkProviderSessionState(
      'qwen',
      artifactDir,
      options,
      QWEN_SESSION_DIRECTORIES,
      QWEN_SESSION_FILES,
    );

    const bridge = ensureNexusMcpBridgeScript(home);
    const command = resolveCliBinary('node')?.binPath ?? 'node';
    const hub = claudeFamilyHubMcpServers(options.hubServers ?? []);
    // MCP ambiente do operador (settings.json do perfil real): pane direto
    // preserva; worker governado nunca recebe (política Codex gated).
    const ambient = policy.governed
      ? {}
      : objectValue(operatorSettings.mcpServers);
    const servers = {
      ...ambient,
      ...hub,
      [serverName]: { type: 'stdio', command, args: [bridge] },
    };
    writePrivateFileAtomic(
      path.join(artifactDir, 'mcp-config.json'),
      `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    );

    const governedSkillsDir = path.join(artifactDir, 'skills');
    if (policy.governed) {
      mirrorGovernedSkills(
        'qwen',
        home,
        [governedSkillsDir],
        policy.allowedSkills,
        policy.allowedTools,
      );
    }
    activateArtifact(token, {
      artifactDir,
      providerHome,
      // settings.json é symlink para o perfil real (ou, com injeção F-1567,
      // uma cópia mesclada efêmera) — sync-back é sempre off: nem conversas
      // nem o arquivo de credencial voltam por cópia.
      configFiles: [],
      syncBack: false,
    });
    const allowed = policy.governed
      ? [serverName, ...Object.keys(hub)]
      : Object.keys(servers);
    // Com injeção o settings.json real não é ligado: o grant de escrita nele
    // sai, e a cópia do overlay vive dentro do artifactDir (gravável pelo pane).
    const authGrantPaths = policy.governed
      ? injection
        ? qwenAuthGrantPaths(providerHome).filter(
            (grant) => path.basename(grant) !== 'settings.json',
          )
        : qwenAuthGrantPaths(providerHome)
      : [];
    return {
      env: {
        QWEN_HOME: artifactDir,
        // Os defaults de sistema andam ao lado do arquivo de sistema: redirecionar
        // um sem fixar o outro derrubaria o `system-defaults.json` do admin.
        ...(systemDefaultsPath
          ? {
              QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettingsFile,
              QWEN_CODE_SYSTEM_DEFAULTS_PATH: systemDefaultsPath,
            }
          : {}),
        NEXUS_MCP_URL: url,
        NEXUS_MCP_TOKEN: token,
      },
      extraArgs: [
        '--mcp-config',
        path.join(artifactDir, 'mcp-config.json'),
        '--allowed-mcp-server-names',
        ...allowed,
      ],
      serverName,
      artifactDir,
      ...(policy.governed
        ? {
            providerStateReadPaths: authGrantPaths,
            providerStateWritePaths: authGrantPaths,
            providerSessionHome,
          }
        : {}),
    };
  });
}

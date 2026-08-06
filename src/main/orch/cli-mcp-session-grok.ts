import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkDirectoryEntries,
  linkSelectedEntries,
  MAX_CLI_TOML_CONFIG_DEPTH,
  objectValue,
  readTomlObject,
  runtimeServerName,
  validateCliMcpInputs,
  withCliMcpArtifactTransaction,
  writePrivateFileAtomic,
} from './cli-mcp-session-artifacts';
import {
  governedWorkspaceTiers,
  mirrorGovernedSkills,
} from './cli-mcp-session-governance';
import type {
  CliMcpSessionOptions,
  CliMcpSessionResult,
} from './cli-mcp-session-types';
import {
  resolveGovernedCliProfile,
  stripExecutableProfileConfig,
} from './governed-cli-profile';
import {
  GROK_STATUS_HOOKS_FILE,
  grokStatusHooksDocument,
} from './hook-status-config';

function governedGrokProjectPolicy(
  cwd: string | undefined,
  workspaceRoot: string | undefined,
): { ignoredSkills: string[]; disabledPlugins: string[] } {
  const ignoredSkills = new Set<string>();
  const disabledPlugins = new Set<string>();
  for (const tier of governedWorkspaceTiers(cwd, workspaceRoot)) {
    for (const relative of [
      ['.grok', 'skills'],
      ['.grok', 'commands'],
      ['.agents', 'skills'],
      ['.agents', 'commands'],
      ['.claude', 'skills'],
      ['.claude', 'commands'],
      ['.cursor', 'skills'],
    ]) {
      ignoredSkills.add(path.join(tier, ...relative));
    }
    for (const relative of [
      ['.grok', 'plugins'],
      ['.agents', 'plugins'],
      ['.claude', 'plugins'],
      ['.cursor', 'plugins'],
    ]) {
      const pluginRoot = path.join(tier, ...relative);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(pluginRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          disabledPlugins.add(entry.name);
        }
      }
    }
  }
  return {
    ignoredSkills: [...ignoredSkills],
    disabledPlugins: [...disabledPlugins],
  };
}

/**
 * Grok 0.2.93 resolves native configuration from $GROK_HOME/config.toml.
 * The private provider-home overlay symlinks auth, sessions, skills and the
 * rest of the real profile, replacing only config.toml. The config references
 * NEXUS_MCP_TOKEN, already scoped to the spawned process, so no bearer is
 * persisted in either the real profile or the ephemeral overlay.
 * The additive semantic-status hooks (emdash wave 1) ship as a Nexus-owned
 * `hooks/nexus.json` inside the overlay — the user's own hooks/ entries are
 * linked through, and nexus.json never syncs back into the real profile.
 */
export function prepareGrokMcpSession(
  url: string,
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  validateCliMcpInputs(url, token);
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ?? process.env.GROK_HOME ?? path.join(home, '.grok'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ??
      path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  return withCliMcpArtifactTransaction(
    'grok',
    token,
    artifactRoot,
    (artifactDir) => {
      const serverName = runtimeServerName(token);
      const policy = resolveGovernedCliProfile(token, options);
      const projectPolicy = governedGrokProjectPolicy(
        options.cwd,
        options.workspaceRoot,
      );
      if (policy.governed) {
        linkSelectedEntries(
          providerHome,
          artifactDir,
          new Set([
            '.metadata_version',
            'active_sessions.json',
            'agent_id',
            'auth.json',
            'auth.json.lock',
            'bundled',
            'models_cache.json',
            'projects',
            'sessions',
          ]),
        );
      } else {
        linkDirectoryEntries(
          providerHome,
          artifactDir,
          new Set(['config.toml', 'hooks']),
        );
      }
      const sourceRaw = readTomlObject(path.join(providerHome, 'config.toml'));
      const source = policy.governed
        ? stripExecutableProfileConfig(sourceRaw)
        : sourceRaw;
      const servers = policy.governed ? {} : objectValue(source.mcp_servers);
      const merged = {
        ...source,
        ...(policy.governed
          ? {
              skills: {
                paths: [path.join(artifactDir, 'skills')],
                ignore: projectPolicy.ignoredSkills,
              },
              plugins: {
                enabled: [],
                paths: [],
                disabled: projectPolicy.disabledPlugins,
              },
              compat: {
                claude: {
                  skills: false,
                  rules: false,
                  agents: false,
                  mcps: false,
                  hooks: false,
                  sessions: false,
                },
                cursor: {
                  skills: false,
                  rules: false,
                  agents: false,
                  mcps: false,
                  hooks: false,
                  sessions: false,
                },
                codex: { sessions: false },
              },
            }
          : {}),
        mcp_servers: {
          ...servers,
          [serverName]: {
            url,
            enabled: true,
            bearer_token_env_var: 'NEXUS_MCP_TOKEN',
          },
        },
      };
      writePrivateFileAtomic(
        path.join(artifactDir, 'config.toml'),
        stringify(merged, { maxDepth: MAX_CLI_TOML_CONFIG_DEPTH }),
      );
      if (policy.governed && (options.workspaceRoot || options.cwd)) {
        const trustRoot = path.resolve(options.workspaceRoot ?? options.cwd!);
        // Record an explicit deny in the private profile. This keeps project
        // hooks/MCP/LSP inert without the startup trust modal; never disable
        // Grok's trust feature (`GROK_FOLDER_TRUST=0` means allow/ungate).
        writePrivateFileAtomic(
          path.join(artifactDir, 'trusted_folders.toml'),
          stringify(
            {
              folders: {
                [trustRoot]: {
                  trusted: false,
                  decided_at: Math.floor(Date.now() / 1_000),
                },
              },
            },
            { maxDepth: MAX_CLI_TOML_CONFIG_DEPTH },
          ),
        );
      }
      // Status hooks: user entries linked through, Nexus doc written fresh.
      const overlayHooks = path.join(artifactDir, 'hooks');
      ensurePrivateDirectory(overlayHooks);
      if (!policy.governed) {
        linkDirectoryEntries(
          path.join(providerHome, 'hooks'),
          overlayHooks,
          new Set([GROK_STATUS_HOOKS_FILE]),
        );
      }
      writePrivateFileAtomic(
        path.join(overlayHooks, GROK_STATUS_HOOKS_FILE),
        `${JSON.stringify(grokStatusHooksDocument(), null, 2)}\n`,
      );
      if (policy.governed) {
        mirrorGovernedSkills(
          'grok',
          home,
          [path.join(artifactDir, 'skills')],
          policy.allowedSkills,
          policy.allowedTools,
        );
      }
      activateArtifact(token, {
        artifactDir,
        providerHome,
        configFiles: ['config.toml'],
        syncBackExcludeAnywhere: new Set([GROK_STATUS_HOOKS_FILE]),
        syncBack: !policy.governed,
      });
      let isolatedHome: string | null = null;
      if (policy.governed) {
        isolatedHome = path.join(artifactDir, '.nexus-home');
        ensurePrivateDirectory(isolatedHome);
        linkSelectedEntries(home, isolatedHome, new Set(['.gitconfig']));
      }
      return {
        env: {
          GROK_HOME: artifactDir,
          ...(isolatedHome
            ? {
                HOME: isolatedHome,
                GROK_CLAUDE_SKILLS_ENABLED: 'false',
                GROK_CLAUDE_RULES_ENABLED: 'false',
                GROK_CLAUDE_AGENTS_ENABLED: 'false',
                GROK_CURSOR_SKILLS_ENABLED: 'false',
                GROK_CURSOR_RULES_ENABLED: 'false',
                GROK_CURSOR_AGENTS_ENABLED: 'false',
                GROK_CLAUDE_MCPS_ENABLED: 'false',
                GROK_CURSOR_MCPS_ENABLED: 'false',
                GROK_CLAUDE_HOOKS_ENABLED: 'false',
                GROK_CURSOR_HOOKS_ENABLED: 'false',
              }
            : {}),
        },
        // Grok 0.2.112: hard-disable its native subagent launcher for governed
        // workers. Direct panes intentionally retain the user's full CLI.
        extraArgs: policy.governed ? ['--no-subagents'] : [],
        serverName,
        artifactDir,
        // Governed overlay symlinks provider state into GROK_HOME from the real
        // ~/.grok; the advisory sandbox must grant it read+write so session
        // writes and auth reads resolve through the symlinks.
        ...(policy.governed ? { providerStateHome: providerHome } : {}),
      };
    },
  );
}

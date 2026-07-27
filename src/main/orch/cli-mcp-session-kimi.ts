import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import {
  activateArtifact,
  linkDirectoryEntries,
  linkFile,
  linkSelectedEntries,
  MAX_CLI_TOML_CONFIG_DEPTH,
  objectValue,
  readJsonObject,
  readTomlObject,
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
import {
  resolveGovernedCliProfile,
  stripExecutableProfileConfig,
} from './governed-cli-profile';
import { mergeKimiStatusHooks } from './hook-status-config';

/**
 * Kimi officially resolves MCP from $KIMI_CODE_HOME/mcp.json. The overlay
 * symlinks all real data and adds only a private, token-free MCP declaration;
 * `bearerTokenEnvVar` reads the already session-scoped Nexus token at runtime.
 * config.toml is overlaid the same way to carry the additive semantic-status
 * hooks (emdash wave 1: flat `hooks = [{event, command}]`, marker-separated);
 * both files stay out of the auth sync-back so they never reach the real
 * profile.
 */
export function prepareKimiMcpSession(
  url: string,
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  validateCliMcpInputs(url, token);
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ??
      process.env.KIMI_CODE_HOME ??
      path.join(home, '.kimi-code'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ??
      path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  return withCliMcpArtifactTransaction(
    'kimi',
    token,
    artifactRoot,
    (artifactDir) => {
      const serverName = runtimeServerName(token);
      const policy = resolveGovernedCliProfile(token, options);
      if (policy.governed) {
        linkSelectedEntries(
          providerHome,
          artifactDir,
          new Set([
            'credentials',
            'device_id',
            'migrations-effort.json',
            'oauth',
            'session_index.jsonl',
            'sessions',
            'user-history',
          ]),
        );
      } else {
        linkDirectoryEntries(
          providerHome,
          artifactDir,
          new Set(['mcp.json', 'config.toml']),
        );
      }
      const sourceRaw = readJsonObject(path.join(providerHome, 'mcp.json'));
      const source = policy.governed
        ? stripExecutableProfileConfig(sourceRaw)
        : sourceRaw;
      const servers = policy.governed ? {} : objectValue(source.mcpServers);
      const merged = {
        ...source,
        mcpServers: {
          ...servers,
          [serverName]: {
            url,
            bearerTokenEnvVar: 'NEXUS_MCP_TOKEN',
            enabled: true,
          },
        },
      };
      writePrivateFileAtomic(
        path.join(artifactDir, 'mcp.json'),
        `${JSON.stringify(merged, null, 2)}\n`,
      );
      // config.toml carries the additive status hooks. A malformed user config
      // must not break the spawn: degrade to a plain link (hooks off, MCP on).
      let tomlMerged: string | null = null;
      try {
        const tomlRaw = readTomlObject(path.join(providerHome, 'config.toml'));
        const tomlSource = policy.governed
          ? stripExecutableProfileConfig(tomlRaw)
          : tomlRaw;
        tomlMerged = stringify(mergeKimiStatusHooks(tomlSource), {
          maxDepth: MAX_CLI_TOML_CONFIG_DEPTH,
        });
      } catch {
        const realToml = path.join(providerHome, 'config.toml');
        // A direct pane may retain the historical best-effort fallback. A
        // governed pane must fail closed: linking an unparsed user config would
        // reintroduce exactly the hooks/plugins/agents this overlay isolates.
        if (!policy.governed && fs.existsSync(realToml)) {
          try {
            linkFile(realToml, path.join(artifactDir, 'config.toml'));
          } catch {
            // Best effort — MCP still works without the user config linked in.
          }
        }
      }
      if (tomlMerged !== null) {
        writePrivateFileAtomic(
          path.join(artifactDir, 'config.toml'),
          tomlMerged,
        );
      }
      const governedSkillsDir = path.join(artifactDir, 'skills');
      if (policy.governed) {
        mirrorGovernedSkills(
          'kimi',
          home,
          [governedSkillsDir],
          policy.allowedSkills,
        );
      }
      activateArtifact(token, {
        artifactDir,
        providerHome,
        configFiles: ['mcp.json', 'config.toml'],
        syncBack: !policy.governed,
      });
      return {
        env: { KIMI_CODE_HOME: artifactDir },
        // Kimi documents --skills-dir as replacing user/project discovery.
        extraArgs: policy.governed ? ['--skills-dir', governedSkillsDir] : [],
        serverName,
        artifactDir,
      };
    },
  );
}

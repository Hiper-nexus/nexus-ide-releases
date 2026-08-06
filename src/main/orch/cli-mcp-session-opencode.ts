import os from 'node:os';
import path from 'node:path';
import {
  activateArtifact,
  runtimeServerName,
  validateCliMcpInputs,
  withCliMcpArtifactTransaction,
} from './cli-mcp-session-artifacts';
import { mirrorGovernedSkills } from './cli-mcp-session-governance';
import type {
  CliMcpSessionOptions,
  CliMcpSessionResult,
} from './cli-mcp-session-types';
import { resolveGovernedCliProfile } from './governed-cli-profile';

/** OpenCode's official highest-priority runtime config; no token reaches disk. */
export function prepareOpenCodeMcpSession(
  url: string,
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  validateCliMcpInputs(url, token);
  const serverName = runtimeServerName(token);
  const policy = resolveGovernedCliProfile(token, options);
  const content = {
    mcp: {
      [serverName]: {
        type: 'remote',
        url,
        enabled: true,
        headers: {
          Authorization: 'Bearer {env:NEXUS_MCP_TOKEN}',
        },
      },
    },
  };
  if (policy.governed) {
    const home = path.resolve(options.home ?? os.homedir());
    const artifactRoot = path.resolve(
      options.artifactRoot ??
        path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
    );
    return withCliMcpArtifactTransaction(
      'opencode',
      token,
      artifactRoot,
      (artifactDir) => {
        const configHome = path.join(artifactDir, 'opencode');
        mirrorGovernedSkills(
          'opencode',
          home,
          [path.join(configHome, 'skills')],
          policy.allowedSkills,
          policy.allowedTools,
        );
        activateArtifact(token, {
          artifactDir,
          providerHome: null,
          configFiles: [],
          syncBack: false,
        });
        return {
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify(content),
            OPENCODE_CONFIG_DIR: configHome,
            OPENCODE_DISABLE_PROJECT_CONFIG: '1',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
            XDG_CONFIG_HOME: artifactDir,
          },
          // OpenCode's native boundary disables every external plugin while
          // retaining built-ins and the inline Nexus MCP declaration.
          extraArgs: ['--pure'],
          serverName,
          artifactDir,
        };
      },
    );
  }
  return {
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(content) },
    extraArgs: [],
    serverName,
    artifactDir: null,
  };
}

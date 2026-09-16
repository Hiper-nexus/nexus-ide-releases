import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkFile,
  linkProviderSessionState,
  runtimeServerName,
  sessionHash,
  validateCliMcpInputs,
  withCliMcpArtifactTransaction,
} from './cli-mcp-session-artifacts';
import { mirrorGovernedSkills } from './cli-mcp-session-governance';
import type {
  CliMcpSessionOptions,
  CliMcpSessionResult,
} from './cli-mcp-session-types';
import { resolveGovernedCliProfile } from './governed-cli-profile';
import { openCodeHubMcpServers } from '../mcp-hub/mcp-hub-spawn';
import { MANAGED_PROVIDER_SPECS } from '../adapters/managed-credentials';

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
      // `--pure` continua desligando todo plugin externo: o que entra aqui é
      // exclusivamente o que o operador declarou no hub do workspace.
      ...openCodeHubMcpServers(options.hubServers ?? []),
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
      const providerHome = path.resolve(
        options.providerHome ??
          MANAGED_PROVIDER_SPECS.opencode.systemHome(home)!,
      );
      // Auth belongs to the selected native/managed profile, conversations to
      // the checkout. Separate data roots keep concurrent accounts from
      // replacing each other's auth link; the DB stays checkout-scoped.
      const dataDirectory = `data-${sessionHash(providerHome).slice(0, 32)}`;
      const providerSessionHome = linkProviderSessionState(
        'opencode',
        artifactDir,
        options,
        [dataDirectory, 'state', 'database'],
        {},
      );
      const dataHome = path.join(providerSessionHome, dataDirectory);
      const data = path.join(dataHome, 'opencode');
      if (fs.lstatSync(data, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('OpenCode data directory must not be a symlink');
      }
      ensurePrivateDirectory(data);
      const authSource = path.join(providerHome, 'opencode', 'auth.json');
      ensurePrivateDirectory(path.dirname(authSource));
      // Keep a live auth target even for first login. Never replace an
      // existing credential; OpenCode writes updates through this link.
      try {
        fs.writeFileSync(authSource, '{}\n', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const authTarget = path.join(data, 'auth.json');
      if (process.platform === 'win32') {
        // A copied credential would survive managed-account scrub. Keep a
        // shared inode, and fail closed across volumes instead of copying.
        const source = fs.statSync(authSource);
        const target = fs.statSync(authTarget, { throwIfNoEntry: false });
        if (!target || source.dev !== target.dev || source.ino !== target.ino) {
          fs.rmSync(authTarget, { force: true });
          fs.linkSync(authSource, authTarget);
        }
      } else if (!fs.lstatSync(authTarget, { throwIfNoEntry: false })) {
        linkFile(authSource, authTarget);
      }
      const stateEnv = {
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: path.join(providerSessionHome, 'state'),
        OPENCODE_DB: path.join(providerSessionHome, 'database', 'opencode.db'),
      };
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (
          fs
            .lstatSync(`${stateEnv.OPENCODE_DB}${suffix}`, {
              throwIfNoEntry: false,
            })
            ?.isSymbolicLink()
        ) {
          throw new Error('OpenCode checkout database must not be a symlink');
        }
      }
      const configHome = path.join(artifactDir, 'opencode');
      if (policy.governed) {
        mirrorGovernedSkills(
          'opencode',
          home,
          [path.join(configHome, 'skills')],
          policy.allowedSkills,
          policy.allowedTools,
        );
      }
      activateArtifact(token, {
        artifactDir,
        providerHome: null,
        configFiles: [],
        syncBack: false,
      });
      return {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify(content),
          ...stateEnv,
          ...(policy.governed
            ? {
                OPENCODE_CONFIG_DIR: configHome,
                OPENCODE_DISABLE_PROJECT_CONFIG: '1',
                OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
                OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
                XDG_CONFIG_HOME: artifactDir,
              }
            : {}),
        },
        // OpenCode's native boundary disables every external plugin while
        // retaining built-ins and the inline Nexus MCP declaration.
        extraArgs: policy.governed ? ['--pure'] : [],
        serverName,
        artifactDir,
        // The native data directory also contains external conversations.
        // Grant only the credential file, never that whole directory.
        providerStateHome: authSource,
        providerSessionHome,
      };
    },
  );
}

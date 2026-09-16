import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import {
  activateArtifact,
  linkDirectoryEntries,
  linkFile,
  linkProviderSessionState,
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
import { claudeFamilyHubMcpServers } from '../mcp-hub/mcp-hub-spawn';

/**
 * Real subpaths the governed overlay symlinks credential material from
 * (F-569: the sandbox grant narrows to exactly these, never the whole
 * ~/.kimi-code — mirrors managed-credentials.ts's own auth surface for Kimi).
 */
const KIMI_AUTH_ENTRIES = ['credentials', 'oauth'];

function kimiAuthGrantPaths(providerHome: string): string[] {
  const found: string[] = [];
  for (const name of KIMI_AUTH_ENTRIES) {
    const candidate = path.join(providerHome, name);
    try {
      if (fs.statSync(candidate).isDirectory()) found.push(candidate);
    } catch {
      continue;
    }
  }
  return found;
}

const KIMI_SESSION_DIRECTORIES = ['sessions', 'user-history', 'file-history'];
const KIMI_SESSION_FILES = { 'session_index.jsonl': '' };
const KIMI_SESSION_ENTRIES = [
  ...KIMI_SESSION_DIRECTORIES,
  ...Object.keys(KIMI_SESSION_FILES),
];

/**
 * Pre-seed trust for the workspace in Kimi's workspace-trust and workspaces.json
 * so Kimi doesn't ask "Trust this folder?" when opened by Nexus.
 */
export function ensureKimiWorkspaceTrust(
  providerHome: string,
  cwd?: string,
): void {
  if (!cwd) return;
  try {
    const trustDir = path.join(providerHome, 'workspace-trust');
    fs.mkdirSync(trustDir, { recursive: true, mode: 0o700 });

    const targets = [cwd];
    try {
      const real = fs.realpathSync(cwd);
      if (real && real !== cwd) targets.push(real);
    } catch {
      // best-effort realpath
    }

    const workspacesPath = path.join(providerHome, 'workspaces.json');
    let workspacesData: {
      version: number;
      workspaces: Record<string, unknown>;
      deleted_workspace_ids: string[];
    } = {
      version: 1,
      workspaces: {},
      deleted_workspace_ids: [],
    };
    if (fs.existsSync(workspacesPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(workspacesPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.workspaces) {
          workspacesData = parsed as typeof workspacesData;
        }
      } catch {
        // fallback
      }
    }

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    for (const root of targets) {
      const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
      const base = path.basename(root) || 'workspace';
      const workspaceId = `wd_${base}_${hash}`;

      const trustFile = path.join(trustDir, workspaceId);
      fs.writeFileSync(
        trustFile,
        JSON.stringify({ root, trustedAt: nowMs }),
        { mode: 0o600 },
      );

      if (!workspacesData.workspaces[workspaceId]) {
        workspacesData.workspaces[workspaceId] = {
          root,
          name: base,
          created_at: nowIso,
          last_opened_at: nowIso,
        };
      }
    }

    fs.writeFileSync(
      workspacesPath,
      JSON.stringify(workspacesData, null, 2),
      { mode: 0o600 },
    );
  } catch {
    // best-effort
  }
}

/**
 * Kimi officially resolves MCP from $KIMI_CODE_HOME/mcp.json. The overlay
 * links auth/profile data from the real home, conversations from durable Nexus
 * checkout state, and adds a private, token-free MCP declaration;
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
  if (options.cwd) {
    ensureKimiWorkspaceTrust(providerHome, options.cwd);
  }
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
            'workspace-trust',
            'workspaces.json',
          ]),
        );
      } else {
        linkDirectoryEntries(
          providerHome,
          artifactDir,
          new Set(['mcp.json', 'config.toml', ...KIMI_SESSION_ENTRIES]),
        );
      }
      const providerSessionHome = linkProviderSessionState(
        'kimi',
        artifactDir,
        options,
        KIMI_SESSION_DIRECTORIES,
        KIMI_SESSION_FILES,
      );
      const sourceRaw = readJsonObject(path.join(providerHome, 'mcp.json'));
      const source = policy.governed
        ? stripExecutableProfileConfig(sourceRaw)
        : sourceRaw;
      const servers = policy.governed ? {} : objectValue(source.mcpServers);
      const merged = {
        ...source,
        mcpServers: {
          ...servers,
          // Hub do workspace: entra depois do perfil ambiente (que o overlay
          // governado já zerou) e antes do `nexus`, que sempre vence.
          ...claudeFamilyHubMcpServers(options.hubServers ?? []),
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
          policy.allowedTools,
        );
      }
      activateArtifact(token, {
        artifactDir,
        providerHome,
        configFiles: ['mcp.json', 'config.toml', ...KIMI_SESSION_ENTRIES],
        syncBack: !policy.governed,
      });
      const authGrantPaths = policy.governed
        ? kimiAuthGrantPaths(providerHome)
        : [];
      return {
        env: { KIMI_CODE_HOME: artifactDir },
        // Kimi documents --skills-dir as replacing user/project discovery.
        extraArgs: policy.governed ? ['--skills-dir', governedSkillsDir] : [],
        serverName,
        artifactDir,
        // F-569: governed sessions grant only credentials/oauth, never the
        // whole ~/.kimi-code. Durable conversation links need a separate
        // sandbox grant.
        ...(policy.governed
          ? {
              providerStateReadPaths: authGrantPaths,
              providerStateWritePaths: authGrantPaths,
              providerSessionHome,
            }
          : {}),
      };
    },
  );
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkDirectoryEntries,
  linkFile,
  linkProviderSessionState,
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
import { grokHubMcpServers } from '../mcp-hub/mcp-hub-spawn';

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
 * The private overlay links auth/skills from the real profile and conversations
 * from Nexus's durable checkout state, replacing config.toml. The config references
 * NEXUS_MCP_TOKEN, already scoped to the spawned process, so no bearer is
 * persisted in either the real profile or the ephemeral overlay.
 * The additive semantic-status hooks (emdash wave 1) ship as a Nexus-owned
 * `hooks/nexus.json` inside the overlay — the user's own hooks/ entries are
 * linked through, and nexus.json never syncs back into the real profile.
 */
const GROK_AUTH_FILE = 'auth.json';
const GROK_AUTH_LOCK_FILE = 'auth.json.lock';
const GROK_SESSION_DIRECTORIES = ['sessions', 'prompt_history'];
const GROK_SESSION_FILES = {
  'active_sessions.json': '[]\n',
  'active_sessions.lock': '',
  'prompt_history.jsonl': '',
};
const GROK_SESSION_ENTRIES = [
  ...GROK_SESSION_DIRECTORIES,
  ...Object.keys(GROK_SESSION_FILES),
];
/** Freshness skew: a token expiring within this window counts as stale. */
const GROK_AUTH_FRESH_SKEW_MS = 5 * 60 * 1000;

interface GrokAuthIdentity {
  email: string;
  expiresAtMs: number | null;
}

function readGrokAuthIdentities(dir: string): GrokAuthIdentity[] {
  try {
    const raw = fs.readFileSync(path.join(dir, GROK_AUTH_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Record<
      string,
      { email?: unknown; expires_at?: unknown }
    >;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    return Object.values(parsed).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const email =
        typeof entry.email === 'string' ? entry.email.trim().toLowerCase() : '';
      if (!email) return [];
      let expiresAtMs: number | null = null;
      if (typeof entry.expires_at === 'string') {
        const parsedMs = Date.parse(entry.expires_at);
        expiresAtMs = Number.isFinite(parsedMs) ? parsedMs : null;
      }
      return [{ email, expiresAtMs }];
    });
  } catch {
    return [];
  }
}

function hasFreshEntry(entries: GrokAuthIdentity[], now: number): boolean {
  return entries.some(
    (entry) =>
      entry.expiresAtMs !== null &&
      entry.expiresAtMs > now + GROK_AUTH_FRESH_SKEW_MS,
  );
}

/**
 * Resolve which profile supplies auth.json to the overlay.
 *
 * A pinned managed account shadows the native profile: its captured
 * auth.json is a one-time snapshot that goes stale when the operator
 * re-logs in outside Nexus, while the native ~/.grok/auth.json keeps
 * refreshing. The stale copy then forces a device-login loop — the CLI
 * rejects the expired credential (observed: it even removes the overlay
 * link) and every rebuilt overlay starts from the same stale source.
 *
 * Fallback rules (multi-account safe):
 * - managed home already has ANY fresh entry → providerHome (untouched,
 *   N accounts keep coexisting);
 * - otherwise, native has a fresh entry AND (managed holds no identities
 *   at all, or one of them matches the native email = same account with
 *   a rotated credential) → native home;
 * - anything else (different-account pin, nothing fresh anywhere) →
 *   providerHome, i.e. exactly today's behavior: the CLI may still
 *   refresh via its own refresh_token, and no foreign identity ever
 *   leaks into a pinned account.
 *
 * Overlay-level link only — vault state is never mutated here.
 */
export function resolveGrokOverlayAuthSource(
  providerHome: string,
  home: string,
  now = Date.now(),
): string {
  const nativeHome = path.join(home, '.grok');
  if (path.resolve(providerHome) === path.resolve(nativeHome)) {
    return providerHome;
  }
  const managed = readGrokAuthIdentities(providerHome);
  if (hasFreshEntry(managed, now)) return providerHome;
  const native = readGrokAuthIdentities(nativeHome);
  const freshNative = native.filter(
    (entry) =>
      entry.expiresAtMs !== null &&
      entry.expiresAtMs > now + GROK_AUTH_FRESH_SKEW_MS,
  );
  if (freshNative.length === 0) return providerHome;
  if (managed.length === 0) return nativeHome;
  const managedEmails = new Set(managed.map((entry) => entry.email));
  if (freshNative.some((entry) => managedEmails.has(entry.email))) {
    return nativeHome;
  }
  return providerHome;
}

/**
 * Link the auth pair from the resolved source; absent files stay absent.
 * Returns the real source paths actually linked (F-569: this is the exact
 * grant surface a governed sandbox needs — never the whole provider home).
 */
function linkGrokAuthPair(sourceDir: string, artifactDir: string): string[] {
  const linked: string[] = [];
  for (const name of [GROK_AUTH_FILE, GROK_AUTH_LOCK_FILE]) {
    const sourcePath = path.join(sourceDir, name);
    try {
      fs.statSync(sourcePath);
    } catch {
      continue;
    }
    linkFile(sourcePath, path.join(artifactDir, name));
    linked.push(sourcePath);
  }
  return linked;
}

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
      // The auth pair resolves through resolveGrokOverlayAuthSource: a
      // stale managed shadow falls back to a fresh same-account native
      // session instead of forcing a device-login loop. It is linked
      // exactly once below — never from providerHome here.
      const authSource = resolveGrokOverlayAuthSource(providerHome, home);
      if (policy.governed) {
        linkSelectedEntries(
          providerHome,
          artifactDir,
          new Set([
            '.metadata_version',
            'agent_id',
            'bundled',
            'models_cache.json',
            'projects',
          ]),
        );
      } else {
        linkDirectoryEntries(
          providerHome,
          artifactDir,
          new Set([
            'config.toml',
            'hooks',
            GROK_AUTH_FILE,
            GROK_AUTH_LOCK_FILE,
            ...GROK_SESSION_ENTRIES,
          ]),
        );
      }
      const providerSessionHome = linkProviderSessionState(
        'grok',
        artifactDir,
        options,
        GROK_SESSION_DIRECTORIES,
        GROK_SESSION_FILES,
      );
      const authGrantPaths = linkGrokAuthPair(authSource, artifactDir);
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
          // Hub do workspace: o perfil ambiente do ~/.grok continua zerado no
          // overlay governado; só o que o operador declarou entra.
          ...grokHubMcpServers(options.hubServers ?? []),
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
        configFiles: ['config.toml', ...GROK_SESSION_ENTRIES],
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
        // F-569: governed sessions grant only the resolved auth.json/lock
        // pair, never the whole ~/.grok. Durable conversation links need a
        // separate sandbox grant.
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

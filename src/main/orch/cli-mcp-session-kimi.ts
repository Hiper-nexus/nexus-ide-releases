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
import { isNexusHookText } from '../../vendor/emdash/hooks/hook-commands';

const KIMI_CATALOG_OBJECT_KEYS = ['models', 'providers', 'services'] as const;

/**
 * Copy the native model catalog into an overlay config. Overlay keys win
 * (a TUI model switch may change `default_model`); missing native models,
 * providers and services are filled back in so `kimi --model kimi-code/k3`
 * keeps resolving after the CLI rewrites config.toml (F-611).
 */
export function projectKimiNativeCatalog(
  overlay: Record<string, unknown>,
  native: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...overlay };
  for (const key of KIMI_CATALOG_OBJECT_KEYS) {
    const nativeObj = objectValue(native[key]);
    if (Object.keys(nativeObj).length === 0) continue;
    next[key] = { ...nativeObj, ...objectValue(overlay[key]) };
  }
  if (
    (typeof next.default_model !== 'string' || !next.default_model.trim()) &&
    typeof native.default_model === 'string' &&
    native.default_model.trim()
  ) {
    next.default_model = native.default_model;
  }
  return next;
}

function kimiCatalogHasNativeModels(
  overlay: Record<string, unknown>,
  native: Record<string, unknown>,
): boolean {
  const nativeModels = objectValue(native.models);
  if (Object.keys(nativeModels).length === 0) return true;
  const overlayModels = objectValue(overlay.models);
  return Object.keys(nativeModels).every((key) => key in overlayModels);
}

/** Re-merge native models/providers when the overlay config lost the catalog. */
export function restoreKimiOverlayCatalog(
  overlayToml: string,
  nativeToml: string,
): boolean {
  const native = readTomlObject(nativeToml);
  if (Object.keys(objectValue(native.models)).length === 0) return false;
  let overlayRaw = '';
  try {
    overlayRaw = fs.readFileSync(overlayToml, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let overlay: Record<string, unknown> = {};
  if (overlayRaw) {
    try {
      overlay = readTomlObject(overlayToml);
    } catch {
      overlay = {};
    }
  }
  if (
    kimiCatalogHasNativeModels(overlay, native) &&
    isNexusHookText(overlayRaw)
  ) {
    return false;
  }
  writePrivateFileAtomic(
    overlayToml,
    stringify(
      mergeKimiStatusHooks(projectKimiNativeCatalog(overlay, native)),
      { maxDepth: MAX_CLI_TOML_CONFIG_DEPTH },
    ),
  );
  return true;
}

function startKimiCatalogGuard(
  overlayDir: string,
  nativeToml: string,
): () => void {
  const overlayToml = path.join(overlayDir, 'config.toml');
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const kick = (): void => {
    if (closed) return;
    try {
      restoreKimiOverlayCatalog(overlayToml, nativeToml);
    } catch {
      // A catalog rewrite must never take the pane down.
    }
  };
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(overlayDir, { persistent: false }, (_event, filename) => {
      if (closed) return;
      const name = filename?.toString() ?? '';
      if (
        name &&
        name !== 'config.toml' &&
        !name.startsWith('.config.toml.')
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(kick, 25);
    });
  } catch {
    return () => {};
  }
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // Overlay may already be gone.
    }
  };
}

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
 * F-958: a chave que o Kimi Code 2.x LÊ (`encodeWorkDirKey` do binário 2.1.1):
 * basename em minúsculas, `[^a-z0-9._-]+` → `-`, sem traços nas pontas,
 * cortado em 40 caracteres; hash = sha256 da raiz com `/` e sem barra final.
 * O nome inteiro (`wd_task-<64 hex>_…`) nunca era lido: toda worktree de
 * tarefa abria "Trust this folder?" e o autoresponder segurava o brief.
 */
export function kimiWorkDirKey(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = normalized.split('/').pop() ?? normalized;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const safeSlug = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${safeSlug}_${hash}`;
}

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
      const workspaceId = kimiWorkDirKey(root);
      const base = path.basename(root) || 'workspace';

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
 * config.toml is a private copy: native `models`/`providers`/`services`
 * (F-611) plus additive semantic-status hooks (emdash wave 1: flat
 * `hooks = [{event, command}]`, marker-separated). A live TUI rewrite that
 * drops the catalog is restored in-place. Both files stay out of the auth
 * sync-back so they never reach the real profile.
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
      // config.toml carries the native model catalog (F-611) plus additive
      // status hooks. A malformed user config must not break the spawn, but
      // dropping models/providers leaves `kimi --model kimi-code/k3` dead.
      const realToml = path.join(providerHome, 'config.toml');
      const overlayToml = path.join(artifactDir, 'config.toml');
      let tomlMerged: string | null = null;
      try {
        const tomlRaw = readTomlObject(realToml);
        const tomlSource = policy.governed
          ? stripExecutableProfileConfig(tomlRaw)
          : tomlRaw;
        tomlMerged = stringify(
          projectKimiNativeCatalog(
            mergeKimiStatusHooks(tomlSource),
            tomlRaw,
          ),
          { maxDepth: MAX_CLI_TOML_CONFIG_DEPTH },
        );
      } catch {
        try {
          const tomlRaw = readTomlObject(realToml);
          tomlMerged = stringify(
            projectKimiNativeCatalog(
              policy.governed ? stripExecutableProfileConfig(tomlRaw) : {},
              tomlRaw,
            ),
            { maxDepth: MAX_CLI_TOML_CONFIG_DEPTH },
          );
        } catch {
          // Last resort: copy native bytes (follows a managed-home symlink)
          // so the overlay still has models. Governed panes stay fail-closed
          // on an unparsed user config — linking it would reintroduce hooks.
          if (!policy.governed && fs.existsSync(realToml)) {
            try {
              fs.copyFileSync(realToml, overlayToml);
              fs.chmodSync(overlayToml, 0o600);
            } catch {
              try {
                linkFile(realToml, overlayToml);
              } catch {
                // MCP still works; the catalog guard may restore later.
              }
            }
          }
        }
      }
      if (tomlMerged !== null) {
        writePrivateFileAtomic(overlayToml, tomlMerged);
      }
      const stopCatalogGuard = startKimiCatalogGuard(artifactDir, realToml);
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
        dispose: stopCatalogGuard,
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

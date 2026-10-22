import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { stringify } from 'smol-toml';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkSelectedEntries,
  linkProviderSessionState,
  readTomlObject,
  runtimeServerName,
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
import { resolveGovernedCliProfile } from './governed-cli-profile';
import { codexPermissionProfileFor } from '../pty/codex-native-authority';
import { installCodexPrivateHookTrust } from './codex-private-hook-trust';
import { codexStartupConfig } from './codex-startup-policy';

function heavyCommandShellPolicy(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of ['NEXUS_HEAVY_JOB_BASE', 'NEXUS_HEAVY_CURL', 'NEXUS_HEAVY_AGENT_ENTRY', 'NEXUS_GATE_TOKEN', 'NEXUS_HEAVY_COMMAND_URL', 'NEXUS_HEAVY_DIR', 'NEXUS_HEAVY_NODE',
    'NEXUS_HEAVY_BASH_ENV', 'NEXUS_HEAVY_ORIG_BASH_ENV', 'NEXUS_HEAVY_ORIG_ZDOTDIR', 'BASH_ENV', 'ZDOTDIR', 'NODE_OPTIONS']) {
    if (env?.[key] !== undefined) selected[key] = env[key];
  }
  return selected;
}

function pathBelongsTo(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function codexDiscoverySkillRoots(options: {
  home: string;
  cwd: string;
  workspaceRoot: string;
  adminSkillsRoot: string;
}): string[] {
  return [
    ...governedWorkspaceTiers(options.cwd, options.workspaceRoot).flatMap(
      (tier) => [
        path.join(tier, '.agents', 'skills'),
        path.join(tier, '.codex', 'skills'),
      ],
    ),
    path.join(options.home, '.agents', 'skills'),
    options.adminSkillsRoot,
  ];
}

const MAX_CODEX_SKILL_DIRECTORIES = 4_096;
const MAX_CODEX_SKILL_DEPTH = 32;

/**
 * Codex discovers `.agents/skills` independently from project trust. Resolve
 * every manifest to its physical path, including symlinked directories, so a
 * repository cannot smuggle an external skill past a lexical path check.
 */
function codexSkillInventory(roots: readonly string[]): {
  manifests: string[];
  directories: string[];
} {
  const manifests = new Set<string>();
  const visitedDirectories = new Set<string>();
  let visitedCount = 0;

  const visit = (candidate: string, depth: number): void => {
    if (depth > MAX_CODEX_SKILL_DEPTH) {
      throw new Error('Codex skill discovery exceeds the governed depth limit');
    }
    let realDirectory: string;
    let stat: fs.Stats;
    try {
      realDirectory = fs.realpathSync.native(candidate);
      stat = fs.statSync(realDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    if (!stat.isDirectory() || visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);
    visitedCount += 1;
    if (visitedCount > MAX_CODEX_SKILL_DIRECTORIES) {
      throw new Error(
        'Codex skill discovery exceeds the governed directory limit',
      );
    }

    const entries = fs
      .readdirSync(realDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const manifestEntry = entries.find((entry) => entry.name === 'SKILL.md');
    if (manifestEntry) {
      const manifest = fs.realpathSync.native(
        path.join(realDirectory, manifestEntry.name),
      );
      if (fs.statSync(manifest).isFile()) manifests.add(manifest);
      // A skill's asset tree is not another discovery tier.
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const child = path.join(realDirectory, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        visit(child, depth + 1);
      }
    }
  };

  for (const root of roots) visit(root, 0);
  return {
    manifests: [...manifests].sort(),
    directories: [...visitedDirectories].sort(),
  };
}

// Auth is the sole live provider-state exception. Keeping the one file linked
// preserves Codex refresh-token rotation without giving a governed process any
// real history, thread database, session tree or global application state.
const CODEX_LIVE_AUTH_STATE = new Set(['auth.json']);
const CODEX_OPERATOR_PROFILE = new Set([
  'auth.json',
  'skills',
  'plugins',
  'rules',
  'AGENTS.md',
  'models_cache.json',
]);
const CODEX_STATE_DATABASE = 'state_5.sqlite';
const CODEX_RESUME_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CODEX_CONVERSATION_DIRECTORIES = ['sessions', 'archived_sessions'];
const CODEX_CONVERSATION_FILES = {
  'history.jsonl': '',
  'session_index.jsonl': '',
};
const CODEX_OVERLAY_EXCLUSIONS = new Set([
  'config.toml',
  'hooks.json',
  ...CODEX_CONVERSATION_DIRECTORIES,
  ...Object.keys(CODEX_CONVERSATION_FILES),
  'state_5.sqlite',
  'state_5.sqlite-wal',
  'state_5.sqlite-shm',
  'logs_2.sqlite',
  'logs_2.sqlite-wal',
  'logs_2.sqlite-shm',
]);

/** Rebind only the requested checkout thread after its old overlay was purged. */
function prepareCodexExactResume(
  stateHome: string,
  sessionId: string,
  governed: boolean,
): void {
  if (!CODEX_RESUME_ID.test(sessionId)) {
    throw new Error('Codex exact resume session id is invalid');
  }
  const databasePath = path.join(stateHome, CODEX_STATE_DATABASE);
  if (!fs.existsSync(databasePath)) {
    throw new Error('Codex exact resume state database is unavailable');
  }
  if (fs.lstatSync(databasePath).isSymbolicLink()) {
    throw new Error('Codex exact resume state database must not be a symlink');
  }
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const thread = db
      .prepare('SELECT rollout_path FROM threads WHERE id = ?')
      .get(sessionId) as { rollout_path?: unknown } | undefined;
    if (!thread || typeof thread.rollout_path !== 'string') {
      throw new Error('Codex exact resume thread is unavailable');
    }
    // Codex records an absolute CODEX_HOME path. Only use its relative suffix;
    // never read the old overlay or import a rollout from the native profile.
    const parts = thread.rollout_path.split(path.sep);
    const sessionsIndex = parts.findLastIndex((part) =>
      CODEX_CONVERSATION_DIRECTORIES.includes(part),
    );
    if (sessionsIndex < 0)
      throw new Error('Codex exact resume rollout is unavailable');
    const sessionsRoot = fs.realpathSync.native(
      path.join(stateHome, parts[sessionsIndex]),
    );
    let rollout: string;
    try {
      rollout = fs.realpathSync.native(
        path.join(sessionsRoot, ...parts.slice(sessionsIndex + 1)),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error('Codex exact resume rollout is unavailable', { cause: error });
      }
      throw error;
    }
    if (
      !pathBelongsTo(sessionsRoot, rollout) ||
      !fs.statSync(rollout).isFile()
    ) {
      throw new Error('Codex exact resume rollout escapes checkout sessions');
    }
    const update = db
      .prepare(
        'UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?',
      )
      .run(rollout, sessionId, thread.rollout_path);
    if (update.changes !== 1)
      throw new Error('Codex exact resume thread changed during preparation');
    // Persisted dynamic tools are part of the old provider capability surface,
    // not transcript continuity. A governed resume must not resurrect them.
    if (
      governed &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_dynamic_tools'",
        )
        .get()
    ) {
      db.prepare('DELETE FROM thread_dynamic_tools WHERE thread_id = ?').run(
        sessionId,
      );
    }
  } finally {
    db.close();
  }
}

function prepareCodexConversationState(
  artifactDir: string,
  options: CliMcpSessionOptions,
): string {
  const stateHome = linkProviderSessionState(
    'codex',
    artifactDir,
    options,
    CODEX_CONVERSATION_DIRECTORIES,
    CODEX_CONVERSATION_FILES,
  );
  // SQLite opens its journals beside the DB. Reject pre-existing redirects
  // before launching even a fresh session, not only on the resume path.
  for (const entry of fs.readdirSync(stateHome, { withFileTypes: true })) {
    if (
      /^(state|logs)_\d+\.sqlite(?:-(wal|shm|journal))?$/.test(entry.name) &&
      entry.isSymbolicLink()
    ) {
      throw new Error('Codex checkout database must not be a symlink');
    }
  }
  if (options.codexResumeSessionId)
    prepareCodexExactResume(
      stateHome,
      options.codexResumeSessionId,
      options.governed === true,
    );
  return fs.realpathSync.native(stateHome);
}

function codexProviderStateRealPaths(
  providerHome: string,
  entries: ReadonlySet<string>,
): string[] {
  let providerRoot: string;
  try {
    providerRoot = fs.realpathSync.native(providerHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const paths = new Set<string>();
  for (const name of entries) {
    const source = path.join(providerHome, name);
    let real: string;
    try {
      real = fs.realpathSync.native(source);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    if (!pathBelongsTo(providerRoot, real)) {
      throw new Error(
        `Codex provider state ${name} escapes its managed provider home`,
      );
    }
    paths.add(real);
  }
  return [...paths].sort();
}

function codexProtectedWritePaths(options: {
  artifactDir: string;
  processHome: string;
  providerHome: string;
  home: string;
  cwd: string;
  workspaceRoot: string;
  adminSkillsRoot: string;
  physicalDiscoveryDirectories: readonly string[];
}): string[] {
  const tiers = governedWorkspaceTiers(options.cwd, options.workspaceRoot);
  const discoveryRoots = codexDiscoverySkillRoots({
    home: options.home,
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    adminSkillsRoot: options.adminSkillsRoot,
  });
  const protectedPaths = new Set<string>([
    ...tiers.flatMap((tier) => [
      // Protect the whole discovery control directory, not only manifests
      // present during the pre-spawn inventory.
      path.join(tier, '.agents'),
      path.join(tier, '.codex'),
    ]),
    path.join(options.processHome, '.agents'),
    path.join(options.processHome, '.codex'),
    // The exact provider profile is immutable after main creates it. This
    // prevents a qualified-but-compromised parent process from widening the
    // network or filesystem policy for later child executions.
    path.join(options.artifactDir, 'config.toml'),
    path.join(options.artifactDir, 'hooks.json'),
    path.join(options.artifactDir, 'skills'),
    path.join(options.home, '.agents'),
    path.join(options.providerHome, 'skills'),
    options.adminSkillsRoot,
    ...options.physicalDiscoveryDirectories,
  ]);

  // A repository may make `.agents/skills` or `.codex/skills` a symlink to a
  // writable location elsewhere in the checkout. Protect the physical target
  // too, otherwise a worker could mutate it through its alternate pathname
  // after the manifest inventory and wake Codex's SkillsWatcher.
  for (const candidate of discoveryRoots) {
    protectedPaths.add(candidate);
    try {
      protectedPaths.add(fs.realpathSync.native(candidate));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }

  return [...protectedPaths].map((candidate) => path.resolve(candidate)).sort();
}

/**
 * Codex has no `--strict-mcp-config` equivalent. A governed pane therefore
 * receives a private CODEX_HOME with only auth/session continuity and
 * explicitly granted skills. Its main-owned config marks the exact execution
 * root untrusted so project config, hooks and rules cannot execute before the
 * model; the real config, plugins and user MCPs never enter the process-visible
 * provider home.
 */
/**
 * F-666: no Windows o perfil governado roda o Codex instalado (0.157+), que
 * executa TODA ferramenta pelo code-mode host — desligado, cada comando falha
 * com "code-mode host is disabled" e o writer da missão não faz nada. O macOS
 * governa um binário fixado (`trusted-native-cli-binary`) e mantém o host
 * desligado. Permissões de arquivo/rede do perfil continuam valendo.
 */
export function codexGovernedCodeModeHost(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32';
}

export function prepareCodexGovernedSession(
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  if (!token) throw new Error('Nexus MCP token is required');
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ?? path.join(home, '.codex'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ??
      path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  return withCliMcpArtifactTransaction(
    'codex',
    token,
    artifactRoot,
    (preparedArtifactDir) => {
      const artifactDir = fs.realpathSync.native(preparedArtifactDir);
      const serverName = runtimeServerName(token);
      const policy = resolveGovernedCliProfile(token, {
        governed: true,
        allowedSkills: options.allowedSkills,
      });
      if (!options.cwd) {
        throw new Error(
          'Governed Codex session requires an exact execution cwd',
        );
      }
      const executionRoot = fs.realpathSync(path.resolve(options.cwd));
      const workspaceRoot = fs.realpathSync(
        path.resolve(options.workspaceRoot ?? executionRoot),
      );
      const workspaceRelative = path.relative(workspaceRoot, executionRoot);
      if (
        workspaceRelative.startsWith('..') ||
        path.isAbsolute(workspaceRelative)
      ) {
        throw new Error(
          'Governed Codex cwd must belong to its exact execution workspace',
        );
      }
      const nativeAuthority = options.codexNativeAuthority;
      if (!nativeAuthority) {
        throw new Error(
          'Governed Codex session requires an explicit native authority profile',
        );
      }
      const permissionProfile = codexPermissionProfileFor(nativeAuthority);
      const adminSkillsRoot =
        options.codexAdminSkillsRoot ?? path.join('/etc', 'codex', 'skills');
      const skillInventory = codexSkillInventory(
        codexDiscoverySkillRoots({
          home,
          cwd: executionRoot,
          workspaceRoot,
          adminSkillsRoot,
        }),
      );
      const externalSkillManifests = skillInventory.manifests;
      const shellHome = path.join(artifactDir, 'shell-home');
      const shellTmp = path.join(artifactDir, 'shell-tmp');
      const providerSessionHome = prepareCodexConversationState(artifactDir, {
        ...options,
        governed: true,
      });
      const providerStatePaths = [
        ...codexProviderStateRealPaths(providerHome, CODEX_LIVE_AUTH_STATE),
        providerSessionHome,
      ];
      const protectedWritePaths = codexProtectedWritePaths({
        artifactDir,
        processHome: shellHome,
        providerHome,
        home,
        cwd: executionRoot,
        workspaceRoot,
        adminSkillsRoot,
        physicalDiscoveryDirectories: skillInventory.directories,
      });
      const filesystemPermissions: Record<string, string> = {
        ':root': 'deny',
        [workspaceRoot]:
          nativeAuthority === 'workspace-write' ? 'write' : 'read',
        [shellHome]: 'write',
        [shellTmp]: 'write',
        [providerSessionHome]: 'write',
      };
      // The provider profile stays fail-closed and contains no broad platform
      // alias such as `:minimal`. On Darwin the Nexus outer Seatbelt is the
      // physical filesystem boundary; this table remains a declarative,
      // defense-in-depth contract for the governed session.
      // This machine's release-qualified local toolchain lives under
      // Homebrew's prefix; grant read-only runtime/library access under the
      // local-install trust boundary without exposing $HOME.
      if (fs.existsSync('/opt/homebrew')) {
        filesystemPermissions['/opt/homebrew'] = 'read';
      }
      for (const protectedPath of protectedWritePaths) {
        filesystemPermissions[protectedPath] = 'deny';
      }
      // The private mirror is main-owned and immutable under the inherited outer
      // process sandbox, but native tools must still read its SKILL.md, scripts and
      // assets. Keep it read-only instead of applying the deny used for external
      // discovery namespaces.
      filesystemPermissions[path.join(artifactDir, 'skills')] = 'read';
      // Codex 0.145 disables its managed proxy in external/danger-full-access
      // execution. Shell and package subprocesses therefore stay physically
      // offline. load_workspace_dependencies may expose only Nexus-bundled
      // runtime paths; it is not a remote project-package installer.
      const networkPermissions = { enabled: false };

      ensurePrivateDirectory(shellHome);
      ensurePrivateDirectory(shellTmp);
      linkSelectedEntries(providerHome, artifactDir, CODEX_LIVE_AUTH_STATE);
      mirrorGovernedSkills(
        'codex',
        home,
        [path.join(artifactDir, 'skills')],
        policy.allowedSkills,
        policy.allowedTools,
      );
      // Preferências de TUI que o Codex tenta gravar em config.toml no boot.
      // O arquivo é immutable (protectedWritePaths); se já estiverem aqui, o
      // TUI não tenta batchWrite e some o vermelho "Failed to save … config.toml".
      const sealedModel = options.model?.trim() || undefined;
      const config = stringify({
        sqlite_home: providerSessionHome,
        ...(sealedModel ? { model: sealedModel } : {}),
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 950_000,
        default_permissions: permissionProfile,
        shell_environment_policy: {
          inherit: 'core',
          ignore_default_excludes: false,
          set: {
            ...heavyCommandShellPolicy(options.heavyCommandEnv),
            HOME: shellHome,
            TMPDIR: shellTmp,
          },
        },
        features: {
          // The governed model receives only its native shell/editor surface
          // plus the bearer-scoped Nexus MCP. Account apps, browser/computer
          // control and remote plugin surfaces must not reappear through the
          // shared Codex thread database.
          apps: false,
          auth_elicitation: false,
          browser_use: false,
          browser_use_external: false,
          browser_use_full_cdp_access: false,
          code_mode_host: codexGovernedCodeModeHost(),
          computer_use: false,
          enable_mcp_apps: false,
          goals: false,
          // Hooks in this private CODEX_HOME come only from main-owned
          // hooks.json with exact persisted trust. Keep the engine active so UserPromptSubmit can
          // reach the bearer-scoped loopback status endpoint; project/user
          // hook discovery remains absent from this isolated profile.
          hooks: true,
          image_generation: false,
          in_app_browser: false,
          plugins: false,
          plugin_sharing: false,
          remote_plugin: false,
          skill_mcp_dependency_install: false,
          standalone_web_search: false,
          tool_call_mcp_elicitation: false,
          tool_suggest: false,
          multi_agent: false,
          network_proxy: false,
          workspace_dependencies: false,
        },
        permissions: {
          [permissionProfile]: {
            filesystem: filesystemPermissions,
            network: networkPermissions,
          },
        },
        projects: {
          [executionRoot]: {
            trust_level: 'untrusted',
          },
        },
        // Renames recentes: se o mapa já existe, Codex não pede para persistir
        // "model migration prompt preference" no arquivo imutável.
        notice: {
          model_migrations: {
            // gpt-5.5 saiu do catálogo: squads salvos com ele são
            // redirecionados, nunca falham no spawn.
            'gpt-5.5': 'gpt-5.6-luna',
            'gpt-5.3': 'gpt-5.6-luna',
            'gpt-5.4': 'gpt-5.6-luna',
            'gpt-5.4-mini': 'gpt-5.6-luna',
            'gpt-5.4-nano': 'gpt-5.6-luna',
          },
        },
        tui: {
          // Exact resume must stay in the current sealed worktree and never
          // prompt to rebind to a historic checkout.
          resume_cwd: 'current',
          // NUX "model available" já visto → não grava tui.model_availability_nux.
          ...(sealedModel
            ? {
                model_availability_nux: {
                  [sealedModel]: 4,
                },
              }
            : {}),
        },
        skills: {
          bundled: {
            enabled: false,
          },
          config: externalSkillManifests.map((manifest) => ({
            path: manifest,
            enabled: false,
          })),
        },
      });
      writePrivateFileAtomic(
        path.join(artifactDir, 'config.toml'),
        `${config.trimEnd()}\n`,
      );
      installCodexPrivateHookTrust(artifactDir, providerHome);
      activateArtifact(token, {
        artifactDir,
        providerHome: null,
        configFiles: ['config.toml', 'hooks.json'],
        syncBack: false,
      });
      return {
        env: {
          CODEX_HOME: artifactDir,
          CODEX_SQLITE_HOME: providerSessionHome,
        },
        providerSessionHome,
        // Codex 0.145.0: remove the native collaboration tool so only the
        // main-owned Nexus roster can create workers.
        extraArgs: ['--strict-config', '--disable', 'multi_agent'],
        serverName,
        artifactDir,
        codexPermissionProfile: permissionProfile,
        codexProcessSandbox: Object.freeze({
          sandboxDir: artifactDir,
          processHome: shellHome,
          processTmp: shellTmp,
          providerStatePaths: Object.freeze([...providerStatePaths]),
          protectedWritePaths: Object.freeze([...protectedWritePaths]),
        }),
      };
    },
  );
}

/**
 * Operator-choice mission workers keep live auth identity (and therefore the
 * frictionless autopilot UX) but must not inherit ambient user MCP servers
 * from `~/.codex/config.toml`. Those servers (cloudflare/figma/higgsfield…)
 * handshake on boot and can freeze the pane before the pasted prompt reaches
 * the model — observed as identical output across 30s windows and a Maestro
 * `blocked_user` decision that was correct for the hang, wrong for product.
 *
 * This preparer is deliberately thinner than `prepareCodexGovernedSession`:
 * no filesystem deny table or Seatbelt profile. Main may project exact workspace
 * trust and suppress unsolicited Daybreak in this private config only.
 * It only stages a private CODEX_HOME with auth linked and `mcp_servers`
 * stripped. Nexus still arrives via the existing `-c mcp_servers.nexus_*`
 * argv injection from `codexMcpArgs`.
 */
export function prepareCodexOperatorMissionHome(
  token: string,
  options: CliMcpSessionOptions & { preserveUserMcp?: boolean } = {},
): Pick<
  CliMcpSessionResult,
  'env' | 'artifactDir' | 'serverName' | 'providerSessionHome'
> {
  if (!token) throw new Error('Nexus MCP token is required');
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ?? path.join(home, '.codex'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ??
      path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  return withCliMcpArtifactTransaction(
    'codex',
    token,
    artifactRoot,
    (preparedArtifactDir) => {
      const artifactDir = fs.realpathSync.native(preparedArtifactDir);
      const serverName = runtimeServerName(token);
      const providerSessionHome = prepareCodexConversationState(
        artifactDir,
        options,
      );
      linkSelectedEntries(
        providerHome,
        artifactDir,
        options.preserveUserMcp
          ? CODEX_OPERATOR_PROFILE
          : CODEX_LIVE_AUTH_STATE,
      );
      // Preserve user prefs (model, TUI, notice) but drop ambient MCP servers.
      // A malformed user config degrades to an empty private config — Nexus
      // still injects via argv, so the worker remains callable.
      let userConfig: Record<string, unknown> = {};
      let userConfigReadable = true;
      try {
        userConfig = readTomlObject(path.join(providerHome, 'config.toml'));
      } catch {
        userConfig = {};
        userConfigReadable = false;
      }
      const { mcp_servers: _drop, ...rest } = userConfig;
      const baseConfig = options.preserveUserMcp ? userConfig : rest;
      const startupConfig = userConfigReadable
        ? codexStartupConfig(baseConfig, options, providerHome)
        : baseConfig;
      const contextWindow =
        typeof userConfig.model_context_window === 'number'
          ? Math.max(userConfig.model_context_window, 1_000_000)
          : 1_000_000;
      const autoCompactLimit =
        typeof userConfig.model_auto_compact_token_limit === 'number'
          ? Math.max(userConfig.model_auto_compact_token_limit, 950_000)
          : 950_000;
      writePrivateFileAtomic(
        path.join(artifactDir, 'config.toml'),
        `${stringify({
          ...startupConfig,
          model_context_window: contextWindow,
          model_auto_compact_token_limit: autoCompactLimit,
          sqlite_home: providerSessionHome,
          ...(options.heavyCommandEnv ? { shell_environment_policy: {
            ...(typeof userConfig.shell_environment_policy === 'object' && userConfig.shell_environment_policy ? userConfig.shell_environment_policy : {}),
            set: {
              ...((userConfig.shell_environment_policy as { set?: Record<string, string> } | undefined)?.set ?? {}),
              ...heavyCommandShellPolicy(options.heavyCommandEnv),
            },
          } } : {}),
        }).trimEnd()}\n`,
      );
      // Skills live under the private home so deliverGrantedSkills can land
      // without mutating the operator's real ~/.codex/skills permanently.
      ensurePrivateDirectory(path.join(artifactDir, 'skills'));
      installCodexPrivateHookTrust(artifactDir, providerHome);
      activateArtifact(token, {
        artifactDir,
        providerHome,
        configFiles: [
          ...CODEX_OVERLAY_EXCLUSIONS,
          'shell_snapshots',
          '.codex-global-state.json',
        ],
        // Auth may refresh in-pane; sync the linked auth.json back. Never
        // sync the stripped config (it would wipe the user's MCP roster).
        syncBack: true,
      });
      return {
        env: {
          CODEX_HOME: artifactDir,
          CODEX_SQLITE_HOME: providerSessionHome,
        },
        providerSessionHome,
        serverName,
        artifactDir,
      };
    },
  );
}

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { stringify } from 'smol-toml';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkSelectedEntries,
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
const CODEX_STATE_DATABASE = 'state_5.sqlite';
const CODEX_SESSIONS_DIRECTORY = 'sessions';
const CODEX_RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function privateTempPath(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

/**
 * Copy one already-resolved provider file through an open descriptor. A size
 * or timestamp change during the copy is treated as an active writer and
 * fails closed instead of publishing a torn rollout.
 */
function copyPrivateFileAtomic(source: string, target: string): void {
  ensurePrivateDirectory(path.dirname(target));
  const tmp = privateTempPath(target);
  let sourceFd: number | null = null;
  let targetFd: number | null = null;
  try {
    sourceFd = fs.openSync(
      source,
      fs.constants.O_RDONLY |
        (typeof fs.constants.O_NOFOLLOW === 'number'
          ? fs.constants.O_NOFOLLOW
          : 0),
    );
    const before = fs.fstatSync(sourceFd);
    if (!before.isFile()) {
      throw new Error('Codex exact resume rollout is not a regular file');
    }
    targetFd = fs.openSync(tmp, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(256 * 1_024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const read = fs.readSync(sourceFd, buffer, 0, length, offset);
      if (read === 0) {
        throw new Error('Codex exact resume rollout changed during snapshot');
      }
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(
          targetFd,
          buffer,
          written,
          read - written,
          offset + written,
        );
        if (count === 0) {
          throw new Error('Codex exact resume rollout copy made no progress');
        }
        written += count;
      }
      offset += read;
    }
    const after = fs.fstatSync(sourceFd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino
    ) {
      throw new Error('Codex exact resume rollout changed during snapshot');
    }
    fs.fsyncSync(targetFd);
    fs.closeSync(targetFd);
    targetFd = null;
    fs.closeSync(sourceFd);
    sourceFd = null;
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (targetFd !== null) {
      try {
        fs.closeSync(targetFd);
      } catch {
        // Preserve the original failure.
      }
    }
    if (sourceFd !== null) {
      try {
        fs.closeSync(sourceFd);
      } catch {
        // Preserve the original failure.
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function sqliteTableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Materialize only the main-selected Codex thread into the private profile.
 *
 * `VACUUM INTO` is SQLite's transactionally consistent snapshot operation and
 * includes committed WAL content without ever linking the provider WAL/SHM.
 * The private copy is then reduced to the exact thread and repointed at the
 * one privately copied rollout before Codex can start.
 */
function materializeCodexExactResumeState(options: {
  providerHome: string;
  artifactDir: string;
  sessionId: string;
}): void {
  if (!CODEX_RESUME_ID.test(options.sessionId)) {
    throw new Error('Codex exact resume session id is invalid');
  }

  let providerRoot: string;
  let sessionsRoot: string;
  let sourceDatabase: string;
  try {
    providerRoot = fs.realpathSync.native(options.providerHome);
    sourceDatabase = fs.realpathSync.native(
      path.join(providerRoot, CODEX_STATE_DATABASE),
    );
    sessionsRoot = fs.realpathSync.native(
      path.join(providerRoot, CODEX_SESSIONS_DIRECTORY),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(
        'Codex exact resume state database or sessions directory is unavailable',
      );
    }
    throw error;
  }
  if (
    !pathBelongsTo(providerRoot, sourceDatabase) ||
    !pathBelongsTo(providerRoot, sessionsRoot) ||
    !fs.statSync(sourceDatabase).isFile() ||
    !fs.statSync(sessionsRoot).isDirectory()
  ) {
    throw new Error('Codex exact resume state escapes its provider home');
  }

  const targetDatabase = path.join(
    options.artifactDir,
    CODEX_STATE_DATABASE,
  );
  const temporaryDatabase = privateTempPath(targetDatabase);
  let sourceDb: Database.Database | null = null;
  let privateDb: Database.Database | null = null;
  try {
    sourceDb = new Database(sourceDatabase, {
      readonly: true,
      fileMustExist: true,
    });
    sourceDb.pragma('busy_timeout = 5000');
    sourceDb.prepare('VACUUM INTO ?').run(temporaryDatabase);
    sourceDb.close();
    sourceDb = null;
    fs.chmodSync(temporaryDatabase, 0o600);

    privateDb = new Database(temporaryDatabase, { fileMustExist: true });
    privateDb.pragma('busy_timeout = 5000');
    const tables = sqliteTableNames(privateDb);
    if (!tables.has('threads') || !tables.has('backfill_state')) {
      throw new Error('Codex exact resume database schema is incomplete');
    }
    const reviewedTables = new Set([
      '_sqlx_migrations',
      'backfill_state',
      'external_agent_config_imports',
      'remote_control_enrollments',
      'sqlite_sequence',
      'thread_dynamic_tools',
      'thread_spawn_edges',
      'threads',
    ]);
    const unknownTables = [...tables].filter(
      (table) => !reviewedTables.has(table),
    );
    if (unknownTables.length > 0) {
      throw new Error(
        'Codex exact resume database schema contains unreviewed state',
      );
    }
    const backfill = privateDb
      .prepare('SELECT status FROM backfill_state WHERE id = 1')
      .get() as { status?: unknown } | undefined;
    if (backfill?.status !== 'complete') {
      throw new Error('Codex exact resume database backfill is incomplete');
    }
    const thread = privateDb
      .prepare('SELECT rollout_path FROM threads WHERE id = ?')
      .get(options.sessionId) as { rollout_path?: unknown } | undefined;
    if (
      !thread ||
      typeof thread.rollout_path !== 'string' ||
      !thread.rollout_path.trim()
    ) {
      throw new Error('Codex exact resume thread is unavailable');
    }

    const recordedRollout = path.isAbsolute(thread.rollout_path)
      ? path.resolve(thread.rollout_path)
      : path.resolve(providerRoot, thread.rollout_path);
    let sourceRollout: string;
    try {
      sourceRollout = fs.realpathSync.native(recordedRollout);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error('Codex exact resume rollout is unavailable');
      }
      throw error;
    }
    if (
      !pathBelongsTo(sessionsRoot, sourceRollout) ||
      !fs.statSync(sourceRollout).isFile()
    ) {
      throw new Error(
        'Codex exact resume rollout escapes its provider sessions directory',
      );
    }
    const rolloutRelative = path.relative(sessionsRoot, sourceRollout);
    const privateRollout = path.join(
      options.artifactDir,
      CODEX_SESSIONS_DIRECTORY,
      rolloutRelative,
    );
    copyPrivateFileAtomic(sourceRollout, privateRollout);

    const reduceSnapshot = privateDb.transaction(() => {
      // Dynamic/account tools and remote-control state are not session
      // continuity. They are deliberately removed even for the retained
      // thread; the private config exposes only the Nexus MCP surface.
      if (tables.has('thread_dynamic_tools')) {
        privateDb!.prepare('DELETE FROM thread_dynamic_tools').run();
      }
      if (tables.has('thread_spawn_edges')) {
        privateDb!.prepare('DELETE FROM thread_spawn_edges').run();
      }
      if (tables.has('external_agent_config_imports')) {
        privateDb!.prepare('DELETE FROM external_agent_config_imports').run();
      }
      if (tables.has('remote_control_enrollments')) {
        privateDb!.prepare('DELETE FROM remote_control_enrollments').run();
      }
      const backfillColumns = new Set(
        (
          privateDb!.pragma('table_info(backfill_state)') as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (backfillColumns.has('last_watermark')) {
        privateDb!
          .prepare('UPDATE backfill_state SET last_watermark = NULL')
          .run();
      }
      privateDb!.prepare('DELETE FROM threads WHERE id <> ?').run(
        options.sessionId,
      );
      const updated = privateDb!
        .prepare('UPDATE threads SET rollout_path = ? WHERE id = ?')
        .run(privateRollout, options.sessionId);
      if (updated.changes !== 1) {
        throw new Error('Codex exact resume thread changed during snapshot');
      }
    });
    reduceSnapshot();
    privateDb.pragma('journal_mode = DELETE');
    privateDb.exec('VACUUM');
    const quickCheck = privateDb.pragma('quick_check', {
      simple: true,
    }) as unknown;
    if (quickCheck !== 'ok') {
      throw new Error('Codex exact resume private database is corrupt');
    }
    privateDb.close();
    privateDb = null;

    fs.rmSync(`${temporaryDatabase}-wal`, { force: true });
    fs.rmSync(`${temporaryDatabase}-shm`, { force: true });
    fs.renameSync(temporaryDatabase, targetDatabase);
    fs.chmodSync(targetDatabase, 0o600);
  } catch (error) {
    try {
      privateDb?.close();
    } catch {
      // Preserve the original failure.
    }
    try {
      sourceDb?.close();
    } catch {
      // Preserve the original failure.
    }
    fs.rmSync(temporaryDatabase, { force: true });
    fs.rmSync(`${temporaryDatabase}-wal`, { force: true });
    fs.rmSync(`${temporaryDatabase}-shm`, { force: true });
    throw error;
  }
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
      const sessionStateEntries = CODEX_LIVE_AUTH_STATE;
      const providerStatePaths = codexProviderStateRealPaths(
        providerHome,
        sessionStateEntries,
      );
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
      linkSelectedEntries(providerHome, artifactDir, sessionStateEntries);
      if (options.codexResumeSessionId) {
        materializeCodexExactResumeState({
          providerHome,
          artifactDir,
          sessionId: options.codexResumeSessionId,
        });
      }
      mirrorGovernedSkills(
        'codex',
        home,
        [path.join(artifactDir, 'skills')],
        policy.allowedSkills,
      );
      // Preferências de TUI que o Codex tenta gravar em config.toml no boot.
      // O arquivo é immutable (protectedWritePaths); se já estiverem aqui, o
      // TUI não tenta batchWrite e some o vermelho "Failed to save … config.toml".
      const sealedModel = options.model?.trim() || undefined;
      const config = stringify({
        ...(sealedModel ? { model: sealedModel } : {}),
        default_permissions: permissionProfile,
        shell_environment_policy: {
          inherit: 'core',
          ignore_default_excludes: false,
          set: {
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
          code_mode_host: false,
          computer_use: false,
          enable_mcp_apps: false,
          goals: false,
          // Hooks in this private CODEX_HOME come only from main-owned `-c
          // hooks.*` overrides. Keep the engine active so UserPromptSubmit can
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
            'gpt-5.3': 'gpt-5.5',
            'gpt-5.4': 'gpt-5.5',
            'gpt-5.4-mini': 'gpt-5.5',
            'gpt-5.4-nano': 'gpt-5.5',
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
      activateArtifact(token, {
        artifactDir,
        providerHome: null,
        configFiles: ['config.toml'],
        syncBack: false,
      });
      return {
        env: { CODEX_HOME: artifactDir },
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

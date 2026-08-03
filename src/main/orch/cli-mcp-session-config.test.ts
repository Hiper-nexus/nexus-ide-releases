import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupCliMcpSession,
  prepareCodexGovernedSession,
  prepareCodexOperatorMissionHome,
  prepareGrokMcpSession,
  prepareKimiMcpSession,
  prepareOpenCodeMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-config';
import {
  CODEX_READ_ONLY_PERMISSION_PROFILE,
  CODEX_WORKSPACE_PERMISSION_PROFILE,
} from '../pty/codex-native-authority';

const roots: string[] = [];
const tokens: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-mcp-'));
  roots.push(root);
  return root;
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function expectedArtifactDir(
  artifactRoot: string,
  provider: 'codex' | 'opencode' | 'kimi' | 'grok',
  token: string,
): string {
  return path.join(
    artifactRoot,
    provider,
    createHash('sha256').update(token).digest('hex').slice(0, 32),
  );
}

afterEach(() => {
  for (const token of tokens.splice(0)) cleanupCliMcpSession(token);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('pre-activation CLI artifact rollback', () => {
  it('removes Codex overlay when exact-cwd authority validation fails', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const token = 'codex-preactivation-failure';

    expect(() =>
      prepareCodexGovernedSession(token, {
        home,
        artifactRoot: artifacts,
        codexNativeAuthority: 'read-only',
      }),
    ).toThrow(/exact execution cwd/i);
    expect(fs.existsSync(expectedArtifactDir(artifacts, 'codex', token))).toBe(
      false,
    );
  });

  it('removes Kimi overlay when governed policy resolution fails', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const token = 'kimi-preactivation-failure';
    const options = { home, artifactRoot: artifacts };
    Object.defineProperty(options, 'governed', {
      get(): never {
        throw new Error('synthetic Kimi policy failure');
      },
    });

    expect(() =>
      prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, options),
    ).toThrow(/Kimi policy failure/);
    expect(fs.existsSync(expectedArtifactDir(artifacts, 'kimi', token))).toBe(
      false,
    );
  });

  it('removes Grok overlay when governed policy resolution fails', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const token = 'grok-preactivation-failure';
    const options = { home, artifactRoot: artifacts };
    Object.defineProperty(options, 'governed', {
      get(): never {
        throw new Error('synthetic Grok policy failure');
      },
    });

    expect(() =>
      prepareGrokMcpSession('http://127.0.0.1:4300/mcp', token, options),
    ).toThrow(/Grok policy failure/);
    expect(fs.existsSync(expectedArtifactDir(artifacts, 'grok', token))).toBe(
      false,
    );
  });

  it('removes OpenCode overlay when governed skill construction fails', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const token = 'opencode-preactivation-failure';
    write(path.join(home, '.nexus', 'generated-skills'), 'not-a-directory');

    expect(() =>
      prepareOpenCodeMcpSession('http://127.0.0.1:4100/mcp', token, {
        home,
        artifactRoot: artifacts,
        governed: true,
        allowedSkills: [],
      }),
    ).toThrow(/(?:ENOTDIR|not a directory)/i);
    expect(
      fs.existsSync(expectedArtifactDir(artifacts, 'opencode', token)),
    ).toBe(false);
  });
});

describe('advisory provider-state home grant', () => {
  it('exposes the real provider home for a governed Kimi overlay', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const providerHome = path.join(home, '.kimi-code');
    // The overlay symlinks session/auth state from here; the sandbox must be
    // told to grant it or the CLI's session mkdir fails with EPERM.
    write(path.join(providerHome, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    write(path.join(providerHome, 'credentials', 'kimi-code.json'), '{}');
    const token = 'kimi-provider-state-home';
    tokens.push(token);

    const result = prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, {
      home,
      artifactRoot: artifacts,
      providerHome,
      governed: true,
      allowedSkills: [],
    });

    expect(result.providerStateHome).toBe(providerHome);
  });

  it('exposes the real provider home for a governed Grok overlay', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const providerHome = path.join(home, '.grok');
    write(path.join(providerHome, 'config.toml'), '');
    const token = 'grok-provider-state-home';
    tokens.push(token);

    const result = prepareGrokMcpSession('http://127.0.0.1:4300/mcp', token, {
      home,
      artifactRoot: artifacts,
      providerHome,
      governed: true,
      allowedSkills: [],
    });

    expect(result.providerStateHome).toBe(providerHome);
  });

  it('omits the provider-state home for a non-governed (direct pane) overlay', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const providerHome = path.join(home, '.kimi-code');
    write(path.join(providerHome, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const token = 'kimi-direct-no-provider-state';
    tokens.push(token);

    const result = prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, {
      home,
      artifactRoot: artifacts,
      providerHome,
      governed: false,
      allowedSkills: null,
    });

    expect(result.providerStateHome).toBeUndefined();
  });
});

describe('prepareOpenCodeMcpSession', () => {
  it('uses the official inline config and expands the bearer from env at runtime', () => {
    const token = 'opencode-secret-token';
    const result = prepareOpenCodeMcpSession(
      'http://127.0.0.1:4100/mcp',
      token,
    );
    const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT) as {
      mcp: Record<
        string,
        {
          type: string;
          url: string;
          enabled: boolean;
          headers: Record<string, string>;
        }
      >;
    };
    const server = config.mcp[result.serverName];

    expect(server).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:4100/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer {env:NEXUS_MCP_TOKEN}' },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.artifactDir).toBeNull();
  });

  it('isolates governed config/plugins and exposes only Nexus plus granted skills', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    write(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        plugin: ['external-plugin'],
        mcp: { external: { type: 'local', command: ['external-mcp'] } },
      }),
    );
    write(
      path.join(home, '.config', 'opencode', 'skills', 'allowed', 'SKILL.md'),
      '# allowed',
    );
    write(
      path.join(home, '.config', 'opencode', 'skills', 'blocked', 'SKILL.md'),
      '# blocked',
    );
    const token = 'opencode-governed-token';
    tokens.push(token);

    const result = prepareOpenCodeMcpSession(
      'http://127.0.0.1:4100/mcp',
      token,
      {
        home,
        artifactRoot: artifacts,
        governed: true,
        allowedSkills: ['allowed'],
      },
    );
    const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT) as {
      mcp: Record<string, unknown>;
    };

    expect(Object.keys(config.mcp)).toEqual([result.serverName]);
    expect(result.extraArgs).toContain('--pure');
    expect(result.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(result.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
    expect(result.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe('1');
    expect(result.env.XDG_CONFIG_HOME).toBe(result.artifactDir);
    expect(result.env.OPENCODE_CONFIG_DIR).not.toBe(
      path.join(home, '.config', 'opencode'),
    );
    expect(
      fs.existsSync(
        path.join(
          result.env.OPENCODE_CONFIG_DIR,
          'skills',
          'allowed',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(result.env.OPENCODE_CONFIG_DIR, 'skills', 'blocked'),
      ),
    ).toBe(false);
    expect(JSON.stringify(result.env)).not.toContain('external-mcp');
    expect(JSON.stringify(result.env)).not.toContain('external-plugin');
  });
});

describe('prepareCodexOperatorMissionHome', () => {
  it('keeps live auth and strips ambient mcp_servers from the private home', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const codexHome = path.join(home, '.codex');
    write(path.join(codexHome, 'auth.json'), '{"tokens":{"access":"live"}}');
    write(
      path.join(codexHome, 'config.toml'),
      [
        'model = "gpt-5.4"',
        '[mcp_servers.cloudflare-api]',
        'command = "cloudflare-mcp"',
        '[mcp_servers.figma]',
        'url = "https://example.invalid/figma"',
        '[tui]',
        'resume_cwd = "current"',
      ].join('\n') + '\n',
    );
    const token = 'operator-mission-mcp-isolation';
    tokens.push(token);
    const result = prepareCodexOperatorMissionHome(token, {
      home,
      providerHome: codexHome,
      artifactRoot: artifacts,
    });
    expect(result.env.CODEX_HOME).toBe(result.artifactDir);
    expect(result.artifactDir).not.toBe(codexHome);
    expect(fs.existsSync(path.join(result.env.CODEX_HOME, 'auth.json'))).toBe(
      true,
    );
    const privateConfig = fs.readFileSync(
      path.join(result.env.CODEX_HOME, 'config.toml'),
      'utf8',
    );
    const parsed = parse(privateConfig) as Record<string, unknown>;
    expect(parsed.mcp_servers).toBeUndefined();
    expect(parsed.model).toBe('gpt-5.4');
    expect(privateConfig).not.toContain('cloudflare');
    expect(privateConfig).not.toContain('figma');
    expect(fs.existsSync(path.join(result.env.CODEX_HOME, 'skills'))).toBe(
      true,
    );
  });
});

describe('prepareCodexGovernedSession', () => {
  it('starts with zero provider history while preserving only live auth', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const codexHome = path.join(home, '.codex');
    write(path.join(codexHome, 'auth.json'), '{}');
    write(path.join(codexHome, '.codex-global-state.json'), '{"apps":true}');
    write(path.join(codexHome, 'history.jsonl'), '{"session_id":"historic"}');
    write(path.join(codexHome, 'session_index.jsonl'), '{"id":"historic"}');
    write(path.join(codexHome, 'state_5.sqlite'), 'historic database');
    write(
      path.join(codexHome, 'sessions', '2026', 'rollout-historic.jsonl'),
      '{"type":"historic"}',
    );
    write(
      path.join(codexHome, 'shell_snapshots', 'historic.sh'),
      'export HISTORIC=1',
    );
    write(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-mcp"\n',
    );
    write(path.join(codexHome, 'plugins', 'external', 'plugin.json'), '{}');
    write(path.join(codexHome, 'skills', 'allowed', 'SKILL.md'), '# allowed');
    write(path.join(codexHome, 'skills', 'blocked', 'SKILL.md'), '# blocked');
    const worktree = path.join(root, 'worktree "quoted" \\segment');
    const cwd = path.join(worktree, 'packages', 'app');
    fs.mkdirSync(cwd, { recursive: true });
    const repoSkill = path.join(
      worktree,
      '.agents',
      'skills',
      'repo "evil"',
      'SKILL.md',
    );
    const projectCodexSkill = path.join(
      cwd,
      '.codex',
      'skills',
      'project-evil',
      'SKILL.md',
    );
    const userSkill = path.join(
      home,
      '.agents',
      'skills',
      'user-evil',
      'SKILL.md',
    );
    const adminSkillsRoot = path.join(root, 'admin-skills');
    const adminSkill = path.join(adminSkillsRoot, 'admin-evil', 'SKILL.md');
    const outsideSkillDirectory = path.join(
      root,
      'outside "traversal" \\skill',
    );
    const outsideSkill = path.join(outsideSkillDirectory, 'SKILL.md');
    for (const manifest of [
      repoSkill,
      projectCodexSkill,
      userSkill,
      adminSkill,
      outsideSkill,
    ]) {
      write(manifest, '# external');
    }
    fs.symlinkSync(
      outsideSkillDirectory,
      path.join(worktree, '.agents', 'skills', 'linked-outside'),
    );
    const token = 'codex-governed-token';
    tokens.push(token);

    const result = prepareCodexGovernedSession(token, {
      home,
      artifactRoot: artifacts,
      allowedSkills: ['allowed'],
      cwd,
      workspaceRoot: worktree,
      codexNativeAuthority: 'workspace-write',
      codexAdminSkillsRoot: adminSkillsRoot,
      model: 'gpt-5.5',
    });

    expect(result.env.CODEX_HOME).toBe(result.artifactDir);
    expect(result.extraArgs).toEqual([
      '--strict-config',
      '--disable',
      'multi_agent',
    ]);
    const privateConfigPath = path.join(result.env.CODEX_HOME, 'config.toml');
    const privateConfig = parse(fs.readFileSync(privateConfigPath, 'utf8')) as {
      model?: string;
      default_permissions?: string;
      features?: Record<string, boolean>;
      projects?: Record<string, { trust_level?: string }>;
      permissions?: Record<
        string,
        {
          filesystem?: Record<string, string>;
          network?: {
            enabled?: boolean;
            mode?: string;
            enable_socks5?: boolean;
            enable_socks5_udp?: boolean;
            allow_upstream_proxy?: boolean;
            dangerously_allow_non_loopback_proxy?: boolean;
            dangerously_allow_all_unix_sockets?: boolean;
            allow_local_binding?: boolean;
            domains?: Record<string, string>;
          };
        }
      >;
      shell_environment_policy?: {
        inherit?: string;
        ignore_default_excludes?: boolean;
        set?: Record<string, string>;
      };
      notice?: { model_migrations?: Record<string, string> };
      tui?: {
        resume_cwd?: string;
        model_availability_nux?: Record<string, number>;
      };
      skills?: {
        bundled?: { enabled?: boolean };
        config?: Array<{ path?: string; enabled?: boolean }>;
      };
    };
    expect(result.codexPermissionProfile).toBe(
      CODEX_WORKSPACE_PERMISSION_PROFILE,
    );
    expect(privateConfig.default_permissions).toBe(
      CODEX_WORKSPACE_PERMISSION_PROFILE,
    );
    expect(privateConfig.features).toEqual({
      apps: false,
      auth_elicitation: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      code_mode_host: false,
      computer_use: false,
      enable_mcp_apps: false,
      goals: false,
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
    });
    expect(privateConfig.projects).toEqual({
      [fs.realpathSync(cwd)]: { trust_level: 'untrusted' },
    });
    expect(
      privateConfig.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE],
    ).toEqual({
      filesystem: expect.objectContaining({
        ':root': 'deny',
        [fs.realpathSync(worktree)]: 'write',
        [path.join(result.env.CODEX_HOME, 'shell-home')]: 'write',
        [path.join(result.env.CODEX_HOME, 'shell-tmp')]: 'write',
      }),
      network: { enabled: false },
    });
    expect(
      privateConfig.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
        ?.filesystem,
    ).not.toHaveProperty(':minimal');
    expect(privateConfig.shell_environment_policy).toEqual({
      inherit: 'core',
      ignore_default_excludes: false,
      set: {
        HOME: path.join(result.env.CODEX_HOME, 'shell-home'),
        TMPDIR: path.join(result.env.CODEX_HOME, 'shell-tmp'),
      },
    });
    expect(privateConfig.model).toBe('gpt-5.5');
    expect(privateConfig.notice?.model_migrations?.['gpt-5.4']).toBe('gpt-5.5');
    expect(privateConfig.tui).toEqual({
      resume_cwd: 'current',
      model_availability_nux: { 'gpt-5.5': 4 },
    });
    expect(privateConfig.skills?.bundled).toEqual({ enabled: false });
    expect(privateConfig.skills?.config).toEqual(
      [repoSkill, projectCodexSkill, userSkill, adminSkill, outsideSkill]
        .map((manifest) => ({
          path: fs.realpathSync(manifest),
          enabled: false,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    );
    expect(fs.statSync(privateConfigPath).mode & 0o777).toBe(0o600);
    const privateConfigRaw = fs.readFileSync(privateConfigPath, 'utf8');
    expect(privateConfigRaw).not.toContain('external-mcp');
    expect(privateConfigRaw).not.toContain(token);
    expect(privateConfigRaw).not.toContain('NEXUS_MCP_TOKEN');
    const filesystem =
      privateConfig.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
        ?.filesystem ?? {};
    const protectedControlRoots = [cwd, path.dirname(cwd), worktree].flatMap(
      (tier) => [
        path.join(fs.realpathSync(tier), '.agents'),
        path.join(fs.realpathSync(tier), '.codex'),
      ],
    );
    for (const protectedRoot of protectedControlRoots) {
      expect(filesystem[protectedRoot]).toBe('deny');
      expect(result.codexProcessSandbox?.protectedWritePaths).toContain(
        protectedRoot,
      );
    }
    expect(filesystem[path.join(result.env.CODEX_HOME, 'skills')]).toBe('read');
    expect(filesystem[path.join(result.env.CODEX_HOME, 'config.toml')]).toBe(
      'deny',
    );
    expect(
      filesystem[path.join(result.env.CODEX_HOME, 'shell-home', '.agents')],
    ).toBe('deny');
    expect(
      filesystem[path.join(result.env.CODEX_HOME, 'shell-home', '.codex')],
    ).toBe('deny');
    expect(result.codexProcessSandbox?.protectedWritePaths).toEqual(
      expect.arrayContaining([
        path.join(result.env.CODEX_HOME, 'config.toml'),
        fs.realpathSync(outsideSkillDirectory),
        fs.realpathSync(path.dirname(repoSkill)),
        fs.realpathSync(path.dirname(projectCodexSkill)),
      ]),
    );
    expect(result.codexProcessSandbox).toMatchObject({
      sandboxDir: result.env.CODEX_HOME,
      processHome: path.join(result.env.CODEX_HOME, 'shell-home'),
      processTmp: path.join(result.env.CODEX_HOME, 'shell-tmp'),
      providerStatePaths: [fs.realpathSync(path.join(codexHome, 'auth.json'))],
    });
    expect(filesystem).not.toHaveProperty(result.env.CODEX_HOME);
    expect(filesystem).not.toHaveProperty(
      path.join(result.env.CODEX_HOME, 'auth.json'),
    );
    expect(
      fs.readdirSync(path.join(result.env.CODEX_HOME, 'shell-tmp')),
    ).toEqual([]);
    expect(fs.existsSync(path.join(result.env.CODEX_HOME, 'plugins'))).toBe(
      false,
    );
    expect(fs.realpathSync(path.join(result.env.CODEX_HOME, 'auth.json'))).toBe(
      fs.realpathSync(path.join(codexHome, 'auth.json')),
    );
    for (const forbidden of [
      '.codex-global-state.json',
      'history.jsonl',
      'session_index.jsonl',
      'state_5.sqlite',
      'state_5.sqlite-wal',
      'state_5.sqlite-shm',
      'sessions',
      'shell_snapshots',
    ]) {
      expect(fs.existsSync(path.join(result.env.CODEX_HOME, forbidden))).toBe(
        false,
      );
    }
    expect(result.codexProcessSandbox?.providerStatePaths).not.toEqual(
      expect.arrayContaining([
        fs.realpathSync(path.join(codexHome, 'state_5.sqlite')),
        fs.realpathSync(path.join(codexHome, 'sessions')),
      ]),
    );
    expect(
      fs.existsSync(
        path.join(result.env.CODEX_HOME, 'skills', 'allowed', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(privateConfig.skills?.config).not.toContainEqual(
      expect.objectContaining({
        path: path.join(result.env.CODEX_HOME, 'skills', 'allowed', 'SKILL.md'),
      }),
    );
    // Codex 0.145 only loads requirements.toml from the managed /etc/MDM
    // layer. Do not create a misleading user-home file that the CLI ignores.
    expect(
      fs.existsSync(path.join(result.env.CODEX_HOME, 'requirements.toml')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(result.env.CODEX_HOME, 'skills', 'blocked')),
    ).toBe(false);
  });

  it('materializes only an exact main-owned resume as private DB and rollout snapshots', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const codexHome = path.join(home, '.codex');
    const worktree = path.join(root, 'worktree');
    const exactId = '019d0000-0000-7000-8000-000000000001';
    const otherId = '019d0000-0000-7000-8000-000000000002';
    const exactRelative = path.join(
      '2026',
      '07',
      '26',
      `rollout-${exactId}.jsonl`,
    );
    const otherRelative = path.join(
      '2026',
      '07',
      '25',
      `rollout-${otherId}.jsonl`,
    );
    const exactSource = path.join(codexHome, 'sessions', exactRelative);
    const otherSource = path.join(codexHome, 'sessions', otherRelative);
    write(path.join(codexHome, 'auth.json'), '{}');
    write(path.join(codexHome, 'history.jsonl'), '{"id":"legacy"}');
    write(path.join(codexHome, '.codex-global-state.json'), '{"apps":true}');
    write(exactSource, '{"type":"exact"}\n');
    write(otherSource, '{"type":"other"}\n');
    fs.mkdirSync(worktree, { recursive: true });
    const sourceDatabasePath = path.join(codexHome, 'state_5.sqlite');
    const sourceDb = new Database(sourceDatabasePath);
    sourceDb.pragma('journal_mode = WAL');
    sourceDb.pragma('wal_autocheckpoint = 0');
    sourceDb.exec(`
      CREATE TABLE backfill_state (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL
      );
      CREATE TABLE external_agent_config_imports (
        import_id TEXT PRIMARY KEY
      );
      CREATE TABLE remote_control_enrollments (
        websocket_url TEXT PRIMARY KEY
      );
    `);
    sourceDb
      .prepare('INSERT INTO backfill_state (id, status) VALUES (1, ?)')
      .run('complete');
    const insertThread = sourceDb.prepare(
      'INSERT INTO threads (id, rollout_path) VALUES (?, ?)',
    );
    insertThread.run(exactId, exactSource);
    insertThread.run(otherId, otherSource);
    sourceDb
      .prepare(
        'INSERT INTO thread_dynamic_tools (thread_id, position, name) VALUES (?, 0, ?)',
      )
      .run(exactId, 'external-app-tool');
    sourceDb
      .prepare(
        'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)',
      )
      .run(exactId, otherId);
    sourceDb
      .prepare(
        'INSERT INTO external_agent_config_imports (import_id) VALUES (?)',
      )
      .run('external-import');
    sourceDb
      .prepare(
        'INSERT INTO remote_control_enrollments (websocket_url) VALUES (?)',
      )
      .run('wss://remote.example.test');

    const token = 'codex-exact-resume-token';
    tokens.push(token);
    try {
      const result = prepareCodexGovernedSession(token, {
        home,
        artifactRoot: artifacts,
        cwd: worktree,
        workspaceRoot: worktree,
        allowedSkills: [],
        codexNativeAuthority: 'workspace-write',
        codexResumeSessionId: exactId,
        codexAdminSkillsRoot: path.join(root, 'missing-admin-skills'),
      });
      const privateDatabasePath = path.join(
        result.env.CODEX_HOME,
        'state_5.sqlite',
      );
      const privateRolloutPath = path.join(
        result.env.CODEX_HOME,
        'sessions',
        exactRelative,
      );

      expect(fs.lstatSync(privateDatabasePath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(privateRolloutPath).isSymbolicLink()).toBe(false);
      expect(mode(privateDatabasePath)).toBe(0o600);
      expect(mode(privateRolloutPath)).toBe(0o600);
      expect(fs.readFileSync(privateRolloutPath, 'utf8')).toBe(
        '{"type":"exact"}\n',
      );
      expect(
        fs.existsSync(
          path.join(result.env.CODEX_HOME, 'sessions', otherRelative),
        ),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(result.env.CODEX_HOME, 'state_5.sqlite-wal')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(result.env.CODEX_HOME, 'state_5.sqlite-shm')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(result.env.CODEX_HOME, 'history.jsonl')),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(result.env.CODEX_HOME, '.codex-global-state.json'),
        ),
      ).toBe(false);
      expect(result.codexProcessSandbox?.providerStatePaths).toEqual([
        fs.realpathSync(path.join(codexHome, 'auth.json')),
      ]);
      expect(result.codexProcessSandbox?.providerStatePaths).not.toEqual(
        expect.arrayContaining([
          fs.realpathSync(sourceDatabasePath),
          fs.realpathSync(path.join(codexHome, 'sessions')),
        ]),
      );

      const privateDb = new Database(privateDatabasePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(
          privateDb.prepare('SELECT id, rollout_path FROM threads').all(),
        ).toEqual([{ id: exactId, rollout_path: privateRolloutPath }]);
        expect(
          privateDb.prepare('SELECT COUNT(*) AS count FROM thread_dynamic_tools').get(),
        ).toEqual({ count: 0 });
        expect(
          privateDb.prepare('SELECT COUNT(*) AS count FROM thread_spawn_edges').get(),
        ).toEqual({ count: 0 });
        expect(
          privateDb
            .prepare('SELECT COUNT(*) AS count FROM external_agent_config_imports')
            .get(),
        ).toEqual({ count: 0 });
        expect(
          privateDb
            .prepare('SELECT COUNT(*) AS count FROM remote_control_enrollments')
            .get(),
        ).toEqual({ count: 0 });
        expect(privateDb.pragma('quick_check', { simple: true })).toBe('ok');
      } finally {
        privateDb.close();
      }
      expect(
        sourceDb.prepare('SELECT COUNT(*) AS count FROM threads').get(),
      ).toEqual({ count: 2 });
      expect(
        sourceDb
          .prepare('SELECT rollout_path FROM threads WHERE id = ?')
          .get(exactId),
      ).toEqual({ rollout_path: exactSource });
    } finally {
      sourceDb.close();
    }
  });

  it('fails closed before activation when the exact resume thread is absent', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const codexHome = path.join(home, '.codex');
    const worktree = path.join(root, 'worktree');
    const requestedId = '019d0000-0000-7000-8000-000000000003';
    write(path.join(codexHome, 'auth.json'), '{}');
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const sourceDb = new Database(path.join(codexHome, 'state_5.sqlite'));
    sourceDb.exec(`
      CREATE TABLE backfill_state (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      INSERT INTO backfill_state (id, status) VALUES (1, 'complete');
    `);
    sourceDb.close();
    const token = 'codex-missing-resume-token';

    expect(() =>
      prepareCodexGovernedSession(token, {
        home,
        artifactRoot: artifacts,
        cwd: worktree,
        workspaceRoot: worktree,
        allowedSkills: [],
        codexNativeAuthority: 'workspace-write',
        codexResumeSessionId: requestedId,
        codexAdminSkillsRoot: path.join(root, 'missing-admin-skills'),
      }),
    ).toThrow(/exact resume thread is unavailable/i);
    expect(fs.existsSync(expectedArtifactDir(artifacts, 'codex', token))).toBe(
      false,
    );
  });

  it('fails closed before activation when the exact rollout is absent', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const codexHome = path.join(home, '.codex');
    const worktree = path.join(root, 'worktree');
    const requestedId = '019d0000-0000-7000-8000-000000000004';
    const missingRollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      `rollout-${requestedId}.jsonl`,
    );
    write(path.join(codexHome, 'auth.json'), '{}');
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const sourceDb = new Database(path.join(codexHome, 'state_5.sqlite'));
    sourceDb.exec(`
      CREATE TABLE backfill_state (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      INSERT INTO backfill_state (id, status) VALUES (1, 'complete');
    `);
    sourceDb
      .prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)')
      .run(requestedId, missingRollout);
    sourceDb.close();
    const token = 'codex-missing-rollout-token';

    expect(() =>
      prepareCodexGovernedSession(token, {
        home,
        artifactRoot: artifacts,
        cwd: worktree,
        workspaceRoot: worktree,
        allowedSkills: [],
        codexNativeAuthority: 'workspace-write',
        codexResumeSessionId: requestedId,
        codexAdminSkillsRoot: path.join(root, 'missing-admin-skills'),
      }),
    ).toThrow(/exact resume rollout is unavailable/i);
    expect(fs.existsSync(expectedArtifactDir(artifacts, 'codex', token))).toBe(
      false,
    );
  });

  it('keeps workspace-write available while package subprocess network is explicitly disabled', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const worktree = path.join(root, 'offline-worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const token = 'codex-offline-writer-token';
    tokens.push(token);

    const result = prepareCodexGovernedSession(token, {
      home,
      artifactRoot: path.join(root, 'artifacts'),
      cwd: worktree,
      workspaceRoot: worktree,
      allowedSkills: [],
      codexNativeAuthority: 'workspace-write',
      codexAdminSkillsRoot: path.join(root, 'missing-admin-skills'),
    });
    const config = parse(
      fs.readFileSync(path.join(result.env.CODEX_HOME, 'config.toml'), 'utf8'),
    ) as {
      default_permissions?: string;
      features?: { network_proxy?: boolean };
      permissions?: Record<
        string,
        {
          filesystem?: Record<string, string>;
          network?: { enabled?: boolean };
        }
      >;
    };

    expect(config.default_permissions).toBe(CODEX_WORKSPACE_PERMISSION_PROFILE);
    expect(config.features?.network_proxy).toBe(false);
    expect(
      config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]?.network,
    ).toEqual({ enabled: false });
    expect(
      config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]?.filesystem?.[
        fs.realpathSync(worktree)
      ],
    ).toBe('write');
  });

  it('compiles a read-only profile with no writable project root', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const worktree = path.join(root, 'review-worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const token = 'codex-read-only-token';
    tokens.push(token);

    const result = prepareCodexGovernedSession(token, {
      home,
      artifactRoot: path.join(root, 'artifacts'),
      cwd: worktree,
      workspaceRoot: worktree,
      allowedSkills: [],
      codexNativeAuthority: 'read-only',
      codexAdminSkillsRoot: path.join(root, 'missing-admin-skills'),
    });
    const config = parse(
      fs.readFileSync(path.join(result.env.CODEX_HOME, 'config.toml'), 'utf8'),
    ) as {
      default_permissions?: string;
      features?: Record<string, boolean>;
      permissions?: Record<
        string,
        {
          filesystem?: Record<string, string>;
          network?: { enabled?: boolean };
        }
      >;
    };

    expect(result.codexPermissionProfile).toBe(
      CODEX_READ_ONLY_PERMISSION_PROFILE,
    );
    expect(config.default_permissions).toBe(CODEX_READ_ONLY_PERMISSION_PROFILE);
    expect(config.features?.network_proxy).toBe(false);
    expect(
      config.permissions?.[CODEX_READ_ONLY_PERMISSION_PROFILE]?.network,
    ).toEqual({ enabled: false });
    expect(
      config.permissions?.[CODEX_READ_ONLY_PERMISSION_PROFILE]?.filesystem,
    ).toEqual(
      expect.objectContaining({
        ':root': 'deny',
        [fs.realpathSync(worktree)]: 'read',
      }),
    );
    expect(
      config.permissions?.[CODEX_READ_ONLY_PERMISSION_PROFILE]?.filesystem,
    ).not.toHaveProperty(':minimal');
    expect(
      Object.entries(
        config.permissions?.[CODEX_READ_ONLY_PERMISSION_PROFILE]?.filesystem ??
          {},
      ).filter(([, access]) => access === 'write'),
    ).toEqual([
      [path.join(result.env.CODEX_HOME, 'shell-home'), 'write'],
      [path.join(result.env.CODEX_HOME, 'shell-tmp'), 'write'],
    ]);
  });
});

describe('prepareKimiMcpSession', () => {
  it('overlays KIMI_CODE_HOME, preserves user data and never writes the bearer', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const kimiHome = path.join(home, '.kimi-code');
    const realMcp = path.join(kimiHome, 'mcp.json');
    const realConfig = path.join(kimiHome, 'config.toml');
    write(realConfig, 'default_permission_mode = "manual"\n');
    write(
      realMcp,
      JSON.stringify({
        mcpServers: { userServer: { url: 'https://mcp.example.test' } },
      }),
    );
    write(path.join(kimiHome, 'credentials', 'kimi-code.json'), '{}');
    const originalMcp = fs.readFileSync(realMcp, 'utf8');
    const token = 'kimi-secret-token';
    tokens.push(token);

    const result = prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, {
      home,
      artifactRoot: artifacts,
    });
    const overlayMcp = path.join(result.env.KIMI_CODE_HOME, 'mcp.json');
    const raw = fs.readFileSync(overlayMcp, 'utf8');
    const config = JSON.parse(raw) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(config.mcpServers.userServer).toEqual({
      url: 'https://mcp.example.test',
    });
    expect(config.mcpServers[result.serverName]).toEqual({
      url: 'http://127.0.0.1:4200/mcp',
      bearerTokenEnvVar: 'NEXUS_MCP_TOKEN',
      enabled: true,
    });
    expect(raw).not.toContain(token);
    expect(fs.readFileSync(realMcp, 'utf8')).toBe(originalMcp);
    // config.toml is now a PRIVATE merged copy (emdash wave 1 status hooks):
    // user's own keys survive, Nexus entries carry the marker, the real
    // profile is never touched and no token lands in either file.
    const overlayConfig = path.join(result.env.KIMI_CODE_HOME, 'config.toml');
    const overlayToml = fs.readFileSync(overlayConfig, 'utf8');
    expect(overlayToml).toContain('default_permission_mode = "manual"');
    expect(overlayToml).toContain('NEXUS_HOOK_STATUS');
    expect(overlayToml).not.toContain(token);
    expect(fs.readFileSync(realConfig, 'utf8')).toBe(
      'default_permission_mode = "manual"\n',
    );
    expect(mode(result.artifactDir!)).toBe(0o700);
    expect(mode(overlayMcp)).toBe(0o600);
    expect(mode(overlayConfig)).toBe(0o600);

    cleanupCliMcpSession(token);
    expect(fs.existsSync(result.artifactDir!)).toBe(false);
    expect(fs.readFileSync(realMcp, 'utf8')).toBe(originalMcp);
  });

  it('drops external MCPs/hooks/skills from a governed overlay', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const kimiHome = path.join(home, '.kimi-code');
    write(
      path.join(kimiHome, 'mcp.json'),
      JSON.stringify({
        mcpServers: { external: { command: 'external-mcp' } },
      }),
    );
    write(
      path.join(kimiHome, 'config.toml'),
      '[[hooks]]\nevent = "Stop"\ncommand = "external-hook"\n',
    );
    write(path.join(kimiHome, 'skills', 'allowed', 'SKILL.md'), '# allowed');
    write(path.join(kimiHome, 'skills', 'blocked', 'SKILL.md'), '# blocked');
    write(
      path.join(kimiHome, 'credentials', 'kimi-code.json'),
      JSON.stringify({
        access_token: 'at-test',
        refresh_token: 'rt-test',
      }),
    );
    write(path.join(kimiHome, 'device_id'), 'device-uuid-test\n');
    write(path.join(kimiHome, 'oauth', 'kimi-code'), '');
    const token = 'kimi-governed-token';
    tokens.push(token);

    const result = prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, {
      home,
      artifactRoot: artifacts,
      governed: true,
      allowedSkills: ['allowed'],
    });
    const overlayHome = result.env.KIMI_CODE_HOME;
    const rawMcp = fs.readFileSync(path.join(overlayHome, 'mcp.json'), 'utf8');
    const rawConfig = fs.readFileSync(
      path.join(overlayHome, 'config.toml'),
      'utf8',
    );

    expect(rawMcp).not.toContain('external-mcp');
    expect(rawConfig).not.toContain('external-hook');
    expect(rawConfig).toContain('NEXUS_HOOK_STATUS');
    expect(result.extraArgs).toEqual([
      '--skills-dir',
      path.join(overlayHome, 'skills'),
    ]);
    expect(
      fs.existsSync(path.join(overlayHome, 'skills', 'allowed', 'SKILL.md')),
    ).toBe(true);
    expect(fs.existsSync(path.join(overlayHome, 'skills', 'blocked'))).toBe(
      false,
    );
    // OAuth refresh in the ephemeral KIMI_CODE_HOME needs the live token
    // material AND the device identity — presence of the overlay alone is not
    // enough if these entries were omitted from the governed link set.
    expect(
      fs.readFileSync(path.join(overlayHome, 'device_id'), 'utf8'),
    ).toBe('device-uuid-test\n');
    expect(
      fs.existsSync(path.join(overlayHome, 'credentials', 'kimi-code.json')),
    ).toBe(true);
    expect(fs.existsSync(path.join(overlayHome, 'oauth', 'kimi-code'))).toBe(
      true,
    );
  });

  it('fails closed instead of linking an unparseable governed config', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const kimiHome = path.join(home, '.kimi-code');
    write(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    write(
      path.join(kimiHome, 'config.toml'),
      'hooks = [{ command = "external-hook" \n',
    );
    const token = 'kimi-governed-malformed-token';
    tokens.push(token);

    const result = prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, {
      home,
      artifactRoot: artifacts,
      governed: true,
      allowedSkills: [],
    });

    expect(
      fs.existsSync(path.join(result.env.KIMI_CODE_HOME, 'config.toml')),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(result.env.KIMI_CODE_HOME, 'mcp.json'), 'utf8'),
    ).not.toContain('external-hook');
  });
});

describe('prepareGrokMcpSession', () => {
  it('overlays GROK_HOME with native config.toml and preserves the real profile', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const grokHome = path.join(home, '.grok');
    const realConfig = path.join(grokHome, 'config.toml');
    const auth = path.join(grokHome, 'auth.json');
    const sessionMarker = path.join(grokHome, 'sessions', 'keep.json');
    const skillMarker = path.join(grokHome, 'skills', 'keep', 'SKILL.md');
    write(auth, '{}');
    write(sessionMarker, '{"session":true}');
    write(skillMarker, '# Keep\n');
    write(
      realConfig,
      '[ui]\nmax_thoughts_width = 99\n\n' +
        '[mcp_servers.userServer]\ncommand = "user-mcp"\nenabled = false\n',
    );
    const originalConfig = fs.readFileSync(realConfig, 'utf8');
    const token = 'grok-secret-token';
    tokens.push(token);

    const result = prepareGrokMcpSession('http://127.0.0.1:4300/mcp', token, {
      home,
      artifactRoot: artifacts,
    });
    const privateConfig = path.join(result.env.GROK_HOME, 'config.toml');
    const raw = fs.readFileSync(privateConfig, 'utf8');
    const config = parse(raw) as {
      ui: { max_thoughts_width: number };
      mcp_servers: Record<string, Record<string, unknown>>;
    };

    expect(result.env).toEqual({ GROK_HOME: result.artifactDir });
    expect(result.extraArgs).toEqual([]);
    expect(result.env.GROK_HOME).not.toBe(grokHome);
    expect(config.ui.max_thoughts_width).toBe(99);
    expect(config.mcp_servers.userServer).toEqual({
      command: 'user-mcp',
      enabled: false,
    });
    expect(config.mcp_servers[result.serverName]).toEqual({
      url: 'http://127.0.0.1:4300/mcp',
      enabled: true,
      bearer_token_env_var: 'NEXUS_MCP_TOKEN',
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('Authorization');
    expect(raw).not.toContain('Bearer ');
    expect(raw).toContain('bearer_token_env_var = "NEXUS_MCP_TOKEN"');
    expect(raw).toContain(`[mcp_servers.${result.serverName}]`);
    expect(fs.readFileSync(realConfig, 'utf8')).toBe(originalConfig);
    expect(fs.realpathSync(path.join(result.env.GROK_HOME, 'auth.json'))).toBe(
      fs.realpathSync(auth),
    );
    expect(fs.realpathSync(path.join(result.env.GROK_HOME, 'sessions'))).toBe(
      fs.realpathSync(path.dirname(sessionMarker)),
    );
    expect(fs.realpathSync(path.join(result.env.GROK_HOME, 'skills'))).toBe(
      fs.realpathSync(path.join(grokHome, 'skills')),
    );
    expect(mode(result.artifactDir!)).toBe(0o700);
    expect(mode(privateConfig)).toBe(0o600);

    // emdash wave 1: the overlay carries a Nexus-owned hooks/nexus.json with
    // marked, env-only status commands; the real profile never gains it.
    const hooksDoc = path.join(result.env.GROK_HOME, 'hooks', 'nexus.json');
    const hooksRaw = fs.readFileSync(hooksDoc, 'utf8');
    expect(hooksRaw).toContain('NEXUS_HOOK_STATUS');
    expect(hooksRaw).toContain('$NEXUS_GATE_TOKEN');
    expect(hooksRaw).not.toContain(token);
    expect(mode(hooksDoc)).toBe(0o600);
    expect(fs.existsSync(path.join(grokHome, 'hooks'))).toBe(false);

    cleanupCliMcpSession(token);
    expect(fs.existsSync(result.artifactDir!)).toBe(false);
    expect(fs.readFileSync(realConfig, 'utf8')).toBe(originalConfig);
    expect(fs.readFileSync(sessionMarker, 'utf8')).toBe('{"session":true}');
    expect(fs.readFileSync(skillMarker, 'utf8')).toBe('# Keep\n');
    // Sync-back must not leak the Nexus hooks doc into the real profile.
    expect(fs.existsSync(path.join(grokHome, 'hooks', 'nexus.json'))).toBe(
      false,
    );
  });

  it("links the user's own Grok hooks through next to the Nexus doc", () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const grokHome = path.join(home, '.grok');
    const userHook = path.join(grokHome, 'hooks', 'mine.json');
    write(userHook, '{"hooks":{}}');
    const token = 'grok-hooks-link-token';
    tokens.push(token);

    const result = prepareGrokMcpSession('http://127.0.0.1:4300/mcp', token, {
      home,
      artifactRoot: artifacts,
    });

    expect(
      fs.realpathSync(path.join(result.env.GROK_HOME, 'hooks', 'mine.json')),
    ).toBe(fs.realpathSync(userHook));
    expect(
      fs.existsSync(path.join(result.env.GROK_HOME, 'hooks', 'nexus.json')),
    ).toBe(true);
  });

  it('isolates HOME and drops external MCPs/plugins/hooks/skills when governed', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const grokHome = path.join(home, '.grok');
    const workspaceRoot = path.join(root, 'workspace');
    const cwd = path.join(workspaceRoot, 'packages', 'app');
    write(path.join(grokHome, 'auth.json'), '{}');
    write(
      path.join(grokHome, 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-mcp"\n' +
        '\n[plugins]\nenabled = ["external-plugin"]\n',
    );
    write(path.join(grokHome, 'hooks', 'external.json'), '{"external":true}');
    write(path.join(grokHome, 'skills', 'allowed', 'SKILL.md'), '# allowed');
    write(path.join(grokHome, 'skills', 'blocked', 'SKILL.md'), '# blocked');
    write(
      path.join(home, '.claude', 'plugins', 'external', 'plugin.json'),
      '{}',
    );
    write(
      path.join(workspaceRoot, '.grok', 'skills', 'project', 'SKILL.md'),
      '# project',
    );
    write(
      path.join(
        workspaceRoot,
        '.grok',
        'plugins',
        'project-plugin',
        'plugin.json',
      ),
      '{}',
    );
    const token = 'grok-governed-token';
    tokens.push(token);

    const result = prepareGrokMcpSession('http://127.0.0.1:4300/mcp', token, {
      home,
      artifactRoot: artifacts,
      governed: true,
      allowedSkills: ['allowed'],
      cwd,
      workspaceRoot,
    });
    const raw = fs.readFileSync(
      path.join(result.env.GROK_HOME, 'config.toml'),
      'utf8',
    );

    expect(raw).not.toContain('external-mcp');
    expect(raw).not.toContain('external-plugin');
    expect(result.extraArgs).toEqual(['--no-subagents']);
    expect(result.env.HOME).not.toBe(home);
    // Never disable Grok's folder-trust gate: `GROK_FOLDER_TRUST=0` means
    // "ungate" (trust project hooks/MCPs), not "deny".
    expect(result.env.GROK_FOLDER_TRUST).toBeUndefined();
    expect(result.env.GROK_CLAUDE_SKILLS_ENABLED).toBe('false');
    expect(result.env.GROK_CURSOR_SKILLS_ENABLED).toBe('false');
    expect(result.env.GROK_CLAUDE_HOOKS_ENABLED).toBe('false');
    expect(result.env.GROK_CURSOR_HOOKS_ENABLED).toBe('false');
    expect(
      fs.existsSync(path.join(result.env.GROK_HOME, 'managed-settings.json')),
    ).toBe(false);
    const parsed = parse(raw) as {
      skills: { ignore: string[] };
      plugins: { disabled: string[] };
    };
    expect(parsed.skills.ignore).toContain(
      path.join(workspaceRoot, '.grok', 'skills'),
    );
    expect(parsed.skills.ignore).toContain(
      path.join(cwd, '.agents', 'commands'),
    );
    expect(parsed.plugins.disabled).toContain('project-plugin');
    const trust = parse(
      fs.readFileSync(
        path.join(result.env.GROK_HOME, 'trusted_folders.toml'),
        'utf8',
      ),
    ) as { folders: Record<string, { trusted: boolean }> };
    expect(trust.folders[workspaceRoot]?.trusted).toBe(false);
    expect(fs.existsSync(path.join(result.env.HOME, '.claude'))).toBe(false);
    expect(
      fs.existsSync(path.join(result.env.GROK_HOME, 'hooks', 'external.json')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(result.env.GROK_HOME, 'skills', 'allowed', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(result.env.GROK_HOME, 'skills', 'blocked')),
    ).toBe(false);
  });
});

describe('purgeStaleCliMcpSessions', () => {
  it('purges only bounded Kimi/Grok session dirs without following symlinks', () => {
    const root = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const outside = path.join(root, 'outside');
    const outsideMarker = path.join(outside, 'keep.txt');
    const kimiStale = path.join(artifacts, 'kimi', 'a'.repeat(32));
    const grokStale = path.join(artifacts, 'grok', 'b'.repeat(32));
    const grokSymlink = path.join(artifacts, 'grok', 'c'.repeat(32));
    const unrelated = path.join(artifacts, 'grok', 'keep-me');
    write(outsideMarker, 'outside-safe');
    write(path.join(kimiStale, 'mcp.json'), '{}');
    write(path.join(grokStale, 'config.toml'), '[mcp_servers.stale]\n');
    write(path.join(unrelated, 'marker.txt'), 'unrelated-safe');
    fs.symlinkSync(outside, path.join(kimiStale, 'outside-link'));
    fs.symlinkSync(outside, grokSymlink);

    const result = purgeStaleCliMcpSessions({ artifactRoot: artifacts });

    expect(result.removed).toBe(3);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(kimiStale)).toBe(false);
    expect(fs.existsSync(grokStale)).toBe(false);
    expect(fs.existsSync(grokSymlink)).toBe(false);
    expect(fs.readFileSync(outsideMarker, 'utf8')).toBe('outside-safe');
    expect(fs.readFileSync(path.join(unrelated, 'marker.txt'), 'utf8')).toBe(
      'unrelated-safe',
    );
  });

  it('preserves artifacts registered as active in this process', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const token = 'active-kimi-token';
    tokens.push(token);
    const active = prepareKimiMcpSession('http://127.0.0.1:4200/mcp', token, {
      home,
      artifactRoot: artifacts,
    });

    const result = purgeStaleCliMcpSessions({ artifactRoot: artifacts });

    expect(result.skippedActive).toBe(1);
    expect(fs.existsSync(active.artifactDir!)).toBe(true);
  });

  it('rejects a symlinked artifact root instead of traversing its target', () => {
    const root = tempRoot();
    const outside = path.join(root, 'outside-artifacts');
    const outsideMarker = path.join(
      outside,
      'kimi',
      'f'.repeat(32),
      'keep.txt',
    );
    const linkedArtifacts = path.join(root, 'linked-artifacts');
    write(outsideMarker, 'never-delete');
    fs.symlinkSync(outside, linkedArtifacts);

    const result = purgeStaleCliMcpSessions({
      artifactRoot: linkedArtifacts,
    });

    expect(result.failed).toBe(4);
    expect(result.removed).toBe(0);
    expect(fs.readFileSync(outsideMarker, 'utf8')).toBe('never-delete');
  });
});

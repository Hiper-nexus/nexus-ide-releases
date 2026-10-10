import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterSchema, type CliPtyAdapter } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import type { AgentSpawnDecoration } from '../pty/pty-manager';
import type { BoundSpawnAuthority } from './spawn-authority';
import { getContext, resetGateForTests } from './gate';
import { assertIsolatedWriterGitTool, isIsolatedWriterContext } from './isolated-writer-policy';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { resetHandoffSpoolForTests, startHandoffSpool } from './handoff-spool';
import { NEXUS_BROWSER_WORKER_TOOLS } from './nexus-browser-policy';
import { armPrivateRuntimeClaudeConsent } from '../runtime-gate-mode';

const privateRuntimePaths = vi.hoisted(() => ({ userData: undefined as string | undefined }));

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    getAppPath: () => process.cwd(),
    getPath: () => privateRuntimePaths.userData ?? path.join(os.homedir(), '.nexus-test-user-data'),
  },
  dialog: { showMessageBox: vi.fn() },
}));

const homePolicyDeps = vi.hoisted(() => ({
  getOrchSettings: vi.fn(() => ({
    squadCliPolicy:
      'operator-choice' as 'operator-choice' | 'governed',
  })),
}));

vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: homePolicyDeps.getOrchSettings,
}));

// Registro MCP no perfil nativo roda o binário real (`agy mcp add`,
// `devin mcp add`) ou grava ~/.config/muse/settings.json — nunca num teste.
const cliRegistration = vi.hoisted(() => ({
  agy: vi.fn(() => ({ registered: true })),
  devin: vi.fn(() => ({ registered: true })),
  muse: vi.fn((mcpUrl: string, token: string) => ({
    env: { NEXUS_MCP_URL: mcpUrl, NEXUS_MCP_TOKEN: token },
    registered: true,
  })),
}));

vi.mock('./cli-mcp-session-agy', async (orig) => ({
  ...(await orig<typeof import('./cli-mcp-session-agy')>()),
  ensureAgyNexusMcpRegistration: cliRegistration.agy,
}));

vi.mock('./cli-mcp-session-devin', async (orig) => ({
  ...(await orig<typeof import('./cli-mcp-session-devin')>()),
  ensureDevinNexusMcpRegistration: cliRegistration.devin,
}));

vi.mock('./cli-mcp-session-muse', async (orig) => ({
  ...(await orig<typeof import('./cli-mcp-session-muse')>()),
  prepareMuseMcpSession: cliRegistration.muse,
}));

import {
  buildArmsRuntimeDescriptor,
  hasApprovedMissionProjectTrust,
  prepareAgentSpawnDecoration,
  resolveArmsRuntimeDescriptorPath,
  resolveArmsRuntimeInstance,
} from './mcp-server';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-wiring-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'home'));
  return root;
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

/** Escreve o hub do operador em `<workspace>/.nexus/mcp-hub.json`. */
function writeHub(workspaceRoot: string, hub: unknown): void {
  write(
    path.join(workspaceRoot, '.nexus', 'mcp-hub.json'),
    typeof hub === 'string' ? hub : JSON.stringify(hub, null, 2),
  );
}

/** Lê o config MCP por sessão que o spawn realmente passou no `--mcp-config`. */
function generatedClaudeMcpServers(
  decoration: AgentSpawnDecoration,
): Record<string, Record<string, unknown>> {
  const index = decoration.extraArgs.indexOf('--mcp-config');
  if (index < 0) throw new Error('expected a generated --mcp-config');
  const file = decoration.extraArgs[index + 1]!;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  return parsed.mcpServers;
}

const HUB_STDIO_SERVER = {
  id: 'context7',
  name: 'Context7',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp'],
};
const HUB_HTTP_SERVER = {
  id: 'linear',
  name: 'Linear',
  transport: 'streamable-http',
  url: 'https://mcp.linear.app/mcp',
};

function adapter(
  id:
    | 'claude'
    | 'glm'
    | 'codex'
    | 'agy'
    | 'aider'
    | 'opencode'
    | 'mimo-code'
    | 'kimi'
    | 'grok',
): CliPtyAdapter {
  const claudeFamily = id === 'claude' || id === 'glm';
  return {
    id,
    label: id,
    bin: id === 'glm' ? '/mock/bin/claude' : `/mock/bin/${id}`,
    env: {
      static:
        id === 'glm'
          ? { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
          : {},
      passthrough: [],
      ephemeralHome: false,
    },
    quirks: {
      mcpAutoload: claudeFamily,
      nexusMcp: claudeFamily ? 'autoload' : id === 'aider' ? 'none' : id,
    },
  } as unknown as CliPtyAdapter;
}

function authority(
  cwd: string,
  governed: boolean,
  unrestricted = false,
): BoundSpawnAuthority {
  const scope = {
    version: 1 as const,
    installationId: 'installation-wiring',
    projectId: 'project-wiring',
    checkoutId: 'checkout-wiring',
    rootRealPath: cwd,
    identitySource: 'provisional' as const,
  };
  return {
    source: governed ? 'pending' : 'direct-user',
    cwd,
    scope,
    coordinationScope: scope,
    context: governed
      ? {
          missionId: 'mission-wiring',
          contextRevision: unrestricted ? undefined : 'revision-wiring',
          workerIncarnationId: 'worker-wiring',
          role: 'worker',
          allowedTools: unrestricted ? null : [],
          allowedSkills: unrestricted ? null : ['allowed'],
          scope,
          executionScope: scope,
        }
      : null,
  };
}

function sealedMissionAuthority(
  cwd: string,
  overrides: {
    source?: BoundSpawnAuthority['source'];
    role?: 'orchestrator' | 'worker';
    contextRevision?: string;
    missionId?: string;
  } = {},
): BoundSpawnAuthority {
  const base = authority(cwd, true);
  const role = overrides.role ?? 'orchestrator';
  const seal = {
    intentVersion: 1,
    intentContractHash: 'a'.repeat(64),
    contextRevision: 'b'.repeat(64),
    contractHash: 'c'.repeat(64),
    squadRevisionHash: 'd'.repeat(64),
  };
  return {
    ...base,
    source: overrides.source ?? 'pending',
    context: {
      ...base.context!,
      missionId: overrides.missionId ?? 'mission-wiring',
      role,
      workerIncarnationId: role === 'worker' ? 'worker-wiring' : undefined,
      contextRevision: overrides.contextRevision ?? seal.contextRevision,
      authoritySeal: seal,
      allowedSkills: [],
    },
  };
}

function petAuthority(
  cwd: string,
  overrides: {
    source?: BoundSpawnAuthority['source'];
    squadId?: string;
    allowedTools?: string[] | null;
    missionId?: string;
    stalePersistedSeal?: boolean;
  } = {},
): BoundSpawnAuthority {
  const scope = {
    version: 1 as const,
    installationId: 'installation-pet-wiring',
    projectId: 'project-pet-wiring',
    checkoutId: 'checkout-pet-wiring',
    rootRealPath: cwd,
    identitySource: 'provisional' as const,
  };
  const maker = PET_STUDIO_SQUAD.agents[0]!;
  const source = overrides.source ?? 'legacy-squad';
  const persisted = source === 'persisted-pane';
  const contextRevision = persisted ? 'pet-context-revision' : undefined;
  return {
    source,
    cwd,
    scope,
    coordinationScope: scope,
    context: {
      ...(overrides.missionId || persisted
        ? { missionId: overrides.missionId ?? 'mission-pet-wiring' }
        : {}),
      squadId: overrides.squadId ?? PET_STUDIO_SQUAD.id,
      agentName: maker.agentName,
      role: 'orchestrator',
      allowedTools:
        overrides.allowedTools ?? [...(maker.allowedTools ?? [])],
      allowedSkills: [...(maker.allowedSkills ?? [])],
      ...(contextRevision ? { contextRevision } : {}),
      ...(persisted
        ? {
            authoritySeal: {
              intentVersion: 1,
              intentContractHash: 'a'.repeat(64),
              contextRevision: contextRevision!,
              contractHash: 'b'.repeat(64),
              squadRevisionHash: overrides.stalePersistedSeal
                ? 'c'.repeat(64)
                : snapshotSquadAuthority(PET_STUDIO_SQUAD).hash,
            },
          }
        : {}),
      scope,
      executionScope: scope,
    },
  };
}

afterEach(() => {
  privateRuntimePaths.userData = undefined;
  vi.unstubAllEnvs();
  cliRegistration.agy.mockClear();
  cliRegistration.devin.mockClear();
  cliRegistration.muse.mockClear();
  homePolicyDeps.getOrchSettings.mockReturnValue({
    squadCliPolicy: 'operator-choice',
  });
  resetGateForTests();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('mcp-server governed CLI profile wiring', () => {
  it.runIf(process.platform === 'darwin').each(['kimi', 'custom-grok'] as const)('F-1101: Main does not select Grok Bash for adapter %s', id => {
    const root = tempRoot(), home = path.join(root, 'home'), cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
    privateRuntimePaths.userData = root; vi.stubEnv('HOME', home);
    const selected = id === 'custom-grok' ? { ...adapter('grok'), id } : adapter(id);
    const decoration = prepareAgentSpawnDecoration(selected, { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false), { HOME: home, GROK_HOME: path.join(home, '.grok'), KIMI_CODE_HOME: path.join(home, '.kimi-code') })!;
    try { expect(decoration.env.GROK_SHELL).toBeUndefined(); } finally { decoration.onSpawnFailed?.(); }
  });

  it.runIf(process.platform === 'darwin').each([false, true])('F-1101: Main selects supported Grok Bash after provider merges (worker=%s)', worker => {
    const root = tempRoot(), home = path.join(root, 'home'), cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
    privateRuntimePaths.userData = root; vi.stubEnv('HOME', home);
    const prepared = { HOME: home, PATH: '/opt/homebrew/bin:/usr/bin:/bin', SHELL: '/bin/zsh', GROK_HOME: path.join(home, '.grok'),
      GROK_SHELL: '/opt/homebrew/bin/bash', BASH_ENV: '/finite/original.bash', ZDOTDIR: '/finite/original-zdot' };
    const decoration = prepareAgentSpawnDecoration(adapter('grok'), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, worker, true), prepared)!;
    try {
      expect(decoration.env.GROK_SHELL).toBe('/bin/bash');
      expect(decoration.env.NEXUS_HEAVY_ORIG_BASH_ENV).toBe(prepared.BASH_ENV);
      expect(decoration.env.NEXUS_HEAVY_ORIG_ZDOTDIR).toBe(prepared.ZDOTDIR);
      expect(prepared).toMatchObject({ GROK_SHELL: '/opt/homebrew/bin/bash', PATH: '/opt/homebrew/bin:/usr/bin:/bin', SHELL: '/bin/zsh', HOME: home });
      expect(decoration.env.NEXUS_GATE_TOKEN).toBe(decoration.authorityToken);
    } finally { decoration.onSpawnFailed?.(); }
  });

  it.each(['owned', 'foreign-key', 'foreign-route', 'missing-transport'] as const)('F-1104: actual spawn decoration requires the %s transport, independently of provider identity', changed => {
    const root = fs.realpathSync(tempRoot()), home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
    fs.chmodSync(root, 0o700); fs.chmodSync(home, 0o700); fs.mkdirSync(cwd);
    privateRuntimePaths.userData = root;
    const launchEnv = { HOME: home, NEXUS_USER_DATA_DIR: root, NEXUS_PACKAGED_SMOKE: '1', NEXUS_SMOKE_RUNTIME_GATES: '1',
      NEXUS_SMOKE_RUNTIME_GATEWAY: 'http://127.0.0.1:45678', NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: '11111111-1111-4111-8111-111111111111',
      NEXUS_SMOKE_RUNTIME_PHASE: 'exercise', ANTHROPIC_API_KEY: 'rt-11111111-1111-4111-8111-111111111111',
      ANTHROPIC_AUTH_TOKEN: 'rt-11111111-1111-4111-8111-111111111111', ANTHROPIC_BASE_URL: 'http://127.0.0.1:45678' };
    for (const [key, value] of Object.entries(launchEnv)) vi.stubEnv(key, value);
    const spawnAuthority = authority(cwd, true, true), signal = new AbortController();
    const release = armPrivateRuntimeClaudeConsent({ userData: root, gateway: launchEnv.ANTHROPIC_BASE_URL,
      gatewayNonce: launchEnv.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE, scope: spawnAuthority.coordinationScope!,
      signal: signal.signal, isCurrent: () => true });
    let decoration: AgentSpawnDecoration | null = null;
    try {
      // Only provider passthrough reaches this snapshot; runtime flags do not.
      const identityEnv = { ANTHROPIC_API_KEY: launchEnv.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: launchEnv.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL: launchEnv.ANTHROPIC_BASE_URL };
      const transportEnv = { ...identityEnv };
      if (changed === 'foreign-key') transportEnv.ANTHROPIC_API_KEY = 'foreign-11111111-1111-4111-8111-111111111111';
      if (changed === 'foreign-route') transportEnv.ANTHROPIC_BASE_URL = 'http://127.0.0.1:45679';
      decoration = prepareAgentSpawnDecoration(adapter('claude'), { kind: 'cli-agent', cols: 80, rows: 24 }, spawnAuthority,
        identityEnv, changed === 'missing-transport' ? undefined : transportEnv);
      expect(decoration).not.toBeNull();
      const profile = JSON.parse(fs.readFileSync(path.join(decoration!.env.HOME, '.claude.json'), 'utf8'));
      if (changed === 'owned') expect(profile.customApiKeyResponses).toEqual({ approved: ['11-8111-111111111111'], rejected: [] });
      else expect(profile.customApiKeyResponses).toBeUndefined();
    } finally { release(); decoration?.onSpawnFailed?.(); }
  });
  it.each([
    { squadCliPolicy: 'operator-choice' as const, readOnly: false, denied: false },
    { squadCliPolicy: 'governed' as const, readOnly: false, denied: true },
    // F-1157: o somente-leitura não corta mais o Task; só o Hardened explícito.
    { squadCliPolicy: 'operator-choice' as const, readOnly: true, denied: false },
  ])('scopes the native Claude Task restriction to explicit authority ($squadCliPolicy/readOnly=$readOnly)', ({ squadCliPolicy, readOnly, denied }) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    homePolicyDeps.getOrchSettings.mockReturnValue({ squadCliPolicy });
    const spawnAuthority = authority(cwd, true);
    spawnAuthority.context!.readOnly = readOnly;
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      spawnAuthority,
    );
    if (!decoration) throw new Error('expected Claude decoration');
    try {
      expect(decoration.extraArgs.includes('Task')).toBe(denied);
      expect(decoration.extraArgs.includes('--disallowedTools')).toBe(denied);
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it.each([
    { role: 'orchestrator' as const, denied: false },
    { role: 'worker' as const, denied: false },
  ])('F-1157: a free $role keeps native Claude Task, the orchestrator included', ({ role, denied }) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    homePolicyDeps.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
    const spawnAuthority = sealedMissionAuthority(cwd, { role });
    spawnAuthority.context!.readOnly = false;
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      spawnAuthority,
    );
    if (!decoration) throw new Error('expected Claude decoration');
    try {
      expect(decoration.extraArgs.includes('Task')).toBe(denied);
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it('pins the MiMo API key selected by Main instead of the native subscription account', () => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    write(path.join(home, '.local', 'share', 'mimocode', 'auth.json'), '{"xiaomi":{"type":"api","key":"native-account"}}');
    const decoration = prepareAgentSpawnDecoration(
      adapter('mimo-code'), { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true), { XIAOMI_API_KEY: 'selected-api-key' },
    );
    if (!decoration) throw new Error('expected MiMo API-key decoration');
    try {
      const config = JSON.parse(decoration.env.MIMOCODE_CONFIG_CONTENT);
      expect(config.provider.xiaomi.options).toEqual({ apiKey: '{env:XIAOMI_API_KEY}', baseURL: 'https://api.xiaomimimo.com/v1' });
      expect(fs.readFileSync(path.join(decoration.env.MIMOCODE_HOME, 'data', 'auth.json'), 'utf8').trim()).toBe('{}');
      expect(decoration.providerStateReadPaths).not.toContain(path.join(home, '.local', 'share', 'mimocode', 'auth.json'));
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it.each([false, true])('binds MiMo account, checkout state and MCP without Claude flags (governed=%s)', (governed) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    const providerHome = path.join(home, 'managed-mimo');
    fs.mkdirSync(cwd, { recursive: true });
    write(path.join(providerHome, 'data', 'auth.json'), '{"xiaomi":{"type":"api","key":"selected"}}');
    writeHub(cwd, { schemaVersion: 1, servers: [HUB_HTTP_SERVER, HUB_STDIO_SERVER] });
    vi.stubEnv('HOME', home);
    // F-247: worker de missão só recebe MCPs do hub pedidos no allowlist.
    const spawnAuthority = authority(cwd, governed);
    if (spawnAuthority.context) {
      spawnAuthority.context.allowedTools = [
        'mcp__context7__*',
        'mcp__linear__*',
      ];
    }
    const decoration = prepareAgentSpawnDecoration(
      adapter('mimo-code'), { kind: 'cli-agent', cols: 80, rows: 24 },
      spawnAuthority, { MIMOCODE_HOME: providerHome },
    );
    if (!decoration) throw new Error('expected MiMo decoration');
    try {
      const state = path.join(home, '.nexus-test-user-data', 'provider-state', 'mimo-code', 'checkout-wiring');
      const auth = path.join(providerHome, 'data', 'auth.json');
      expect(decoration.env.MIMOCODE_DB).toBe(path.join(state, 'database', 'mimocode.db'));
      expect(fs.realpathSync(path.join(decoration.env.MIMOCODE_HOME, 'data', 'auth.json'))).toBe(fs.realpathSync(auth));
      expect(decoration.providerStateReadPaths).toEqual(expect.arrayContaining([auth, state]));
      expect(decoration.providerStateWritePaths).toEqual([auth, state]);
      expect(decoration.extraArgs).not.toContain('--mcp-config');
      expect(decoration.extraArgs).not.toContain('--settings');
      expect(decoration.extraArgs.includes('--pure')).toBe(governed);
      const config = JSON.parse(decoration.env.MIMOCODE_CONFIG_CONTENT);
      expect(config.mcp.context7.command).toEqual(['npx', '-y', '@upstash/context7-mcp']);
      expect(config.mcp.linear.url).toBe('https://mcp.linear.app/mcp');
      const nexus = config.mcp[Object.keys(config.mcp).find(key => key.startsWith('nexus_'))!];
      expect(nexus.headers.Authorization).toBe('Bearer {env:NEXUS_MCP_TOKEN}');
      expect(decoration.env.NEXUS_MCP_TOKEN).toBeTruthy();
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it('keeps managed Claude auth separate from the native login and disposable conversation home', () => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const authDir = path.join(home, '.nexus/managed-accounts/claude/account-b/auth');
    write(path.join(authDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"synthetic-b"}}');
    write(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"native-a@example.test"}}');
    write(path.join(home, '.claude/.credentials.json'), 'native-fixture');
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, true),
      { CLAUDE_SECURESTORAGE_CONFIG_DIR: authDir, CLAUDE_CODE_OAUTH_TOKEN: 'stale-env-fixture' },
    )!;
    expect(decoration.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(authDir);
    expect(decoration.envRemove).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(decoration.env.HOME).not.toBe(authDir);
    expect(decoration.providerStateWritePaths).toContain(authDir);
    expect(decoration.providerStateReadPaths).not.toContain(path.join(home, '.claude/.credentials.json'));
    expect(JSON.parse(fs.readFileSync(path.join(decoration.env.HOME, '.claude.json'), 'utf8')).oauthAccount).toBeUndefined();
    decoration.onSpawnFailed?.();
    expect(fs.existsSync(authDir)).toBe(true);
  });

  it.each([false, true])('binds OpenCode data and exact auth grants to Main checkout identity (governed=%s)', (governed) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    const providerHome = path.join(home, 'managed-opencode');
    fs.mkdirSync(cwd, { recursive: true });
    write(path.join(providerHome, 'opencode', 'auth.json'), '{"account":"selected"}');
    write(path.join(providerHome, 'opencode', 'opencode.db'), 'external database');
    vi.stubEnv('HOME', home);
    const decoration = prepareAgentSpawnDecoration(
      adapter('opencode'), { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, governed), { XDG_DATA_HOME: providerHome },
    );
    if (!decoration) throw new Error('expected OpenCode decoration');
    try {
      const state = path.join(home, '.nexus-test-user-data', 'provider-state', 'opencode', 'checkout-wiring');
      const auth = path.join(providerHome, 'opencode', 'auth.json');
      expect(decoration.env.XDG_DATA_HOME.startsWith(state + path.sep)).toBe(true);
      expect(decoration.env.XDG_STATE_HOME).toBe(path.join(state, 'state'));
      expect(decoration.env.OPENCODE_DB).toBe(path.join(state, 'database', 'opencode.db'));
      expect(fs.readFileSync(path.join(decoration.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8')).toContain('selected');
      expect(decoration.providerStateReadPaths).toEqual([path.join(process.cwd(), 'resources/heavy-command'), auth, state]);
      expect(decoration.providerStateWritePaths).toEqual([auth, state]);
      expect(fs.existsSync(decoration.env.OPENCODE_DB)).toBe(false);
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it.each(['grok', 'kimi'] as const)('binds %s conversations and sandbox grants to Main checkout identity', (id) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const providerHome = path.join(home, id === 'grok' ? '.grok' : '.kimi-code');
    fs.mkdirSync(providerHome, { recursive: true });
    // F-569: the grant is the exact auth surface the overlay links back to the
    // real home (Grok: auth.json; Kimi: credentials/), never the whole home.
    const authPath = path.join(providerHome, id === 'grok' ? 'auth.json' : 'credentials');
    if (id === 'grok') fs.writeFileSync(authPath, '{}');
    else fs.mkdirSync(authPath, { recursive: true });
    fs.writeFileSync(path.join(providerHome, 'device_id'), 'secret-not-for-the-worker');
    const envKey = id === 'grok' ? 'GROK_HOME' : 'KIMI_CODE_HOME';
    const decoration = prepareAgentSpawnDecoration(
      adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true), { [envKey]: providerHome },
    )!;
    const state = path.join(home, '.nexus-test-user-data', 'provider-state', id, 'checkout-wiring');
    expect(fs.realpathSync(path.join(decoration.env[envKey], 'sessions'))).toBe(fs.realpathSync(path.join(state, 'sessions')));
    expect(decoration.providerStateReadPaths).toEqual([path.join(process.cwd(), 'resources/heavy-command'), authPath, state]);
    expect(decoration.providerStateWritePaths).toEqual([authPath, state]);
    expect(decoration.providerStateReadPaths).not.toContain(providerHome);
    expect(decoration.providerStateWritePaths).not.toContain(providerHome);
  });

  it.each(['grok', 'kimi'] as const)('still grants the durable %s session home when no auth material exists yet', (id) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const providerHome = path.join(home, id === 'grok' ? '.grok' : '.kimi-code');
    fs.mkdirSync(providerHome, { recursive: true });
    const envKey = id === 'grok' ? 'GROK_HOME' : 'KIMI_CODE_HOME';
    const decoration = prepareAgentSpawnDecoration(
      adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true), { [envKey]: providerHome },
    )!;
    const state = path.join(home, '.nexus-test-user-data', 'provider-state', id, 'checkout-wiring');
    expect(decoration.providerStateReadPaths).toEqual([path.join(process.cwd(), 'resources/heavy-command'), state]);
    expect(decoration.providerStateWritePaths).toEqual([state]);
  });

  it.each(['claude', 'glm'] as const)('isolates direct %s conversation paths using the bound checkout', (id) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const decoration = prepareAgentSpawnDecoration(adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false))!;
    try {
      const durable = path.join(home, '.nexus-test-user-data', 'provider-state', id, 'checkout-wiring', 'claude', 'projects');
      expect(decoration.env.HOME).toBeTruthy();
      expect(decoration.env.HOME).not.toBe(home);
      expect(fs.realpathSync(path.join(decoration.env.HOME, '.claude', 'projects'))).toBe(fs.realpathSync(durable));
      expect(decoration.extraArgs).not.toContain('--continue');
      // F-576: CLAUDE_CONFIG_DIR must be REMOVED from the child env, never
      // blanked — "CLAUDE_CONFIG_DIR=" resolves the binary's config dir to
      // "" and the file-backed credential store goes cwd-relative.
      expect(decoration.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(decoration.env.NEXUS_HEAVY_COMMAND_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/heavy-command$/);
      expect(decoration.env.NODE_OPTIONS).toContain('resources/heavy-command/preload.cjs');
      if (id === 'glm' && process.platform === 'darwin') {
        // F-629: terceiro no macOS ganha securestorage escopado no overlay.
        expect(decoration.envRemove).toEqual(['NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_HELPER', 'CLAUDE_CONFIG_DIR']);
      } else if (id === 'claude' && process.platform !== 'darwin') {
        // F-646: o login nativo é gravado no ~/.claude real, sem cópia no overlay.
        expect(decoration.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(path.join(os.homedir(), '.claude'));
        expect(fs.existsSync(path.join(decoration.env.HOME, '.claude', '.credentials.json'))).toBe(false);
        expect(decoration.envRemove).toEqual(['NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_HELPER', 'CLAUDE_CONFIG_DIR']);
      } else {
        expect(decoration.envRemove).toEqual(['NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_HELPER', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR']);
      }
    } finally { decoration.onSpawnFailed?.(); }
  });

  it.skipIf(process.platform !== 'darwin').each([
    ['glm', false],
    ['claude', true],
  ] as const)(
    'F-629: %s (gated=%s) never reaches the native Claude keychain item — scoped securestorage inside the overlay',
    (id, governed) => {
      const home = path.join(tempRoot(), 'home');
      const cwd = path.join(home, 'workspace');
      fs.mkdirSync(cwd, { recursive: true });
      vi.stubEnv('HOME', home);
      if (governed) {
        // Lane hardened: hooks do gate + token por env (sem keychain nativo).
        homePolicyDeps.getOrchSettings.mockReturnValue({ squadCliPolicy: 'governed' });
      }
      const decoration = prepareAgentSpawnDecoration(
        adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, governed),
      )!;
      try {
        const scoped = decoration.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        expect(scoped).toBe(path.join(decoration.env.HOME, '.nexus-claude-securestorage'));
        expect(fs.statSync(scoped!).isDirectory()).toBe(true);
        expect(decoration.envRemove ?? []).not.toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR');
      } finally { decoration.onSpawnFailed?.(); }
    },
  );

  it.skipIf(process.platform !== 'darwin')('F-629: the direct native Claude lane keeps the native keychain item (no scoping)', () => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const decoration = prepareAgentSpawnDecoration(adapter('claude'), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false))!;
    try {
      expect(decoration.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
      expect(decoration.envRemove).toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR');
    } finally { decoration.onSpawnFailed?.(); }
  });

  it.each(['claude', 'glm'] as const)('projects the operator identity and native HOME into the direct %s overlay (F-579)', (id) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    write(path.join(home, '.gitconfig'), '[user]\n\temail = op@example.test\n');
    write(path.join(home, '.ssh', 'id_test'), 'key');
    write(path.join(home, '.zshrc'), 'zshrc');
    write(path.join(home, '.claude.json'), '{"sentinel":"real-profile"}');
    vi.stubEnv('HOME', home);
    const decoration = prepareAgentSpawnDecoration(adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false))!;
    try {
      const overlay = decoration.env.HOME;
      // Lane direta/operator-choice: o pane É o HOME do operador menos o
      // estado de conversa Claude — identidade e dotfiles resolvem no real.
      expect(fs.realpathSync(path.join(overlay, '.gitconfig'))).toBe(fs.realpathSync(path.join(home, '.gitconfig')));
      expect(fs.realpathSync(path.join(overlay, '.ssh'))).toBe(fs.realpathSync(path.join(home, '.ssh')));
      if (process.platform !== 'win32') {
        expect(fs.realpathSync(path.join(overlay, '.zshrc'))).toBe(fs.realpathSync(path.join(home, '.zshrc')));
      }
      // `.claude.json` do overlay é o stub Nexus, nunca o arquivo real.
      const stub = JSON.parse(fs.readFileSync(path.join(overlay, '.claude.json'), 'utf8'));
      expect(stub.sentinel).toBeUndefined();
      expect(stub.hasCompletedOnboarding).toBe(true);
    } finally { decoration.onSpawnFailed?.(); }
  });

  it.each(['claude', 'glm'] as const)('gives the gated %s worker only the developer identity entries (F-579)', (id) => {
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'governed',
    });
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    write(path.join(home, '.gitconfig'), '[user]\n\temail = op@example.test\n');
    write(path.join(home, '.ssh', 'id_test'), 'key');
    write(path.join(home, '.zshrc'), 'zshrc');
    vi.stubEnv('HOME', home);
    const decoration = prepareAgentSpawnDecoration(adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, true))!;
    try {
      const overlay = decoration.env.HOME;
      // Lane hardened: superfície mínima + identidade exata — sem o HOME
      // inteiro do operador.
      expect(fs.realpathSync(path.join(overlay, '.gitconfig'))).toBe(fs.realpathSync(path.join(home, '.gitconfig')));
      expect(fs.realpathSync(path.join(overlay, '.ssh'))).toBe(fs.realpathSync(path.join(home, '.ssh')));
      expect(fs.existsSync(path.join(overlay, '.zshrc'))).toBe(false);
    } finally { decoration.onSpawnFailed?.(); }
  });

  it.each(['claude', 'glm'] as const)('gives the read-only %s lane no identity entries at all (F-579)', (id) => {
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'governed',
    });
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    write(path.join(home, '.gitconfig'), '[user]\n\temail = op@example.test\n');
    write(path.join(home, '.ssh', 'id_test'), 'key');
    write(path.join(home, '.zshrc'), 'zshrc');
    vi.stubEnv('HOME', home);
    const base = authority(cwd, true);
    const readOnlyAuthority: BoundSpawnAuthority = {
      ...base,
      context: {
        ...base.context!,
        readOnly: true,
        nativeReadOnly: true,
      },
    };
    const decoration = prepareAgentSpawnDecoration(adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 }, readOnlyAuthority)!;
    try {
      const overlay = decoration.env.HOME;
      // Lane read-only nunca commita e pode estar confinada — nada do HOME
      // do operador entra no overlay.
      expect(fs.existsSync(path.join(overlay, '.gitconfig'))).toBe(false);
      expect(fs.existsSync(path.join(overlay, '.ssh'))).toBe(false);
      expect(fs.existsSync(path.join(overlay, '.zshrc'))).toBe(false);
    } finally { decoration.onSpawnFailed?.(); }
  });

  it.each(['claude', 'glm'] as const)('points %s package caches at a durable per-adapter root outside the disposable HOME', (id) => {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const decoration = prepareAgentSpawnDecoration(adapter(id), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false))!;
    try {
      const cacheRoot = path.join(home, '.nexus-test-user-data', 'provider-cache', id);
      // O cache durável reusa downloads de MCPs npx/uvx entre panes — e nunca
      // compartilha raiz entre adapters (third-party não envenena o nativo).
      expect(decoration.env.npm_config_cache).toBe(path.join(cacheRoot, 'npm'));
      expect(decoration.env.XDG_CACHE_HOME).toBe(path.join(cacheRoot, 'xdg'));
      expect(decoration.env.UV_CACHE_DIR).toBe(path.join(cacheRoot, 'uv'));
      expect(decoration.env.npm_config_cache.startsWith(decoration.env.HOME)).toBe(false);
    } finally { decoration.onSpawnFailed?.(); }
  });

  it('keeps packaged Arms on the legacy descriptor and isolates dev', () => {
    const home = path.join(tempRoot(), 'home');

    expect(resolveArmsRuntimeInstance(true)).toBe('prod');
    expect(resolveArmsRuntimeDescriptorPath(home, 'prod')).toBe(
      path.join(home, '.nexus', 'arms-runtime.json'),
    );

    expect(resolveArmsRuntimeInstance(false)).toBe('dev');
    expect(resolveArmsRuntimeDescriptorPath(home, 'dev')).toBe(
      path.join(home, '.nexus', 'arms-runtime.dev.json'),
    );

    const descriptorPath = path.join(home, '.nexus', 'arms-runtime.dev.json');
    expect(buildArmsRuntimeDescriptor(39791, 'dev', descriptorPath, 1234)).toEqual({
      schemaVersion: 1,
      port: 39791,
      at: 1234,
      instance: 'dev',
      descriptorPath,
    });
  });

  it('injects private nx commands for a mission worker independently of MCP support', async () => {
    const root = tempRoot();
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const originalPath = '/usr/local/bin:/usr/bin:/bin';

    const assertWorkerShim = (decoration: AgentSpawnDecoration) => {
      const shimRoot = decoration.env.NEXUS_SHIM_ROOT;
      const shimBin = path.join(shimRoot, 'bin');
      expect(decoration.env.NEXUS_SHIM_SECRET).toMatch(/^[a-f0-9]{64}$/);
      expect(decoration.env.NEXUS_SHIM_CAPABILITY_ID).toMatch(/^[0-9a-f-]{36}$/);
      expect(decoration.env.PATH?.split(path.delimiter)).toEqual([
        shimBin,
        ...originalPath.split(path.delimiter),
      ]);
      expect(decoration.missionShimReadPaths).toEqual([
        shimBin,
        path.join(shimRoot, 'responses'),
        path.join(shimRoot, 'requests'),
        path.join(shimRoot, 'state'),
      ]);
      expect(decoration.missionShimWritePaths).toEqual([
        path.join(shimRoot, 'requests'),
        path.join(shimRoot, 'state'),
      ]);
      expect(fs.existsSync(path.join(shimBin, 'nx-mail'))).toBe(true);
      return shimRoot;
    };

    // F-697: AGY é capaz de MCP — a sessão chega por ENV e a ponte stdio é
    // registrada pelo CLI no perfil nativo (mockada acima; nunca o binário real).
    const decoration = prepareAgentSpawnDecoration(
      adapter('agy'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true),
      { PATH: originalPath },
    );
    if (!decoration) throw new Error('expected AGY worker decoration');

    const shimRoot = assertWorkerShim(decoration);
    expect(decoration.env.NEXUS_MCP_URL).toBe('http://127.0.0.1:0/mcp');
    expect(cliRegistration.agy).toHaveBeenCalledTimes(1);

    decoration.onSpawnFailed?.();
    await vi.waitFor(() => expect(fs.existsSync(shimRoot)).toBe(false));

    // Metade sem MCP: o shim privado não depende do transporte nexus_*.
    const aider = prepareAgentSpawnDecoration(
      adapter('aider'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true),
      { PATH: originalPath },
    );
    if (!aider) throw new Error('expected Aider worker decoration');

    const aiderShimRoot = assertWorkerShim(aider);
    expect(aider.env.NEXUS_MCP_URL).toBeUndefined();
    expect(cliRegistration.agy).toHaveBeenCalledTimes(1);
    expect(cliRegistration.devin).not.toHaveBeenCalled();

    aider.onSpawnFailed?.();
    await vi.waitFor(() => expect(fs.existsSync(aiderShimRoot)).toBe(false));
  });

  it('F-795: worker de missão ganha o spool de handoff no env e no grant do shim; spawn falho apaga', () => {
    const root = tempRoot();
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const spoolRoot = path.join(root, 'userData', 'handoff-spool', 'v1');
    startHandoffSpool({
      root: spoolRoot,
      deps: { getStores: () => { throw new Error('não usado'); }, deliver: () => undefined },
      bootDelayMs: 600_000,
      watch: false,
    });
    try {
      const decoration = prepareAgentSpawnDecoration(
        adapter('agy'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        authority(cwd, true),
        { PATH: '/usr/bin:/bin' },
      );
      if (!decoration) throw new Error('expected AGY worker decoration');
      const spoolDir = decoration.env.NEXUS_HANDOFF_SPOOL_DIR;
      expect(spoolDir).toBe(fs.realpathSync(path.join(spoolRoot, 'sessions', decoration.env.NEXUS_HANDOFF_SPOOL_ID)));
      expect(decoration.env.NEXUS_HANDOFF_SPOOL_KEY).toMatch(/^[a-f0-9]{64}$/);
      expect(decoration.env.NEXUS_GATE_OFFLINE_POLICY).toBeUndefined();
      expect(decoration.missionShimWritePaths).toContain(spoolDir);
      expect(decoration.missionShimReadPaths).toContain(spoolDir);
      // O vínculo (chave, missão) fica fora do que o agente pode escrever.
      const binding = path.join(spoolRoot, 'bindings', `${decoration.env.NEXUS_HANDOFF_SPOOL_ID}.json`);
      expect(fs.statSync(binding).mode & 0o777).toBe(0o600);
      expect(decoration.missionShimWritePaths?.some((grant) => binding.startsWith(grant))).toBe(false);
      decoration.onSpawnFailed?.();
      expect(fs.existsSync(spoolDir)).toBe(false);
      expect(fs.existsSync(binding)).toBe(false);
    } finally {
      resetHandoffSpoolForTests();
    }
  });

  it('projects Claude trust only from an exact sealed mission authority', () => {
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'governed',
    });
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    fs.mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    const realProfile = JSON.stringify({
      projects: { [cwd]: { hasTrustDialogAccepted: false } },
    });
    write(path.join(home, '.claude.json'), realProfile);

    const exactAuthority = sealedMissionAuthority(cwd);
    expect(hasApprovedMissionProjectTrust(exactAuthority)).toBe(true);
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      exactAuthority,
      undefined,
    );
    if (!decoration) throw new Error('expected Claude mission decoration');
    const overlay = JSON.parse(
      fs.readFileSync(path.join(decoration.env.HOME, '.claude.json'), 'utf8'),
    ) as { projects?: Record<string, Record<string, unknown>> };
    expect(overlay.projects).toEqual({
      [cwd]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(
      realProfile,
    );

    expect(
      hasApprovedMissionProjectTrust(
        sealedMissionAuthority(cwd, { source: 'direct-user' }),
      ),
    ).toBe(false);
    expect(
      hasApprovedMissionProjectTrust(
        sealedMissionAuthority(cwd, { source: 'legacy-squad' }),
      ),
    ).toBe(false);
    expect(
      hasApprovedMissionProjectTrust(
        sealedMissionAuthority(cwd, { contextRevision: 'e'.repeat(64) }),
      ),
    ).toBe(false);

    decoration.onSpawnFailed?.();
  });

  it('preserves native Claude auth and session authority in a private operator-choice HOME', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    const nativeProfile = JSON.stringify({
      oauthAccount: { emailAddress: 'operator@example.com' },
    });
    write(path.join(home, '.claude.json'), nativeProfile);

    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      sealedMissionAuthority(cwd),
      undefined,
    );
    if (!decoration) throw new Error('expected native Claude decoration');

    expect(decoration.env.HOME).toBeTruthy();
    expect(decoration.extraArgs).toContain('--mcp-config');
    expect(decoration.extraArgs).toContain('--settings');
    expect(decoration.extraArgs).toContain('--strict-mcp-config');
    expect(
      getContext(decoration.env.NEXUS_MCP_TOKEN),
    ).toMatchObject({
      missionId: 'mission-wiring',
      role: 'orchestrator',
      providerId: 'claude',
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(decoration.env.HOME, '.claude.json'), 'utf8')),
    ).toMatchObject({
      oauthAccount: { emailAddress: 'operator@example.com' },
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    });

    decoration.onSpawnFailed?.();
  });

  it('F-1157: the operator hand with a skill grant never gets Nexus writes in the REAL ~/.claude/skills', () => {
    homePolicyDeps.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    write(path.join(home, '.claude', 'skills', 'granted-one', 'SKILL.md'), '---\nname: granted-one\n---\n');
    write(path.join(home, '.codex', 'skills', 'codex-only', 'SKILL.md'), '---\nname: codex-only\n---\n');
    write(path.join(home, '.agents', 'skills', 'agents-only', 'SKILL.md'), '---\nname: agents-only\n---\n');
    const base = authority(cwd, false);
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      {
        ...base,
        source: 'pending',
        context: { allowedTools: null, allowedSkills: ['granted-one'], scope: base.scope, executionScope: base.scope, agentName: 'Designer' },
      },
      undefined,
    );
    if (!decoration) throw new Error('expected operator-hand Claude decoration');
    try {
      const overlaySkills = path.join(decoration.env.HOME, '.claude', 'skills');
      // The operator's own profile is linked in, untouched by the mirror.
      expect(fs.lstatSync(overlaySkills).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(overlaySkills)).toBe(fs.realpathSync(path.join(home, '.claude', 'skills')));
      expect(fs.readdirSync(path.join(home, '.claude', 'skills')).sort()).toEqual(['granted-one']);
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it('delivers every installed skill to the private Claude profile in operator-choice (F-1157)', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    write(
      path.join(home, '.agents', 'skills', 'allowed', 'SKILL.md'),
      '# allowed',
    );
    write(
      path.join(home, '.agents', 'skills', 'blocked', 'SKILL.md'),
      '# blocked',
    );

    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true),
      undefined,
    );
    if (!decoration) throw new Error('expected native Claude decoration');

    // The skill must reach the private HOME used by this worker.
    expect(decoration.env.HOME).toBeTruthy();
    expect(
      fs.existsSync(path.join(decoration.env.HOME, '.claude', 'skills', 'allowed', 'SKILL.md')),
    ).toBe(true);
    // F-1157: sem filtro de skill no HOME privado.
    expect(fs.existsSync(path.join(decoration.env.HOME, '.claude', 'skills', 'blocked', 'SKILL.md'))).toBe(
      true,
    );

    decoration.onSpawnFailed?.();
  });

  it('keeps a granted Claude skill out of the real profile once an overlay exists', () => {
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'governed',
    });
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    write(
      path.join(home, '.agents', 'skills', 'allowed', 'SKILL.md'),
      '# allowed',
    );

    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true),
      undefined,
    );
    if (!decoration) throw new Error('expected native Claude decoration');

    expect(decoration.env.HOME).toBeTruthy();
    expect(
      fs.existsSync(
        path.join(decoration.env.HOME, '.claude', 'skills', 'allowed'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'allowed'))).toBe(
      false,
    );

    decoration.onSpawnFailed?.();
  });

  it('keeps native external MCPs available to direct user panes', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);

    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
      undefined,
    );
    if (!decoration) throw new Error('expected direct Claude decoration');

    expect(decoration.extraArgs).toContain('--mcp-config');
    expect(decoration.extraArgs).toContain('--settings');
    expect(decoration.extraArgs).not.toContain('--strict-mcp-config');
    // PostToolUseFailure/Bash triage hook: mesma família de env do status hook.
    expect(decoration.env.NEXUS_HOOK_TRIAGE_URL).toMatch(/\/hook\/triage$/);

    decoration.onSpawnFailed?.();
  });

  it('keeps the operator global MCP profile out of operator-spawned helpers', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);

    const base = authority(cwd, false);
    // Filho ad-hoc do operador (Autopilot): nasce `user` com allowlist herdada
    // (null → não-gated), mas o vínculo operatorParentSessionId proíbe o perfil
    // MCP global do operador — F-572, ~19 servidores / ~600 MB por pane.
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      {
        ...base,
        source: 'pending',
        context: {
          operatorParentSessionId: 'parent-1',
          initialPrompt: 'implemente X',
          allowedTools: null,
          allowedSkills: null,
          scope: base.scope,
          executionScope: base.scope,
        },
      },
      undefined,
    );
    if (!decoration) throw new Error('expected operator-child Claude decoration');

    expect(decoration.extraArgs).toContain('--strict-mcp-config');
    expect(decoration.env.NEXUS_HOOK_TRIAGE_URL).toMatch(/\/hook\/triage$/);
    // O vínculo com o pai vai no token: o handoff sem missão o usa quando a
    // janela mostra outro workspace.
    expect(getContext(decoration.env.NEXUS_MCP_TOKEN!)?.operatorParentSessionId).toBe('parent-1');

    decoration.onSpawnFailed?.();
  });

  it('gives the git guard to an operator helper the Nexus spawned as an isolated writer, and only to it', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(root, 'writer-wt'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(path.join(root, 'workspace'));
    const worktree = fs.realpathSync(path.join(root, 'writer-wt'));
    vi.stubEnv('HOME', home);
    const base = authority(cwd, false);
    const execution = { ...base.scope, rootRealPath: worktree };
    const helper = (isolatedWriter?: true) => {
      const decoration = prepareAgentSpawnDecoration(
        adapter('claude'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        {
          ...base,
          source: 'pending',
          cwd: worktree,
          scope: execution,
          coordinationScope: base.scope,
          context: {
            operatorParentSessionId: 'parent-1',
            allowedTools: null,
            allowedSkills: null,
            scope: base.scope,
            executionScope: execution,
            ...(isolatedWriter ? { isolatedWriter } : {}),
          },
        },
        undefined,
      );
      if (!decoration) throw new Error('expected operator-child decoration');
      const ctx = getContext(decoration.env.NEXUS_MCP_TOKEN!)!;
      decoration.onSpawnFailed?.();
      return ctx;
    };
    const isolated = helper(true);
    expect(isolated.role).toBe('user');
    expect(isIsolatedWriterContext(isolated)).toBe(true);
    expect(() => assertIsolatedWriterGitTool(isolated, 'nexus_git_push')).toThrow(/isolated_worktree/);
    // Pane do operador numa worktree própria, sem a marca do Nexus: livre.
    expect(isIsolatedWriterContext(helper())).toBe(false);
  });

  it('keeps the workspace MCP hub out of operator-spawned helpers unless their allowlist names a server', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    writeHub(cwd, { schemaVersion: 1, servers: [HUB_HTTP_SERVER, HUB_STDIO_SERVER] });

    const base = authority(cwd, false);
    const helper = (allowedTools: string[] | null) =>
      prepareAgentSpawnDecoration(
        adapter('claude'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        {
          ...base,
          source: 'pending',
          context: {
            operatorParentSessionId: 'parent-1',
            initialPrompt: 'revise X',
            allowedTools,
            allowedSkills: null,
            scope: base.scope,
            executionScope: base.scope,
          },
        },
        undefined,
      );

    // Helper aberto por um agente: só o MCP do Nexus (decisão do operador,
    // 25/09 — o hub do workspace virou o perfil global inteiro, 700–980 MB).
    const lean = helper(null);
    if (!lean) throw new Error('expected operator-child Claude decoration');
    expect(Object.keys(generatedClaudeMcpServers(lean))).toEqual(['nexus']);
    lean.onSpawnFailed?.();

    // O allowlist pede um servidor do hub nomeando uma tool dele.
    const asked = helper(['mcp__context7__resolve-library-id']);
    if (!asked) throw new Error('expected operator-child Claude decoration');
    expect(Object.keys(generatedClaudeMcpServers(asked)).sort()).toEqual(['context7', 'nexus']);
    asked.onSpawnFailed?.();

    // O pane direto do operador segue com o hub inteiro.
    const direct = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      base,
      undefined,
    );
    if (!direct) throw new Error('expected direct Claude decoration');
    expect(Object.keys(generatedClaudeMcpServers(direct)).sort()).toEqual([
      'context7',
      'linear',
      'nexus',
    ]);
    direct.onSpawnFailed?.();
  });

  it('projects the same exact trust into a sealed GLM worker overlay', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    fs.mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);

    const decoration = prepareAgentSpawnDecoration(
      adapter('glm'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      sealedMissionAuthority(cwd, { role: 'worker' }),
      undefined,
    );
    if (!decoration) throw new Error('expected GLM mission decoration');
    const overlay = JSON.parse(
      fs.readFileSync(path.join(decoration.env.HOME, '.claude.json'), 'utf8'),
    ) as {
      oauthAccount?: unknown;
      projects?: Record<string, Record<string, unknown>>;
    };
    expect(overlay.oauthAccount).toBeUndefined();
    expect(overlay.projects).toEqual({
      [cwd]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });

    decoration.onSpawnFailed?.();
  });

  it('isolates a dynamically routed Claude-family endpoint in operator-choice', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    write(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'operator@example.com' },
      }),
    );

    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      sealedMissionAuthority(cwd, { role: 'worker' }),
      {
        ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      },
    );
    if (!decoration) throw new Error('expected routed Claude decoration');

    expect(decoration.env.HOME).toBeTruthy();
    expect(decoration.env.HOME).not.toBe(home);
    const overlay = JSON.parse(
      fs.readFileSync(path.join(decoration.env.HOME, '.claude.json'), 'utf8'),
    ) as { oauthAccount?: unknown };
    expect(overlay.oauthAccount).toBeUndefined();
    expect(decoration.extraArgs).toContain('--strict-mcp-config');

    decoration.onSpawnFailed?.();
  });

  it('mints Pet media authority only from the exact immediate or sealed resume profile', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);

    const exactImmediate = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      petAuthority(cwd),
      undefined,
    );
    if (!exactImmediate) throw new Error('expected immediate Pet decoration');
    expect(
      getContext(exactImmediate.env.NEXUS_MCP_TOKEN),
    ).toMatchObject({
      role: 'orchestrator',
      missionId: undefined,
      petStudioMediaAuthority: true,
    });
    expect(exactImmediate.attachmentReadPaths).toBeUndefined();

    const exactResume = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      petAuthority(cwd, { source: 'persisted-pane' }),
      undefined,
    );
    if (!exactResume) throw new Error('expected resumed Pet decoration');
    expect(
      getContext(exactResume.env.NEXUS_MCP_TOKEN)?.petStudioMediaAuthority,
    ).toBe(true);
    expect(exactResume.attachmentReadPaths).toBeUndefined();

    const deniedAuthorities = [
      petAuthority(cwd, { squadId: 'lookalike-pet-studio' }),
      petAuthority(cwd, {
        allowedTools: [
          ...(PET_STUDIO_SQUAD.agents[0]!.allowedTools ?? []),
          'nexus_video_generate',
        ],
      }),
      petAuthority(cwd, { source: 'direct-user' }),
      petAuthority(cwd, {
        source: 'persisted-pane',
        stalePersistedSeal: true,
      }),
    ];
    const deniedDecorations = deniedAuthorities.map((candidate) => {
      const decoration = prepareAgentSpawnDecoration(
        adapter('codex'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        candidate,
        undefined,
      );
      if (!decoration) throw new Error('expected denied-profile decoration');
      return decoration;
    });
    for (const decoration of deniedDecorations) {
      expect(
        getContext(decoration.env.NEXUS_MCP_TOKEN)
          ?.petStudioMediaAuthority,
      ).toBeUndefined();
    }

    exactImmediate.onSpawnFailed?.();
    exactResume.onSpawnFailed?.();
    for (const decoration of deniedDecorations) {
      decoration.onSpawnFailed?.();
    }
  });

  it('leaves an operator-choice Codex worker outside the Hardened boundary', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);

    const decoration = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true, true),
      undefined,
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Codex spawn decoration');

    expect(getContext(decoration.env.NEXUS_MCP_TOKEN)).toMatchObject({
      role: 'worker',
      missionId: 'mission-wiring',
      providerId: 'codex',
    });
    expect(
      getContext(decoration.env.NEXUS_MCP_TOKEN)?.governedNativeProvider,
    ).toBeUndefined();
    decoration.onSpawnFailed?.();
  });

  it('marks an unrestricted mission Codex worker as governed in Hardened mode', () => {
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'governed',
    });
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);

    const decoration = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true, true),
      undefined,
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Codex spawn decoration');

    expect(getContext(decoration.env.NEXUS_MCP_TOKEN)).toMatchObject({
      role: 'worker',
      missionId: 'mission-wiring',
      allowedTools: null,
      allowedSkills: null,
      governedNativeProvider: 'codex',
    });
    expect(
      getContext(decoration.env.NEXUS_MCP_TOKEN)?.contextRevision,
    ).toBeUndefined();
    decoration.onSpawnFailed?.();
  });

  it('pre-approves only main-owned mission/Pet Codex bearer servers', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);

    const sealed = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      sealedMissionAuthority(cwd, { role: 'worker' }),
      undefined,
    );
    const unsealed = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true),
      undefined,
    );
    const direct = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
      undefined,
    );
    const pet = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      petAuthority(cwd),
      undefined,
    );
    if (!sealed || !unsealed || !direct || !pet) {
      throw new Error('expected Codex spawn decorations');
    }

    for (const governed of [sealed, unsealed, pet]) {
      const args = governed.extraArgs.join(' ');
      expect(args).toContain('default_tools_approval_mode="approve"');
      expect(
        args.match(/default_tools_approval_mode="approve"/g),
      ).toHaveLength(1);
    }
    expect(direct.extraArgs.join(' ')).not.toContain(
      'default_tools_approval_mode',
    );

    sealed.onSpawnFailed?.();
    unsealed.onSpawnFailed?.();
    direct.onSpawnFailed?.();
    pet.onSpawnFailed?.();
  });

  it('derives confinement from the minted gate token without seeding real profiles', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);

    // One trusted source skill. No provider target contains it before spawn.
    write(
      path.join(home, '.agents', 'skills', 'allowed', 'SKILL.md'),
      '# allowed',
    );
    write(
      path.join(home, '.agents', 'skills', 'blocked', 'SKILL.md'),
      '# blocked',
    );
    write(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-codex-mcp"\n',
    );
    write(
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        plugins: ['external-agy-plugin'],
        mcpServers: { external: { command: 'external-agy-mcp' } },
      }),
    );
    write(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        plugin: ['external-opencode-plugin'],
        mcp: { external: { command: ['external-opencode-mcp'] } },
      }),
    );
    write(
      path.join(home, '.kimi-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: { external: { command: 'external-kimi-mcp' } },
      }),
    );
    write(
      path.join(home, '.grok', 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-grok-mcp"\n' +
        '\n[plugins]\nenabled = ["external-grok-plugin"]\n',
    );
    write(
      path.join(cwd, '.grok', 'skills', 'project-only', 'SKILL.md'),
      '# project only',
    );
    write(
      path.join(cwd, '.grok', 'plugins', 'project-plugin', 'plugin.json'),
      '{}',
    );

    const decorations = new Map<string, AgentSpawnDecoration>();
    for (const id of [
      'codex',
      'agy',
      'opencode',
      'kimi',
      'grok',
    ] as const) {
      const preparedEnv: Readonly<Record<string, string>> | undefined =
        id === 'agy'
          ? { GEMINI_CLI_HOME: path.join(home, '.gemini') }
          : id === 'kimi'
            ? { KIMI_CODE_HOME: path.join(home, '.kimi-code') }
            : id === 'grok'
              ? { GROK_HOME: path.join(home, '.grok') }
              : undefined;
      const decoration = prepareAgentSpawnDecoration(
        adapter(id),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        authority(cwd, true),
        preparedEnv,
      );
      expect(decoration).not.toBeNull();
      decorations.set(id, decoration!);
    }

    const codex = decorations.get('codex')!;
    expect(codex.extraArgs.join(' ')).toContain('mcp_servers.nexus_');
    expect(
      getContext(codex.env.NEXUS_MCP_TOKEN)?.governedNativeProvider,
    ).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'allowed'))).toBe(
      false,
    );

    const agy = decorations.get('agy')!;
    expect(
      getContext(agy.authorityToken)?.governedNativeProvider,
    ).toBeUndefined();
    // F-697: AGY é MCP-capable — transporte por ENV (URL + bearer) e ponte
    // registrada no perfil nativo via `agy mcp add` (mockado neste arquivo).
    expect(agy.env.NEXUS_MCP_URL).toBeDefined();
    expect(agy.env.NEXUS_MCP_TOKEN).toBeDefined();
    expect(agy.env.NEXUS_GATE_URL).toBeDefined();
    expect(agy.env.NEXUS_GATE_TOKEN).toBeDefined();
    expect(agy.env.NEXUS_HOOK_URL).toBeDefined();
    expect(agy.env.HOME).toBeUndefined();
    expect(agy.env.GEMINI_CLI_HOME).toBeUndefined();
    expect(agy.extraArgs.join(' ')).not.toContain('mcp_config');
    expect(cliRegistration.agy).toHaveBeenCalledTimes(1);

    const opencode = decorations.get('opencode')!;
    expect(opencode.extraArgs).toContain('--pure');
    expect(opencode.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(opencode.env.OPENCODE_CONFIG_CONTENT).not.toContain('external-');

    const kimi = decorations.get('kimi')!;
    expect(kimi.extraArgs).toContain('--skills-dir');
    expect(
      fs.readFileSync(path.join(kimi.env.KIMI_CODE_HOME, 'mcp.json'), 'utf8'),
    ).not.toContain('external-kimi-mcp');

    const grok = decorations.get('grok')!;
    expect(grok.extraArgs).toContain('--no-subagents');
    expect(grok.env.GROK_FOLDER_TRUST).toBeUndefined();
    expect(grok.env.GROK_CLAUDE_HOOKS_ENABLED).toBe('false');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).not.toContain('external-grok');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).toContain('project-plugin');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).toContain(path.join(cwd, '.grok', 'skills'));

    // The real provider profiles remain untouched; allowlisted skills exist
    // only in each private runtime.
    for (const providerSkillRoot of [
      path.join(home, '.codex', 'skills'),
      path.join(home, '.gemini', 'config', 'skills'),
      path.join(home, '.config', 'opencode', 'skills'),
      path.join(home, '.kimi-code', 'skills'),
      path.join(home, '.grok', 'skills'),
    ]) {
      expect(fs.existsSync(path.join(providerSkillRoot, 'allowed'))).toBe(
        false,
      );
    }

    for (const decoration of decorations.values()) {
      decoration?.onSpawnFailed?.();
    }
  });

  it('uses PTY stream for AGY without projecting or leasing its real MCP profile', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    const nativeConfig = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'mcp_config.json',
    );
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    write(
      nativeConfig,
      JSON.stringify({
        mcpServers: { existing: { command: 'existing-server' } },
      }),
    );
    const originalBytes = fs.readFileSync(nativeConfig);
    const base = authority(cwd, true);
    const readOnlyAuthority: BoundSpawnAuthority = {
      ...base,
      context: {
        ...base.context!,
        readOnly: true,
        nativeReadOnly: true,
      },
    };

    const decoration = prepareAgentSpawnDecoration(
      adapter('agy'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      readOnlyAuthority,
      { GEMINI_CLI_HOME: path.join(home, '.gemini') },
    );
    if (!decoration) throw new Error('expected AGY reviewer decoration');

    expect(decoration.env.HOME).toBeUndefined();
    expect(decoration.env.GEMINI_CLI_HOME).toBeUndefined();
    expect(decoration.processHome).toBeUndefined();
    expect(decoration.sandboxDir).toBeUndefined();
    expect(decoration.providerStateReadPaths).toEqual([path.join(process.cwd(), 'resources/heavy-command')]);
    expect(decoration.providerStateWritePaths).toEqual([]);
    expect(fs.readFileSync(nativeConfig).equals(originalBytes)).toBe(true);
    expect(decoration.extraArgs.join(' ')).not.toContain('mcp_config');

    decoration.onSpawnFailed?.();
    expect(fs.readFileSync(nativeConfig).equals(originalBytes)).toBe(true);
  });

  it('carries the workspace MCP hub into the generated per-session config', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);
    writeHub(cwd, {
      schemaVersion: 1,
      servers: [HUB_HTTP_SERVER, HUB_STDIO_SERVER],
    });

    // F-247: worker de missão só recebe MCPs do hub pedidos no allowlist.
    const missionAuthority = authority(cwd, true);
    missionAuthority.context!.allowedTools = [
      'mcp__context7__*',
      'mcp__linear__*',
    ];
    const claude = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      missionAuthority,
      undefined,
    );
    if (!claude) throw new Error('expected Claude mission decoration');
    const servers = generatedClaudeMcpServers(claude);
    expect(Object.keys(servers).sort()).toEqual([
      'context7',
      'linear',
      'nexus',
    ]);
    expect(servers.context7).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    });
    expect(servers.linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    });
    expect(servers.nexus).toMatchObject({ type: 'http' });
    // O isolamento continua: o hub é conteúdo do config, não uma abertura.
    expect(claude.extraArgs).toContain('--strict-mcp-config');

    // O overlay governado (HOME efêmero) usa outro caminho de escrita e
    // precisa carregar o mesmo conteúdo.
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'governed',
    });
    const governedAuthority = authority(cwd, true);
    governedAuthority.context!.allowedTools = [
      'mcp__context7__*',
      'mcp__linear__*',
    ];
    const governedClaude = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      governedAuthority,
      undefined,
    );
    if (!governedClaude) throw new Error('expected governed Claude decoration');
    expect(governedClaude.env.HOME).toBeTruthy();
    expect(Object.keys(generatedClaudeMcpServers(governedClaude)).sort()).toEqual(
      ['context7', 'linear', 'nexus'],
    );
    expect(governedClaude.extraArgs).toContain('--strict-mcp-config');
    homePolicyDeps.getOrchSettings.mockReturnValue({
      squadCliPolicy: 'operator-choice',
    });

    const codexAuthority = authority(cwd, true);
    codexAuthority.context!.allowedTools = [
      'mcp__context7__*',
      'mcp__linear__*',
    ];
    const codex = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      codexAuthority,
      undefined,
    );
    if (!codex) throw new Error('expected Codex mission decoration');
    const codexArgs = codex.extraArgs.join(' ');
    expect(codexArgs).toContain('mcp_servers.context7.command="npx"');
    expect(codexArgs).toContain(
      'mcp_servers.context7.args=["-y","@upstash/context7-mcp"]',
    );
    expect(codexArgs).toContain(
      'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
    );
    expect(codexArgs).toMatch(/mcp_servers\.nexus_[0-9a-f]{12}\.url=/);

    // Campo 2026-09-19: pane direto do operador com supabase stdio no
    // ~/.codex e o mesmo id no hub como HTTP. O `-c url` por cima do
    // command derrubava o Codex no boot. Worker (overlay sem ambient MCP)
    // continua recebendo o url do hub.
    write(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.supabase]\ncommand = "/opt/supabase-mcp"\n',
    );
    writeHub(cwd, {
      schemaVersion: 1,
      servers: [
        {
          id: 'supabase',
          name: 'supabase',
          transport: 'streamable-http',
          url: 'https://mcp.supabase.com/mcp',
        },
        HUB_STDIO_SERVER,
      ],
    });
    const operatorCodex = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
      { CODEX_HOME: path.join(home, '.codex') },
    );
    if (!operatorCodex) throw new Error('expected operator Codex decoration');
    const operatorArgs = operatorCodex.extraArgs.join(' ');
    expect(operatorArgs).not.toContain('mcp_servers.supabase.url');
    expect(operatorArgs).toContain('mcp_servers.context7.command="npx"');
    expect(operatorArgs).toMatch(/mcp_servers\.nexus_[0-9a-f]{12}\.url=/);

    const workerCodexAuthority = authority(cwd, true);
    workerCodexAuthority.context!.allowedTools = [
      'mcp__supabase__*',
      'mcp__context7__*',
    ];
    const workerCodex = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      workerCodexAuthority,
      { CODEX_HOME: path.join(home, '.codex') },
    );
    if (!workerCodex) throw new Error('expected worker Codex decoration');
    expect(workerCodex.extraArgs.join(' ')).toContain(
      'mcp_servers.supabase.url="https://mcp.supabase.com/mcp"',
    );
    writeHub(cwd, {
      schemaVersion: 1,
      servers: [HUB_HTTP_SERVER, HUB_STDIO_SERVER],
    });

    const opencodeAuthority = authority(cwd, true);
    opencodeAuthority.context!.allowedTools = [
      'mcp__context7__*',
      'mcp__linear__*',
    ];
    const opencode = prepareAgentSpawnDecoration(
      adapter('opencode'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      opencodeAuthority,
      undefined,
    );
    if (!opencode) throw new Error('expected OpenCode mission decoration');
    const opencodeConfig = JSON.parse(
      opencode.env.OPENCODE_CONFIG_CONTENT,
    ) as { mcp: Record<string, unknown> };
    expect(Object.keys(opencodeConfig.mcp)).toContain('context7');
    expect(Object.keys(opencodeConfig.mcp)).toContain('linear');
    expect(opencode.extraArgs).toContain('--pure');

    const kimiAuthority = authority(cwd, true);
    kimiAuthority.context!.allowedTools = ['mcp__context7__*'];
    const kimi = prepareAgentSpawnDecoration(
      adapter('kimi'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      kimiAuthority,
      { KIMI_CODE_HOME: path.join(home, '.kimi-code') },
    );
    if (!kimi) throw new Error('expected Kimi mission decoration');
    expect(
      fs.readFileSync(path.join(kimi.env.KIMI_CODE_HOME, 'mcp.json'), 'utf8'),
    ).toContain('@upstash/context7-mcp');

    const grokAuthority = authority(cwd, true);
    grokAuthority.context!.allowedTools = ['mcp__linear__*'];
    const grok = prepareAgentSpawnDecoration(
      adapter('grok'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      grokAuthority,
      { GROK_HOME: path.join(home, '.grok') },
    );
    if (!grok) throw new Error('expected Grok mission decoration');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).toContain('mcp.linear.app');

    for (const decoration of [
      claude,
      governedClaude,
      codex,
      opencode,
      kimi,
      grok,
    ]) {
      decoration.onSpawnFailed?.();
    }
  });

  it('degrades an absent, empty or corrupt hub to the pre-hub config', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);

    const workspaces = ['absent', 'empty', 'corrupt', 'unusable'].map(
      (name) => {
        const workspace = path.join(root, name);
        fs.mkdirSync(workspace, { recursive: true });
        return fs.realpathSync(workspace);
      },
    );
    writeHub(workspaces[1]!, { schemaVersion: 1, servers: [] });
    writeHub(workspaces[2]!, '{ this is not json');
    // Sem `command` E sem `url` não há nada a que conectar: entrada ignorada.
    writeHub(workspaces[3]!, {
      schemaVersion: 1,
      servers: [{ id: 'ghost', name: 'Ghost', transport: 'stdio' }],
    });

    for (const cwd of workspaces) {
      const claude = prepareAgentSpawnDecoration(
        adapter('claude'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        authority(cwd, true),
        undefined,
      );
      if (!claude) throw new Error('expected Claude decoration');
      expect(Object.keys(generatedClaudeMcpServers(claude))).toEqual(['nexus']);
      expect(claude.extraArgs).toContain('--mcp-config');
      expect(claude.extraArgs).toContain('--settings');
      expect(claude.extraArgs).toContain('--strict-mcp-config');

      const codex = prepareAgentSpawnDecoration(
        adapter('codex'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        authority(cwd, true),
        undefined,
      );
      if (!codex) throw new Error('expected Codex decoration');
      const declared = new Set(
        [...codex.extraArgs.join(' ').matchAll(
          /mcp_servers\.([A-Za-z0-9_-]+)\./g,
        )].map((match) => match[1]!),
      );
      expect(declared.size).toBe(1);
      expect([...declared][0]).toMatch(/^nexus_[0-9a-f]{12}$/);

      claude.onSpawnFailed?.();
      codex.onSpawnFailed?.();
    }
  });

  it('preserves the full real profile for a direct pane', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    write(
      path.join(home, '.grok', 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-direct-mcp"\n' +
        '\n[plugins]\nenabled = ["external-direct-plugin"]\n',
    );

    const decoration = prepareAgentSpawnDecoration(
      adapter('grok'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
      { GROK_HOME: path.join(home, '.grok') },
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Grok spawn decoration');
    const config = fs.readFileSync(
      path.join(decoration.env.GROK_HOME, 'config.toml'),
      'utf8',
    );

    expect(config).toContain('external-direct-mcp');
    expect(config).toContain('external-direct-plugin');
    expect(decoration.extraArgs).not.toContain('--no-subagents');
    expect(decoration.env.HOME).toBeUndefined();
    decoration.onSpawnFailed?.();
  });
});

describe('Muse is not Claude MCP autoload (F-596)', () => {
  function museAdapter(): CliPtyAdapter {
    const parsed = adapterSchema.parse(
      BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'muse'),
    );
    if (parsed.kind !== 'cli-pty') throw new Error('muse must be cli-pty');
    return parsed;
  }

  it('direct Muse pane does not receive Claude --mcp-config/--settings', () => {
    // Campo 2026-09-19: o adapter marcava mcpAutoload, o spawn injetava
    // --mcp-config/--settings (flags do Claude) e o Muse 1.3 imprimia o
    // --help e saía com code 2.
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);

    const decoration = prepareAgentSpawnDecoration(
      museAdapter(),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Muse spawn decoration');
    try {
      expect(decoration.extraArgs).not.toContain('--mcp-config');
      expect(decoration.extraArgs).not.toContain('--settings');
      expect(decoration.extraArgs).not.toContain('--strict-mcp-config');
      expect(decoration.env.HOME).toBeUndefined();
    } finally {
      decoration.onSpawnFailed?.();
    }
  });

  it('even a poisoned mcpAutoload on the Muse binary does not inject Claude flags', () => {
    const root = tempRoot();
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', path.join(root, 'home'));
    const poisoned: CliPtyAdapter = {
      ...museAdapter(),
      quirks: {
        ...museAdapter().quirks,
        mcpAutoload: true,
        nexusMcp: 'autoload',
      },
    };
    const decoration = prepareAgentSpawnDecoration(
      poisoned,
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Muse spawn decoration');
    try {
      expect(decoration.extraArgs).not.toContain('--mcp-config');
      expect(decoration.extraArgs).not.toContain('--settings');
      expect(decoration.env.HOME).toBeUndefined();
    } finally {
      decoration.onSpawnFailed?.();
    }
  });
});

describe('F-1157: nenhum pane Claude-family nega o WebFetch', () => {
  /** Settings Claude-family que o spawn realmente montou (os dois canais). */
  function claudeSettingsFiles(decoration: AgentSpawnDecoration): string[] {
    const files: string[] = [];
    const flag = decoration.extraArgs.indexOf('--settings');
    if (flag >= 0) files.push(decoration.extraArgs[flag + 1]!);
    const ephemeral = path.join(decoration.env.HOME ?? '', '.claude', 'settings.json');
    if (decoration.env.HOME && fs.existsSync(ephemeral)) files.push(ephemeral);
    return files;
  }

  function deniesWebFetch(decoration: AgentSpawnDecoration): boolean {
    return claudeSettingsFiles(decoration).some((file) => {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        hooks?: { PreToolUse?: Array<{ matcher?: string }> };
      };
      return (settings.hooks?.PreToolUse ?? []).some(
        (entry) => entry.matcher === 'WebFetch',
      );
    });
  }

  function spawnClaudeFamily(
    id: 'claude' | 'glm',
    configure: (context: NonNullable<BoundSpawnAuthority['context']>) => void,
  ): AgentSpawnDecoration {
    const home = path.join(tempRoot(), 'home');
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    const spawnAuthority = authority(cwd, true, true);
    configure(spawnAuthority.context!);
    const decoration = prepareAgentSpawnDecoration(
      adapter(id),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      spawnAuthority,
    );
    if (!decoration) throw new Error(`expected ${id} decoration`);
    return decoration;
  }

  it.each([
    ['worker de missão livre (operator-choice)', 'claude' as const, () => {}],
    ['worker governado com a allowlist de página (GLM, HOME efêmero)', 'glm' as const, (context: NonNullable<BoundSpawnAuthority['context']>) => {
      context.allowedTools = [...NEXUS_BROWSER_WORKER_TOOLS];
    }],
    ['allowlist vazia (padrão do worker ad hoc)', 'claude' as const, (context: NonNullable<BoundSpawnAuthority['context']>) => {
      context.allowedTools = [];
    }],
    ['pane que era somente leitura', 'claude' as const, (context: NonNullable<BoundSpawnAuthority['context']>) => {
      context.readOnly = true;
    }],
  ])('%s: o WebFetch fica liberado', (_label, id, configure) => {
    const decoration = spawnClaudeFamily(id, configure);
    try {
      expect(claudeSettingsFiles(decoration).length).toBeGreaterThan(0);
      expect(deniesWebFetch(decoration)).toBe(false);
    } finally {
      decoration.onSpawnFailed?.();
    }
  });
});

it.runIf(process.platform === 'darwin')('MCP shutdown retains an unproven child bootstrap until physical exit', async () => {
  const { stopMcpServer } = await import('./mcp-server');
  const { publishExternalSessionExit } = await import('../pty/pty-manager');
  const { spawnSync } = await import('node:child_process');
  const home = path.join(tempRoot(), 'home');
  const cwd = path.join(home, 'workspace'); fs.mkdirSync(cwd);
  vi.stubEnv('HOME', home);
  const decoration = prepareAgentSpawnDecoration(adapter('claude'), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false))!;
  const profile = decoration.env.NEXUS_HEAVY_ZDOTDIR;
  expect(fs.existsSync(path.join(profile, '.zshenv'))).toBe(true);
  const sessionId = 'finite-unproven-heavy-zsh';
  decoration.onSpawned?.(sessionId);
  await stopMcpServer();
  try {
    expect(fs.existsSync(path.join(profile, '.zshenv'))).toBe(true);
    const result = spawnSync('/bin/zsh', ['-s'], { cwd,
      env: { ...decoration.env, PATH: '/usr/bin:/bin', HOME: home, NEXUS_HEAVY_NODE: process.execPath,
        NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', NODE_OPTIONS: '' },
      // `make --version` sozinho é pedido trivial e não vai à fila (F-982,
      // segunda revisão); `-s` mantém uma invocação real do make, ainda medida.
      input: '/usr/bin/make -s --version', encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(78);
  } finally { publishExternalSessionExit(sessionId); }
  expect(fs.existsSync(profile)).toBe(false);
});

it.runIf(process.platform === 'darwin')('failed spawn removes its unbound private bootstrap', () => {
  const home = path.join(tempRoot(), 'home');
  const cwd = path.join(home, 'workspace'); fs.mkdirSync(cwd);
  vi.stubEnv('HOME', home);
  const decoration = prepareAgentSpawnDecoration(adapter('claude'), { kind: 'cli-agent', cols: 80, rows: 24 }, authority(cwd, false))!;
  const profile = decoration.env.NEXUS_HEAVY_ZDOTDIR;
  expect(fs.existsSync(profile)).toBe(true);
  decoration.onSpawnFailed?.();
  expect(fs.existsSync(profile)).toBe(false);
});

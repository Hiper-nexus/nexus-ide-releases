import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MIMO_CLI_MODELS } from '../../shared/mimo-models';
import { mimoAuthSnapshot, mimoNativePaths, parseMimoAuth } from '../adapters/mimo-auth';
import { openCodeHubMcpServers } from '../mcp-hub/mcp-hub-spawn';
import {
  activateArtifact,
  ensurePrivateDirectory,
  linkProviderSessionState,
  runtimeServerName,
  validateCliMcpInputs,
  withCliMcpArtifactTransaction,
  writePrivateFileAtomic,
} from './cli-mcp-session-artifacts';
import { mirrorGovernedSkills } from './cli-mcp-session-governance';
import type { CliMcpSessionOptions, CliMcpSessionResult } from './cli-mcp-session-types';
import { resolveGovernedCliProfile, type ResolvedGovernedCliProfile } from './governed-cli-profile';
import { installMimoStatusHook } from '../agent-hooks/mimo-hook-source';
import { mimoSessionOwnerKey } from '../adapters/mimo-session-owner';

// MiMo also stores checkpoints, memories and tool output outside SQLite.
const CONVERSATION_DIRECTORIES = [
  'database', 'memory', 'storage', 'snapshot', 'workflow', 'worktree',
  'plans', 'tool-output', 'state',
] as const;
const MAX_AUTH_BYTES = 1_048_576;
const MIMO_API_BASE_URL = 'https://api.xiaomimimo.com/v1';

function linkDirectory(source: string, target: string): void {
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function linkAuth(authFile: string, data: string): void {
  ensurePrivateDirectory(path.dirname(authFile));
  try {
    fs.writeFileSync(authFile, '{}\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Keep credential file ownership with the selected account, never a stale overlay copy.
  const target = path.join(data, 'auth.json');
  if (process.platform === 'win32') fs.linkSync(authFile, target);
  else fs.symlinkSync(authFile, target);
}

function prepareAuth(authFile: string, data: string, snapshotNative: boolean, apiKeySelected: boolean): string | undefined {
  if (apiKeySelected) {
    writePrivateFileAtomic(path.join(data, 'auth.json'), '{}\n');
    return undefined;
  }
  if (!snapshotNative) {
    linkAuth(authFile, data);
    return authFile;
  }
  // Native MiMo can contain other providers and well-known remote config.
  // Governed Xiaomi sessions project only their API key; they never sync back.
  let blob = '{}';
  try {
    if (fs.statSync(authFile).size > MAX_AUTH_BYTES) throw new Error('MiMo auth file exceeds the safe size');
    const snapshot = mimoAuthSnapshot(fs.readFileSync(authFile, 'utf8'));
    if (!snapshot) throw new Error('MiMo governed session requires valid Xiaomi credentials');
    blob = snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writePrivateFileAtomic(path.join(data, 'auth.json'), blob);
  return undefined;
}

function governedEnvironment(artifactDir: string): Record<string, string> {
  const processHome = path.join(artifactDir, 'process-home');
  ensurePrivateDirectory(processHome);
  return {
    HOME: processHome,
    USERPROFILE: processHome,
    MIMOCODE_CONFIG: '',
    MIMOCODE_CONFIG_DEFAULTS: '',
    MIMOCODE_AUTH_CONTENT: '',
    MIMOCODE_TUI_CONFIG: '',
    MIMOCODE_CONFIG_DIR: path.join(artifactDir, 'config'),
    MIMOCODE_DISABLE_PROJECT_CONFIG: '1',
    MIMOCODE_DISABLE_CLAUDE_CODE: '1',
    MIMOCODE_DISABLE_CLAUDE_CODE_MCP: '1',
    MIMOCODE_DISABLE_CLAUDE_CODE_COMMANDS: '1',
    MIMOCODE_DISABLE_PROVIDER_ENV: '1',
    MIMOCODE_DISABLE_AGENTS_SKILLS: '1',
    MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS: '0',
    MIMOCODE_ENABLE_CODEX_SKILLS: '0',
    MIMOCODE_ENABLE_OPENCODE_SKILLS: '0',
    MIMOCODE_DISABLE_BUILTIN_SKILLS: '1',
    MIMOCODE_DISABLE_COMPOSE_SKILLS: '1',
  };
}

function prepareConversations(artifactDir: string, options: CliMcpSessionOptions) {
  const data = path.join(artifactDir, 'data');
  ensurePrivateDirectory(data);
  const providerSessionHome = linkProviderSessionState(
    'mimo-code', data, options, CONVERSATION_DIRECTORIES, {},
  );
  const database = path.join(providerSessionHome, 'database', 'mimocode.db');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (fs.lstatSync(`${database}${suffix}`, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('MiMo checkout database must not be a symlink');
    }
  }
  linkDirectory(path.join(providerSessionHome, 'state'), path.join(artifactDir, 'state'));
  return { data, database, providerSessionHome };
}

function prepareConfig(
  artifactDir: string,
  home: string,
  nativeConfig: string,
  options: CliMcpSessionOptions,
  policy: ResolvedGovernedCliProfile,
): string {
  const config = path.join(artifactDir, 'config');
  const selected = options.providerHome && path.join(options.providerHome, 'config');
  const source = selected && fs.existsSync(selected) ? selected : nativeConfig;
  if (policy.governed) {
    mirrorGovernedSkills('mimo-code', home, [path.join(config, 'skills')], policy.allowedSkills, policy.allowedTools);
  } else if (fs.existsSync(source)) {
    linkDirectory(source, config);
  } else {
    ensurePrivateDirectory(config);
  }
  return source;
}

function selectedCredential(data: string): ReturnType<typeof parseMimoAuth> {
  const file = path.join(data, 'auth.json');
  if (fs.statSync(file).size > MAX_AUTH_BYTES) throw new Error('MiMo auth file exceeds the safe size');
  const raw = fs.readFileSync(file, 'utf8');
  const auth = parseMimoAuth(raw);
  if (!auth && raw.trim() !== '{}') throw new Error('MiMo selected credential is invalid');
  return auth;
}

function runtimeConfig(url: string, serverName: string, options: CliMcpSessionOptions, governed: boolean, baseURL: string): string {
  return JSON.stringify({
    ...(governed ? { plugin: [] } : {}),
    provider: { xiaomi: {
      models: MIMO_CLI_MODELS,
      options: { apiKey: options.mimoApiKeySelected ? '{env:XIAOMI_API_KEY}' : '{env:NEXUS_MIMO_API_KEY}', baseURL },
    } },
    mcp: {
      ...openCodeHubMcpServers(options.hubServers ?? []),
      [serverName]: {
        type: 'remote', url, enabled: true, oauth: false,
        headers: { Authorization: 'Bearer {env:NEXUS_MCP_TOKEN}' },
      },
    },
  });
}

/** MiMo's native inline MCP channel, with account auth and checkout conversations. */
export function prepareMimoMcpSession(
  url: string,
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  validateCliMcpInputs(url, token);
  const home = path.resolve(options.home ?? os.homedir());
  const artifactRoot = path.resolve(options.artifactRoot ?? path.join(home, '.nexus', 'ephemeral', 'mcp-clients'));
  return withCliMcpArtifactTransaction('mimo-code', token, artifactRoot, (artifactDir) => {
    const policy = resolveGovernedCliProfile(token, options);
    const native = mimoNativePaths(home);
    const authFile = options.providerHome
      ? path.join(path.resolve(options.providerHome), 'data', 'auth.json')
      : native.authFile;
    const { data, database, providerSessionHome } = prepareConversations(artifactDir, options);
    const providerStateHome = prepareAuth(
      authFile, data, policy.governed && !options.providerHome, options.mimoApiKeySelected === true,
    );
    const configSource = prepareConfig(artifactDir, home, native.config, options, policy);
    const credential = options.mimoApiKeySelected ? null : selectedCredential(data);
    const serverName = runtimeServerName(token);
    const profileEnv = policy.governed ? governedEnvironment(artifactDir) : {};
    const hookConfigDir = installMimoStatusHook(artifactDir, policy.governed, options.mimoCustomConfigDir);
    activateArtifact(token, { artifactDir, providerHome: null, configFiles: [], syncBack: false });
    return {
      env: {
        ...profileEnv,
        MIMOCODE_HOME: artifactDir,
        MIMOCODE_DB: database,
        MIMOCODE_CONFIG_DIR: hookConfigDir,
        NEXUS_AGENT_HOOK_PORT: options.mimoHookEndpoint ? String(options.mimoHookEndpoint.port) : '',
        NEXUS_AGENT_HOOK_TOKEN: options.mimoHookEndpoint?.token ?? '',
        NEXUS_MIMO_HOOK_TOKEN: randomBytes(32).toString('hex'),
        NEXUS_MIMO_API_KEY: credential?.key ?? '',
        // The selected account's file must win over an inherited auth blob.
        MIMOCODE_AUTH_CONTENT: '',
        MIMOCODE_CONFIG_CONTENT: runtimeConfig(url, serverName, options, policy.governed, credential?.baseUrl ?? MIMO_API_BASE_URL),
      },
      extraArgs: policy.governed ? ['--pure'] : [],
      serverName,
      artifactDir,
      providerStateHome,
      providerStateReadPaths: policy.governed ? [] : [configSource],
      providerSessionHome,
      ...(credential ? { mimoNativeOwnerKey: mimoSessionOwnerKey(credential) } : {}),
    };
  });
}

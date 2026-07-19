import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupCliMcpSession,
  prepareGrokMcpSession,
  prepareKimiMcpSession,
  prepareOpenCodeMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-config';

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

afterEach(() => {
  for (const token of tokens.splice(0)) cleanupCliMcpSession(token);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('prepareOpenCodeMcpSession', () => {
  it('uses the official inline config and expands the bearer from env at runtime', () => {
    const token = 'opencode-secret-token';
    const result = prepareOpenCodeMcpSession('http://127.0.0.1:4100/mcp', token);
    const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT) as {
      mcp: Record<string, {
        type: string;
        url: string;
        enabled: boolean;
        headers: Record<string, string>;
      }>;
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
    write(realMcp, JSON.stringify({
      mcpServers: { userServer: { url: 'https://mcp.example.test' } },
    }));
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
    expect(fs.realpathSync(path.join(result.env.GROK_HOME, 'auth.json')))
      .toBe(fs.realpathSync(auth));
    expect(fs.realpathSync(path.join(result.env.GROK_HOME, 'sessions')))
      .toBe(fs.realpathSync(path.dirname(sessionMarker)));
    expect(fs.realpathSync(path.join(result.env.GROK_HOME, 'skills')))
      .toBe(fs.realpathSync(path.join(grokHome, 'skills')));
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
    expect(fs.existsSync(path.join(grokHome, 'hooks', 'nexus.json'))).toBe(false);
  });

  it('links the user\'s own Grok hooks through next to the Nexus doc', () => {
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
    expect(fs.readFileSync(path.join(unrelated, 'marker.txt'), 'utf8'))
      .toBe('unrelated-safe');
  });

  it('preserves artifacts registered as active in this process', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const artifacts = path.join(root, 'artifacts');
    const token = 'active-kimi-token';
    tokens.push(token);
    const active = prepareKimiMcpSession(
      'http://127.0.0.1:4200/mcp',
      token,
      { home, artifactRoot: artifacts },
    );

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

    expect(result.failed).toBe(2);
    expect(result.removed).toBe(0);
    expect(fs.readFileSync(outsideMarker, 'utf8')).toBe('never-delete');
  });
});

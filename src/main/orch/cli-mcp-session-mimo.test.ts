import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sessions from './cli-mcp-session-config';
import type { CliMcpSessionOptions } from './cli-mcp-session-types';

const roots: string[] = [];
const tokens: string[] = [];
function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mimo-')));
  roots.push(home);
  const providerHome = path.join(home, 'managed');
  write(path.join(providerHome, 'data', 'auth.json'), '{"xiaomi":{"type":"api","key":"test-account-key"}}');
  write(path.join(providerHome, 'data', 'mimocode.db'), 'external conversation');
  write(path.join(providerHome, 'config', 'mimocode.jsonc'), '{// preferences\n"model":"xiaomi/mimo-v2.6-pro"}');
  return { home, providerHome, artifactRoot: path.join(home, 'artifacts'), userDataPath: path.join(home, 'user-data'), checkoutId: 'checkout-a' };
}
function prepare(options: CliMcpSessionOptions, token = `mimo-${tokens.length}`) {
  tokens.push(token);
  expect(sessions).toHaveProperty('prepareMimoMcpSession');
  return sessions.prepareMimoMcpSession('http://127.0.0.1:9123/mcp', token, options);
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const token of tokens.splice(0)) sessions.cleanupCliMcpSession(token);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MiMo private MCP profile', () => {
  it('pins the selected account key and endpoint over a conflicting native config', () => {
    const options = fixture();
    const endpoint = 'https://token-plan-sgp.xiaomimimo.com/v1';
    write(path.join(options.providerHome, 'data', 'auth.json'), JSON.stringify({ xiaomi: {
      type: 'api', key: 'selected-account-b', metadata: { uid: 'b', base_url: endpoint },
    } }));
    const nativeConfig = path.join(options.providerHome, 'config', 'mimocode.jsonc');
    const old = JSON.stringify({ provider: { xiaomi: { options: { apiKey: 'native-account-a', baseURL: 'https://api.xiaomimimo.com/v1' } } } });
    write(nativeConfig, old);
    const result = prepare(options);
    const inline = JSON.parse(result.env.MIMOCODE_CONFIG_CONTENT);
    expect(inline.provider.xiaomi.options).toEqual({ apiKey: '{env:NEXUS_MIMO_API_KEY}', baseURL: endpoint });
    expect(result.env.NEXUS_MIMO_API_KEY).toBe('selected-account-b');
    expect(result.env.MIMOCODE_CONFIG_CONTENT).not.toContain('selected-account-b');
    expect(fs.readFileSync(nativeConfig, 'utf8')).toBe(old);
  });

  it('uses native env substitution and keeps the bearer out of files and argv', () => {
    const options = fixture();
    const token = 'mimo-unique-bearer-never-persist';
    const result = prepare(options, token);
    const config = JSON.parse(result.env.MIMOCODE_CONFIG_CONTENT);
    expect(config.mcp[result.serverName]).toEqual({
      type: 'remote', url: 'http://127.0.0.1:9123/mcp', enabled: true,
      oauth: false, headers: { Authorization: 'Bearer {env:NEXUS_MCP_TOKEN}' },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.extraArgs).toEqual([]);
    expect(fs.readFileSync(path.join(result.env.MIMOCODE_HOME, 'config', 'mimocode.jsonc'), 'utf8')).toContain('// preferences');
    expect(result.env.HOME).toBeUndefined();
  });

  it('shares conversation state only within the checkout and never imports native conversations', () => {
    const options = fixture();
    const first = prepare(options);
    const data = path.join(first.env.MIMOCODE_HOME, 'data');
    expect(fs.existsSync(path.join(data, 'mimocode.db'))).toBe(false);
    expect(first.env.MIMOCODE_DB).toBe(path.join(first.providerSessionHome!, 'database', 'mimocode.db'));
    write(first.env.MIMOCODE_DB, 'checkout conversation');
    write(path.join(data, 'memory', 'sessions', 'session-a', 'checkpoint.md'), 'checkpoint');
    const auth = path.join(data, 'auth.json');
    expect(fs.realpathSync(auth)).toBe(fs.realpathSync(path.join(options.providerHome, 'data', 'auth.json')));
    fs.writeFileSync(auth, '{"xiaomi":{"type":"api","key":"new-key"}}');
    expect(fs.readFileSync(path.join(options.providerHome, 'data', 'auth.json'), 'utf8')).toContain('new-key');
    sessions.cleanupCliMcpSession(tokens[0]);
    const next = prepare(options);
    expect(fs.readFileSync(next.env.MIMOCODE_DB, 'utf8')).toBe('checkout conversation');
    expect(fs.readFileSync(path.join(next.env.MIMOCODE_HOME, 'data', 'memory', 'sessions', 'session-a', 'checkpoint.md'), 'utf8')).toBe('checkpoint');
    const other = prepare({ ...options, checkoutId: 'checkout-b' });
    expect(fs.existsSync(other.env.MIMOCODE_DB)).toBe(false);
    expect(fs.readFileSync(path.join(options.providerHome, 'data', 'mimocode.db'), 'utf8')).toBe('external conversation');
  });

  it('keeps simultaneous accounts separate while sharing the checkout database', () => {
    const options = fixture();
    const accountB = path.join(options.home, 'account-b');
    write(path.join(accountB, 'data', 'auth.json'), '{"xiaomi":{"type":"api","key":"account-b"}}');
    const first = prepare(options);
    const second = prepare({ ...options, providerHome: accountB });
    expect(second.env.MIMOCODE_AUTH_CONTENT).toBe('');
    expect(first.env.MIMOCODE_DB).toBe(second.env.MIMOCODE_DB);
    expect(fs.readFileSync(path.join(first.env.MIMOCODE_HOME, 'data', 'auth.json'), 'utf8')).toContain('test-account-key');
    expect(fs.readFileSync(path.join(second.env.MIMOCODE_HOME, 'data', 'auth.json'), 'utf8')).toContain('account-b');
    fs.rmSync(path.join(accountB, 'data', 'auth.json'));
    expect(fs.existsSync(path.join(second.env.MIMOCODE_HOME, 'data', 'auth.json'))).toBe(false);
  });

  it('uses native XDG auth and config without a managed home', () => {
    const options = fixture();
    const xdgData = path.join(options.home, 'xdg-data');
    const xdgConfig = path.join(options.home, 'xdg-config');
    vi.stubEnv('MIMOCODE_HOME', '');
    vi.stubEnv('XDG_DATA_HOME', xdgData);
    vi.stubEnv('XDG_CONFIG_HOME', xdgConfig);
    write(path.join(xdgData, 'mimocode', 'auth.json'), '{"xiaomi":{"type":"api","key":"native"}}');
    write(path.join(xdgConfig, 'mimocode', 'mimocode.json'), '{}');
    const result = prepare({ ...options, providerHome: undefined });
    expect(result.providerStateHome).toBe(path.join(xdgData, 'mimocode', 'auth.json'));
    expect(fs.realpathSync(path.join(result.env.MIMOCODE_HOME, 'config'))).toBe(path.join(xdgConfig, 'mimocode'));
  });

  it('excludes unrelated native credentials and well-known remote config from a governed Xiaomi session', () => {
    const options = fixture();
    vi.stubEnv('MIMOCODE_HOME', '');
    vi.stubEnv('XDG_DATA_HOME', path.join(options.home, 'xdg-data'));
    const nativeAuth = path.join(options.home, 'xdg-data', 'mimocode', 'auth.json');
    const native = {
      xiaomi: { type: 'api', key: 'native-xiaomi' },
      'https://unrelated.example': { type: 'wellknown', key: 'ambient-key', token: 'ambient-token' },
    };
    write(nativeAuth, JSON.stringify(native));
    const result = prepare({ ...options, providerHome: undefined, governed: true });
    const projected = path.join(result.env.MIMOCODE_HOME, 'data', 'auth.json');
    expect(JSON.parse(fs.readFileSync(projected, 'utf8'))).toEqual({ xiaomi: native.xiaomi });
    expect(JSON.parse(fs.readFileSync(nativeAuth, 'utf8'))).toEqual(native);
    expect(fs.statSync(projected).mode & 0o777).toBe(0o600);
    expect(result.providerStateHome).toBeUndefined();
  });

  it.each([false, true])('pins the selected API-key account without loading native auth (governed=%s)', governed => {
    const options = fixture();
    const result = prepare({ ...options, governed, mimoApiKeySelected: true });
    const auth = path.join(result.env.MIMOCODE_HOME, 'data', 'auth.json');
    expect(JSON.parse(fs.readFileSync(auth, 'utf8'))).toEqual({});
    expect(result.providerStateHome).toBeUndefined();
    expect(JSON.parse(result.env.MIMOCODE_CONFIG_CONTENT).provider.xiaomi.options).toEqual({
      apiKey: '{env:XIAOMI_API_KEY}',
      baseURL: 'https://api.xiaomimimo.com/v1',
    });
    expect(fs.readFileSync(path.join(options.providerHome, 'data', 'auth.json'), 'utf8')).toContain('test-account-key');
  });

  it('purges stale MiMo overlays while preserving active panes and checkout memory', () => {
    const options = fixture();
    const active = prepare(options);
    const stale = path.join(options.artifactRoot, 'mimo-code', 'a'.repeat(32));
    write(path.join(stale, 'data', 'auth.json'), '{}');
    const memory = path.join(active.providerSessionHome!, 'memory', 'note.txt');
    write(memory, 'retain');
    sessions.purgeStaleCliMcpSessions(options);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(active.artifactDir!)).toBe(true);
    expect(fs.readFileSync(memory, 'utf8')).toBe('retain');
  });

  it('disables ambient execution roots and mirrors only granted skills in governed sessions', () => {
    const options = fixture();
    write(path.join(options.home, '.agents', 'skills', 'allowed', 'SKILL.md'), '# Allowed');
    write(path.join(options.home, '.agents', 'skills', 'blocked', 'SKILL.md'), '# Blocked');
    write(path.join(options.home, '.mimocode', 'skills', 'ambient', 'SKILL.md'), '# Ambient');
    const result = prepare({ ...options, governed: true, allowedSkills: ['allowed'] });
    expect(result.extraArgs).toEqual(['--pure']);
    expect(result.env.HOME).toBe(path.join(result.artifactDir!, 'process-home'));
    expect(fs.existsSync(path.join(result.env.HOME, '.mimocode'))).toBe(false);
    expect(fs.readdirSync(path.join(result.env.MIMOCODE_HOME, 'config', 'skills'))).toEqual(['allowed']);
    expect(fs.existsSync(path.join(result.env.MIMOCODE_HOME, 'config', 'mimocode.jsonc'))).toBe(false);
    expect(result.env).toMatchObject({
      MIMOCODE_DISABLE_PROJECT_CONFIG: '1', MIMOCODE_DISABLE_CLAUDE_CODE: '1',
      MIMOCODE_DISABLE_CLAUDE_CODE_MCP: '1', MIMOCODE_DISABLE_CLAUDE_CODE_COMMANDS: '1',
      MIMOCODE_DISABLE_AGENTS_SKILLS: '1', MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS: '0',
      MIMOCODE_ENABLE_CODEX_SKILLS: '0', MIMOCODE_ENABLE_OPENCODE_SKILLS: '0',
      MIMOCODE_DISABLE_BUILTIN_SKILLS: '1', MIMOCODE_DISABLE_COMPOSE_SKILLS: '1',
      MIMOCODE_CONFIG: '', MIMOCODE_AUTH_CONTENT: '', MIMOCODE_CONFIG_DEFAULTS: '',
    });
    expect(result.providerStateHome).toBe(path.join(options.providerHome, 'data', 'auth.json'));
    expect(JSON.parse(result.env.MIMOCODE_CONFIG_CONTENT).plugin).toEqual([]);
  });

  it('rejects poisoned durable database paths and rolls back the overlay', () => {
    const options = fixture();
    const database = path.join(options.userDataPath, 'provider-state', 'mimo-code', options.checkoutId, 'database');
    fs.mkdirSync(database, { recursive: true });
    const outside = path.join(options.home, 'outside');
    write(outside, 'untouched');
    fs.symlinkSync(outside, path.join(database, 'mimocode.db-wal'));
    expect(() => prepare(options)).toThrow(/database.*symlink/i);
    expect(fs.readdirSync(path.join(options.artifactRoot, 'mimo-code'))).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });
});

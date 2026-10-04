import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { afterEach, expect, it, vi } from 'vitest';
import { activateArtifact, cleanupCliMcpSession } from './cli-mcp-session-artifacts';
import { configureCodexNativeHeavyChannel, codexNativeHeavyChannelPolicy } from './codex-native-heavy-channel';

const roots: string[] = [], tokens: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const token of tokens.splice(0)) cleanupCliMcpSession(token);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const channelKeys = ['NEXUS_HEAVY_CHANNEL_DIR', 'NEXUS_HEAVY_CHANNEL_KEY', 'NEXUS_HEAVY_CHANNEL_EPOCH', 'NEXUS_HEAVY_CHANNEL_PUBLIC_KEY'];
it.each(['invalid', { ignore_default_excludes: 'false' }, { filters: 'invalid' }, { filters: { SAFE: 'include', safe: 'exclude' } },
  { set: 'invalid' }, { set: ['invalid'] }, { set: { SAFE: 42 } }])(
  'does not make an invalid native environment policy valid while adding the channel: %j', shell_environment_policy => {
    expect(() => codexNativeHeavyChannelPolicy({ shell_environment_policy }, ['SAFE'])).toThrow('environment_policy_invalid');
  });
it('preserves offline workspace-write while inheriting only channel names and the original allowed environment', () => {
  const config = { model: 'selected', sandbox_mode: 'workspace-write', shell_environment_policy: { inherit: 'core', ignore_default_excludes: false,
    set: { HOME: '/private/home', NEXUS_GATE_TOKEN: 'existing-main-value' } } };
  const result = codexNativeHeavyChannelPolicy(config, ['PATH', 'HOME', 'API_KEY', 'UNRELATED', ...channelKeys]);
  expect(result.model).toBe('selected'); expect(result.sandbox_mode).toBe('workspace-write');
  expect(result).not.toHaveProperty('sandbox_workspace_write'); expect(result).not.toHaveProperty('features');
  expect(result.shell_environment_policy.include_only).toEqual(expect.arrayContaining(['PATH', 'HOME', 'NEXUS_GATE_TOKEN', ...channelKeys]));
  expect(result.shell_environment_policy.include_only).not.toEqual(expect.arrayContaining(['API_KEY', 'UNRELATED']));
  expect(result.shell_environment_policy.set).toEqual(config.shell_environment_policy.set);
  expect(config).not.toHaveProperty('features');
});
it('preserves active proxy domains, denied sockets, the named filesystem profile and filtered environment', () => {
  const config = { default_permissions: 'selected', permissions: { selected: { filesystem: { '/workspace': 'write' }, network: {
    enabled: true, domains: { 'example.test': 'allow' } } } }, features: { network_proxy: { enabled: true,
    unix_sockets: { '/private/other.sock': 'deny' }, domains: { 'example.test': 'allow', 'blocked.test': 'deny' } } },
    shell_environment_policy: { inherit: 'all', ignore_default_excludes: false, filters: { 'SAFE*': 'include', '*SECRET*': 'exclude' } } };
  const result = codexNativeHeavyChannelPolicy(config, ['SAFE_VALUE', 'SAFE_SECRET', 'OTHER', ...channelKeys]);
  expect(result.permissions).toEqual(config.permissions); expect(result.features).toEqual(config.features);
  expect(result.shell_environment_policy.include_only).toEqual(['SAFE_VALUE', ...channelKeys]);
  expect(result.shell_environment_policy).not.toHaveProperty('filters');
});
it('does not activate configured remote grants on an offline named profile', () => {
  const config = { default_permissions: 'selected', permissions: { selected: { filesystem: { '/workspace': 'read' }, network: {
    enabled: false, domains: { 'example.test': 'allow' } } } } };
  const result = codexNativeHeavyChannelPolicy(config, []);
  expect(result.permissions).toEqual(config.permissions); expect(result).not.toHaveProperty('features');
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-channel-policy-'))); roots.push(root);
  const token = 'private-channel-'+roots.length; tokens.push(token);
  const artifactDir = path.join(root, 'codex', 'owned'); fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, 'config.toml'); fs.writeFileSync(file, stringify({ model: 'selected', sandbox_mode: 'workspace-write' }));
  const providerHome = path.join(root, 'provider'); fs.mkdirSync(providerHome); fs.writeFileSync(path.join(providerHome, 'config.toml'), 'model="native"\n');
  activateArtifact(token, { artifactDir, providerHome, configFiles: ['config.toml'], syncBack: true });
  return { root, token, artifactDir, file, providerHome };
}
const env = { NEXUS_HEAVY_CHANNEL_DIR: '/private/tmp/owned', NEXUS_HEAVY_CHANNEL_KEY: 'a'.repeat(64),
  NEXUS_HEAVY_CHANNEL_EPOCH: '11111111-1111-4111-8111-111111111111', NEXUS_HEAVY_CHANNEL_PUBLIC_KEY: 'private-test-public-key' };
it('rewrites only the active private artifact; keys remain runtime environment values', async () => {
  const f = fixture(); await configureCodexNativeHeavyChannel(f.token, env, ['PATH', ...channelKeys], () => {});
  const raw = fs.readFileSync(f.file, 'utf8'), result = parse(raw) as Record<string, any>;
  expect(result.model).toBe('selected'); expect(result).not.toHaveProperty('features');
  expect(raw).not.toContain(env.NEXUS_HEAVY_CHANNEL_KEY); expect(raw).not.toContain(env.NEXUS_HEAVY_CHANNEL_PUBLIC_KEY);
  expect(fs.readFileSync(path.join(f.providerHome, 'config.toml'), 'utf8')).toBe('model="native"\n');
  expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
});
it('rejects revoked ownership after a read and leaves the original bytes untouched', async () => {
  const f = fixture(), original = fs.readFileSync(f.file, 'utf8'); let guards = 0;
  await expect(configureCodexNativeHeavyChannel(f.token, env, [], () => { if (++guards >= 6) throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(fs.readFileSync(f.file, 'utf8')).toBe(original); expect(fs.readdirSync(f.artifactDir)).toEqual(['config.toml']);
});
it('rejects active-artifact replacement during IO even when the token and path are reused', async () => {
  const f = fixture(), original = fs.readFileSync(f.file, 'utf8'); let guards = 0;
  await expect(configureCodexNativeHeavyChannel(f.token, env, [], () => {
    if (++guards === 6) activateArtifact(f.token, { artifactDir: f.artifactDir, providerHome: f.providerHome, configFiles: ['config.toml'], syncBack: true });
  })).rejects.toThrow('artifact_changed');
  expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
});
it('rejects a config symlink before touching a different file', async () => {
  const f = fixture(), outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'model="untouched"');
  fs.unlinkSync(f.file); fs.symlinkSync(outside, f.file);
  await expect(configureCodexNativeHeavyChannel(f.token, env, [], () => {})).rejects.toThrow();
  expect(fs.readFileSync(outside, 'utf8')).toBe('model="untouched"');
});
it.skipIf(process.platform === 'win32')('rejects a FIFO without requiring a writer to unblock the Main read', async () => {
  const f = fixture(); fs.unlinkSync(f.file); execFileSync('/usr/bin/mkfifo', [f.file]);
  let rescued = false;
  const rescue = setTimeout(() => { rescued = true;
    try { const fd = fs.openSync(f.file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* No reader is waiting after the fix. */ }
  }, 250);
  try { await expect(configureCodexNativeHeavyChannel(f.token, env, [], () => {})).rejects.toThrow('config_invalid'); expect(rescued).toBe(false); }
  finally { clearTimeout(rescue); }
});

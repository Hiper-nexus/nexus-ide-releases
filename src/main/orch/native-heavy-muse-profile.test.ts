import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { museNativeHeavySettings, reserveMuseNativeHeavyProfile } from './native-heavy-muse-profile';
import { activateArtifact, cleanupCliMcpSession, getActiveCliMcpArtifact } from './cli-mcp-session-artifacts';

const fixtures: Array<{ root: string; token: string }> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) { cleanupCliMcpSession(fixture.token); fs.rmSync(fixture.root, { recursive: true, force: true }); } });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-muse-profile-'))), token = `own-${path.basename(root)}`;
  fixtures.push({ root, token });
  const config = path.join(root, 'selected-config'), resourceDirectory = path.join(root, 'resources');
  fs.mkdirSync(path.join(config, 'muse'), { recursive: true }); fs.mkdirSync(resourceDirectory);
  fs.writeFileSync(path.join(resourceDirectory, 'muse-tool-hook.cjs'), '// own fixture');
  return { root, token, config, options: { token, home: root, xdgConfigHome: config, artifactRoot: path.join(root, 'artifacts'), node: fs.realpathSync(process.execPath), resourceDirectory } };
}

it('appends only the fixed Main hook while retaining selected account/model/permissions and original hook consent', () => {
  const original = { model: 'selected-model', approval_mode: 'never', permission_profile: 'selected-profile', runtime_capabilities: { old: { enabled: false } },
    hooks: { PreToolUse: [{ matcher: 'original', hooks: [{ command: 'original' }] }], Stop: [{ original: true }] }, mcpServers: { original: { command: 'original' } } };
  const copy = structuredClone(original), next = museNativeHeavySettings(original, '/Main Node/node', '/Main Resource/heavy-command');
  expect(original).toEqual(copy);
  const { hooks: oldHooks, ...selected } = copy, { hooks: nextHooks, ...retained } = next; expect(retained).toEqual(selected);
  expect((nextHooks as typeof oldHooks).Stop).toEqual(oldHooks.Stop);
  const hooks = next.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  expect(hooks.PreToolUse).toHaveLength(2); expect(hooks.PreToolUse[1].matcher).toBe('bash');
  expect(hooks.PreToolUse[0]).toEqual(oldHooks.PreToolUse[0]);
  expect(hooks.PreToolUse[1].hooks[0].command).toContain("'/Main Node/node' '/Main Resource/heavy-command/muse-tool-hook.cjs'");
  expect(JSON.stringify(next)).not.toMatch(/NEXUS_(?:GATE_TOKEN|HEAVY_CHANNEL_KEY|HEAVY_COMMAND_URL)/);
});
it('refuses malformed original hook structure and relative resources', () => {
  expect(() => museNativeHeavySettings({ hooks: [] }, '/Main/node', '/Main/resources')).toThrow('hooks_invalid');
  expect(() => museNativeHeavySettings({ hooks: { PreToolUse: {} } }, '/Main/node', '/Main/resources')).toThrow('hooks_invalid');
  expect(() => museNativeHeavySettings({}, 'node', '/Main/resources')).toThrow('resource_invalid');
});

it('reserves synchronously, then asynchronously snapshots only Muse settings and retains selected companion paths', async () => {
  const f = fixture(), settings = path.join(f.config, 'muse/settings.json');
  const original = { model: 'selected', permission_profile: 'unrestricted', approval_mode: 'never', hooks: { Stop: [{ original: true }] }, mcpServers: { selected: { command: 'selected' } } };
  fs.writeFileSync(settings, JSON.stringify(original)); fs.writeFileSync(path.join(f.config, 'muse/companion'), 'selected-data');
  fs.mkdirSync(path.join(f.config, 'other-tool')); fs.writeFileSync(path.join(f.config, 'other-tool/selected'), 'selected-tool');
  const profile = reserveMuseNativeHeavyProfile(f.options);
  expect(profile).not.toBeInstanceOf(Promise); expect(Object.keys(profile.env)).toEqual(['XDG_CONFIG_HOME']);
  expect(getActiveCliMcpArtifact(f.token)?.artifactDir).toBe(profile.env.XDG_CONFIG_HOME);
  expect(fs.existsSync(path.join(profile.env.XDG_CONFIG_HOME, 'muse/settings.json'))).toBe(false);
  await profile.initialize(() => {});
  const next = JSON.parse(fs.readFileSync(path.join(profile.env.XDG_CONFIG_HOME, 'muse/settings.json'), 'utf8'));
  expect(next).toMatchObject(original); expect(next.hooks.PreToolUse).toHaveLength(1);
  expect(fs.readFileSync(settings, 'utf8')).toBe(JSON.stringify(original));
  expect(fs.readFileSync(path.join(profile.env.XDG_CONFIG_HOME, 'muse/companion'), 'utf8')).toBe('selected-data');
  expect(fs.readFileSync(path.join(profile.env.XDG_CONFIG_HOME, 'other-tool/selected'), 'utf8')).toBe('selected-tool');
  expect(JSON.stringify(next)).not.toMatch(/NEXUS_(?:GATE_TOKEN|HEAVY_CHANNEL_KEY|HEAVY_COMMAND_URL)/);
  cleanupCliMcpSession(f.token); expect(fs.existsSync(profile.env.XDG_CONFIG_HOME)).toBe(false); expect(fs.existsSync(settings)).toBe(true);
});
it('does no deferred IO after cancellation and rejects a rebound artifact after an IO wait', async () => {
  const f = fixture(), profile = reserveMuseNativeHeavyProfile(f.options);
  await expect(profile.initialize(() => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
  expect(fs.existsSync(path.join(profile.env.XDG_CONFIG_HOME, 'muse/settings.json'))).toBe(false);
  const second = reserveMuseNativeHeavyProfile(f.options), realpath = fs.promises.realpath.bind(fs.promises);
  vi.spyOn(fs.promises, 'realpath').mockImplementationOnce(async (...args) => {
    const result = await realpath(...args);
    activateArtifact(f.token, { artifactDir: second.env.XDG_CONFIG_HOME, providerHome: null, configFiles: [], syncBack: false });
    return result;
  });
  await expect(second.initialize(() => {})).rejects.toThrow('artifact_changed');
  expect(fs.existsSync(path.join(second.env.XDG_CONFIG_HOME, 'muse/settings.json'))).toBe(false);
});
it.runIf(process.platform !== 'win32')('rejects a selected FIFO without blocking and preserves a foreign settings destination', async () => {
  const f = fixture(), source = path.join(f.config, 'muse/settings.json');
  execFileSync('/usr/bin/mkfifo', [source]); const profile = reserveMuseNativeHeavyProfile(f.options);
  await expect(profile.initialize(() => {})).rejects.toThrow('config_invalid'); fs.unlinkSync(source);
  fs.writeFileSync(source, '{}'); const second = reserveMuseNativeHeavyProfile(f.options), destination = path.join(second.env.XDG_CONFIG_HOME, 'muse/settings.json');
  fs.writeFileSync(destination, 'foreign'); await expect(second.initialize(() => {})).rejects.toThrow('artifact_changed');
  expect(fs.readFileSync(destination, 'utf8')).toBe('foreign');
});

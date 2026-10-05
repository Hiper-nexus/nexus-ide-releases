import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { museNativeHeavySettings, reserveMuseNativeHeavyProfile } from './native-heavy-muse-profile';
import { cleanupCliMcpSession, getActiveCliMcpArtifact } from './cli-mcp-session-artifacts';
import { recentTraceContext } from '../observability/main-trace';

const fixtures: Array<{ root: string; token: string }> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) { cleanupCliMcpSession(fixture.token); fs.rmSync(fixture.root, { recursive: true, force: true }); } });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-muse-profile-'))), token = `own-${path.basename(root)}`;
  fixtures.push({ root, token });
  const config = path.join(root, 'selected-config'), resourceDirectory = path.join(root, 'resources');
  fs.mkdirSync(path.join(config, 'muse'), { recursive: true }); fs.mkdirSync(resourceDirectory);
  fs.writeFileSync(path.join(resourceDirectory, 'muse-tool-hook.cjs'), '// own fixture');
  const settings = path.join(config, 'muse/settings.json'), ledgerRoot = path.join(root, 'artifacts/muse/leases');
  return { root, token, config, settings, ledgerRoot, options: { token, home: root, xdgConfigHome: config, artifactRoot: path.join(root, 'artifacts'), node: fs.realpathSync(process.execPath), resourceDirectory } };
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

it('keeps the selected auth/XDG in place and the token physical-exit cleanup releases the leased hook', async () => {
  const f = fixture(), auth = path.join(f.config, 'muse/auth.json');
  const original = { model: 'selected', permission_profile: 'unrestricted', approval_mode: 'never', hooks: { Stop: [{ original: true }] }, mcpServers: { selected: { command: 'selected' } } };
  fs.writeFileSync(f.settings, JSON.stringify(original)); fs.writeFileSync(auth, '{"fictional":"private-initial"}'); const authBefore = fs.statSync(auth);
  const env = { HOME: f.root, XDG_CONFIG_HOME: f.config }, frozen = { ...env };
  const profile = reserveMuseNativeHeavyProfile(f.options);
  expect(profile).not.toBeInstanceOf(Promise); expect(Object.keys(profile)).toEqual(['initialize', 'dispose']);
  expect(getActiveCliMcpArtifact(f.token)?.artifactDir).toBeNull(); expect(fs.readFileSync(f.settings, 'utf8')).toBe(JSON.stringify(original));
  await profile.initialize(() => {});
  const leased = JSON.parse(fs.readFileSync(f.settings, 'utf8'));
  expect(leased).toMatchObject(original); expect(leased.hooks.PreToolUse).toHaveLength(1); expect(leased.hooks.PreToolUse[0].hooks[0].command).toMatch(/^NEXUS_HEAVY_MUSE_LEASE_V1=1 /);
  expect(JSON.stringify(leased)).not.toMatch(/NEXUS_(?:GATE_TOKEN|HEAVY_CHANNEL_KEY|HEAVY_COMMAND_URL)|own-nexus-muse/);
  // The same cleanup the MCP exit tap, spawn failure and MCP stop already run for this token.
  cleanupCliMcpSession(f.token);
  await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(f.settings, 'utf8'))).toEqual(original));
  await vi.waitFor(() => expect(fs.readdirSync(f.ledgerRoot)).toEqual([]));
  expect(getActiveCliMcpArtifact(f.token)).toBeUndefined(); expect(env).toEqual(frozen);
  expect(fs.statSync(auth).ino).toBe(authBefore.ino); expect(fs.readFileSync(auth, 'utf8')).toBe('{"fictional":"private-initial"}');
  await profile.dispose(); expect(JSON.parse(fs.readFileSync(f.settings, 'utf8'))).toEqual(original);
});
it('does no deferred IO after cancellation and never acquires after dispose', async () => {
  const f = fixture(); fs.writeFileSync(f.settings, '{}');
  const profile = reserveMuseNativeHeavyProfile(f.options);
  await expect(profile.initialize(() => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
  expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}'); expect(fs.existsSync(f.ledgerRoot)).toBe(false);
  const second = reserveMuseNativeHeavyProfile(f.options);
  await Promise.all([second.dispose(), second.dispose()]);
  await expect(second.initialize(() => {})).rejects.toThrow('disposed'); expect(fs.readFileSync(f.settings, 'utf8')).toBe('{}');
});
const degraded = () => recentTraceContext().filter(event => event.kind === 'muse-hook-lease-degraded').at(-1);
it.each(['settings', 'muse-directory'])('F-723: a dotfile-linked %s lets the pane start without the hook, following nothing and leaving no ledger', async (linked) => {
  const f = fixture(), dotfiles = path.join(f.root, 'dotfiles'); fs.mkdirSync(dotfiles);
  const target = path.join(dotfiles, 'settings.json'); fs.writeFileSync(target, '{"model":"dotfile"}'); const before = fs.statSync(target);
  if (linked === 'settings') fs.symlinkSync(target, f.settings);
  else { fs.rmSync(path.dirname(f.settings), { recursive: true }); fs.symlinkSync(dotfiles, path.dirname(f.settings)); }
  const profile = reserveMuseNativeHeavyProfile(f.options);
  await expect(profile.initialize(() => {})).resolves.toBeUndefined();
  expect(fs.readFileSync(target, 'utf8')).toBe('{"model":"dotfile"}'); expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
  expect(fs.lstatSync(linked === 'settings' ? f.settings : path.dirname(f.settings)).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(f.ledgerRoot)).toBe(false); expect(fs.readdirSync(dotfiles)).toEqual(['settings.json']);
  expect(degraded()).toMatchObject({ adapterId: 'muse', name: 'muse_heavy_lease_symlink' }); expect(JSON.stringify(degraded())).not.toContain(f.root);
  await profile.dispose(); expect(fs.readFileSync(target, 'utf8')).toBe('{"model":"dotfile"}');
});
it.runIf(process.platform !== 'win32')('a selected FIFO degrades without blocking and stays in place; cancellation still fails closed', async () => {
  const f = fixture();
  execFileSync('/usr/bin/mkfifo', [f.settings]); const profile = reserveMuseNativeHeavyProfile(f.options);
  await expect(profile.initialize(() => {})).resolves.toBeUndefined(); expect(fs.lstatSync(f.settings).isFIFO()).toBe(true);
  expect(degraded()).toMatchObject({ name: 'muse_heavy_lease_invalid' });
  await profile.dispose(); expect(fs.lstatSync(f.settings).isFIFO()).toBe(true);
  fs.unlinkSync(f.settings); fs.symlinkSync('/dev/null', f.settings); let calls = 0;
  const revoked = reserveMuseNativeHeavyProfile(f.options);
  await expect(revoked.initialize(() => { if (++calls > 1) throw new Error('context revoked'); })).rejects.toThrow('context revoked');
});
it.runIf(process.platform !== 'win32')('the shared hook leaves operator CLIs on their original command and never double-wraps', () => {
  const f = fixture(), workspace = path.join(f.root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'Makefile'), 'all:\n\t@printf original > ran\n');
  const hook = path.join(process.cwd(), 'resources/heavy-command/muse-tool-hook.cjs'), run = (command: string) =>
    JSON.parse(execFileSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command, workdir: workspace } }), env: { PATH: '/usr/bin:/bin' } }).toString());
  const wrapped = run('make -f Makefile').hookSpecificOutput.updatedInput.command as string;
  expect(wrapped).toMatch(/^# Nexus heavy command wrapper v1\n/); expect(run(wrapped)).toEqual({}); expect(run('printf light')).toEqual({});
  // Muse clears the hook env; the tool env decides. No Nexus token/URL: the original command runs, no admission helper.
  execFileSync('/bin/sh', ['-c', wrapped], { cwd: workspace, env: { PATH: '/usr/bin:/bin', NEXUS_GATE_TOKEN: 'only-token-without-url' } });
  expect(fs.readFileSync(path.join(workspace, 'ran'), 'utf8')).toBe('original');
});

import { expect, it } from 'vitest';
import { museNativeHeavySettings } from './native-heavy-muse-profile';

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

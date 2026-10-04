import path from 'node:path';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** Main-selected resource references only; no bearer/URL/env dump is persisted. */
export function museNativeHeavySettings(original: Record<string, unknown>, node: string, directory: string): Record<string, unknown> {
  if (!path.isAbsolute(node) || !path.isAbsolute(directory)) throw new Error('muse_heavy_resource_invalid');
  const hooks = original.hooks;
  if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) throw new Error('muse_heavy_hooks_invalid');
  const existing = (hooks as Record<string, unknown> | undefined)?.PreToolUse;
  if (existing !== undefined && !Array.isArray(existing)) throw new Error('muse_heavy_hooks_invalid');
  return { ...original, hooks: { ...(hooks as Record<string, unknown> | undefined), PreToolUse: [...(existing as unknown[] | undefined ?? []), {
    matcher: 'bash', hooks: [{ type: 'command', command: `NODE_OPTIONS= NEXUS_HOOK_STATUS=1 NEXUS_HEAVY_TOOL_PREEXEC=1 ${quote(node)} ${quote(path.join(directory, 'muse-tool-hook.cjs'))}` }],
  }] } };
}

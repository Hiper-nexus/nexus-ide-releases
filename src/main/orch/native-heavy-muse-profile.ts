import path from 'node:path';
import { activateArtifact } from './cli-mcp-session-artifacts';
import { createMuseNativeHeavySettingsLease } from './native-heavy-muse-lease';
import { trace } from '../observability/main-trace';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** Errno code or our fixed lease code only: fs messages carry personal paths. */
const reasonOf = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code, message = error instanceof Error ? error.message : '';
  return typeof code === 'string' && /^E[A-Z]{2,15}$/.test(code) ? code : /^muse_heavy_[a-z_]{1,40}$/.test(message) ? message : error instanceof SyntaxError ? 'json_invalid' : 'unknown';
};
/** Main-selected resource references only; no bearer/URL/env dump is persisted. */
export function museNativeHeavySettings(original: Record<string, unknown>, node: string, directory: string): Record<string, unknown> {
  if (!path.isAbsolute(node) || !path.isAbsolute(directory)) throw new Error('muse_heavy_resource_invalid');
  const hooks = original.hooks;
  if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) throw new Error('muse_heavy_hooks_invalid');
  const existing = (hooks as Record<string, unknown> | undefined)?.PreToolUse;
  if (existing !== undefined && !Array.isArray(existing)) throw new Error('muse_heavy_hooks_invalid');
  return { ...original, hooks: { ...(hooks as Record<string, unknown> | undefined), PreToolUse: [...(existing as unknown[] | undefined ?? []), {
    matcher: 'bash', hooks: [{ type: 'command', command: `NEXUS_HEAVY_MUSE_LEASE_V1=1 NODE_OPTIONS= NEXUS_HOOK_STATUS=1 NEXUS_HEAVY_TOOL_PREEXEC=1 ${quote(node)} ${quote(path.join(directory, 'muse-tool-hook.cjs'))}` }],
  }] } };
}

export interface MuseNativeHeavyProfileOptions {
  token: string;
  home: string;
  xdgConfigHome?: string;
  artifactRoot?: string;
  node: string;
  resourceDirectory: string;
}
/**
 * Keep the selected auth/settings root in place (no env change); defer the
 * public hook lease until the Main reservation exists. The token's existing
 * physical-exit cleanup (`cleanupCliMcpSession`) releases it. Only
 * cancellation fails closed: a settings file the lease cannot own (link,
 * FIFO, invalid JSON, permissions, contention) leaves the pane to start
 * without the hook; the shell route (BASH_ENV/ZDOTDIR) stays as spawned (F-723).
 */
export function reserveMuseNativeHeavyProfile(options: MuseNativeHeavyProfileOptions): {
  initialize: (assertCurrent: () => void) => Promise<void>;
  dispose: () => Promise<void>;
} {
  if (!options.token || ![options.home, options.node, options.resourceDirectory].every(path.isAbsolute) ||
      options.xdgConfigHome && !path.isAbsolute(options.xdgConfigHome)) throw new Error('muse_heavy_resource_invalid');
  const selected = options.xdgConfigHome?.trim() || path.join(options.home, '.config');
  const hooks = museNativeHeavySettings({}, options.node, options.resourceDirectory).hooks as { PreToolUse: Record<string, unknown>[] };
  const lease = createMuseNativeHeavySettingsLease(path.join(selected, 'muse/settings.json'), hooks.PreToolUse[0], options.artifactRoot);
  let initialization: Promise<void> | undefined, disposed = false;
  const dispose = async () => { disposed = true; await initialization?.catch(() => {}); await lease.release(); };
  activateArtifact(options.token, { artifactDir: null, providerHome: null, configFiles: [], syncBack: false,
    dispose: () => { void dispose().catch(() => console.warn('[native-heavy] Muse hook lease release is pending until startup recovery')); } });
  const acquire = async (current: () => void) => {
    let cancelled = false;
    try { await lease.acquire(() => { try { current(); } catch (error) { cancelled = true; throw error; } }); }
    catch (error) { if (cancelled) throw error; trace({ kind: 'muse-hook-lease-degraded', adapterId: 'muse', name: reasonOf(error) }); }
  };
  return { initialize: current => disposed ? Promise.reject(new Error('muse_heavy_lease_disposed')) : initialization ??= acquire(current), dispose };
}

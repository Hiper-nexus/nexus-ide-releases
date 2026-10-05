/** Native AGY plugin registration. Global config contains only fixed resource
 * references; session capabilities remain inherited environment values. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { writeFileAtomicAsync } from '../util/atomic-write';

export const AGY_NATIVE_HEAVY_PLUGIN = 'nexus-native-heavy-command';
const description = 'NexusIDE native heavy-command admission (owned integration)';
const definition = { name: AGY_NATIVE_HEAVY_PLUGIN, version: '1.0.0', description, hooks: './hooks.json' };
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export type AgyPluginExec = (bin: string, args: readonly string[], options: { home: string; cwd: string }) => Promise<void>;
export interface AgyNativeHeavyPluginOptions {
  home: string; agyBin: string; node: string; resourceDirectory: string;
  signal?: AbortSignal; assertCurrent?: () => void; exec?: AgyPluginExec;
}
const defaultExec: AgyPluginExec = (bin, args, options) => new Promise((resolve, reject) => {
  execFile(bin, [...args], { cwd: options.cwd, env: { ...process.env, HOME: options.home, AGY_CLI_DISABLE_AUTO_UPDATE: '1' }, timeout: 20_000, maxBuffer: 524_288, windowsHide: true },
    error => error ? reject(new Error('agy_heavy_plugin_cli_failed')) : resolve());
});
const flights = new Map<string, { signature: string; done: Promise<void> }>();
function fail(code: string): never { throw new Error(code); }
async function directory(file: string, create = false): Promise<void> {
  if (create) await fsp.mkdir(file, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const stat = await fsp.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(file) !== file) fail('agy_heavy_plugin_directory_invalid');
}
async function existingParents(home: string): Promise<void> {
  for (const relative of ['.gemini', '.gemini/config', '.gemini/config/plugins']) {
    try { await directory(path.join(home, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
async function json(file: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 131072) fail('agy_heavy_plugin_file_invalid');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}
// The CLI may rewrite JSON key order; ownership is the exact semantic value.
function ownedDefinition(value: unknown): boolean { return isDeepStrictEqual(value, definition); }
/** AGY records enable/disable in config.json, not in the import manifest. */
async function enabled(home: string): Promise<boolean> {
  const config = await json(path.join(home, '.gemini/config/config.json')) as { plugins?: Record<string, { enabled?: unknown } | null> | null } | undefined;
  return config?.plugins?.[AGY_NATIVE_HEAVY_PLUGIN]?.enabled !== false;
}
function ownedHooks(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  const group = (value as Record<string, { PreToolUse?: unknown }>)[AGY_NATIVE_HEAVY_PLUGIN];
  if (!group || Object.keys(group).length !== 1 || !Array.isArray(group.PreToolUse) || group.PreToolUse.length !== 1) return false;
  const entry = group.PreToolUse[0] as { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> };
  const hook = entry.hooks?.[0];
  return Object.keys(entry).length === 2 && entry.matcher === 'run_command' && entry.hooks?.length === 1 && !!hook && Object.keys(hook).length === 3 &&
    hook.type === 'command' && hook.timeout === 5 && typeof hook.command === 'string' && hook.command.startsWith('if [ -x ') &&
    hook.command.includes('NEXUS_AGY_HEAVY_PLUGIN=1') && hook.command.includes('/agy-tool-hook.cjs');
}
function hooks(node: string, resources: string): Record<string, unknown> {
  const script = path.join(resources, 'agy-tool-hook.cjs');
  // The integration is permanent but the app may be removed. Missing resource
  // references must return normal AGY policy instead of blocking external AGY.
  const command = `if [ -x ${quote(node)} ] && [ -f ${quote(script)} ]; then NODE_OPTIONS= NEXUS_AGY_HEAVY_PLUGIN=1 NEXUS_HOOK_STATUS=1 ${quote(node)} ${quote(script)}; else printf '%s' '{"decision":"ask"}'; fi`;
  return { [AGY_NATIVE_HEAVY_PLUGIN]: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command, timeout: 5 }] }] } };
}
async function install(options: AgyNativeHeavyPluginOptions): Promise<void> {
  const { home, node, resourceDirectory: resources } = options;
  await directory(home); await existingParents(home); await directory(resources);
  for (const file of [node, ...['agy-tool-hook.cjs', 'catalog.cjs', 'job-launch.cjs', 'request.cjs'].map(name => path.join(resources, name))]) {
    const stat = await fsp.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('agy_heavy_plugin_resource_invalid');
  }
  const installed = path.join(home, '.gemini/config/plugins', AGY_NATIVE_HEAVY_PLUGIN);
  let exists = false;
  try { await directory(installed); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists && (!ownedDefinition(await json(path.join(installed, 'plugin.json'))) || !ownedHooks(await json(path.join(installed, 'hooks.json'))))) fail('agy_heavy_plugin_foreign_collision');
  const expected = hooks(node, resources);
  const exec = options.exec ?? defaultExec;
  if (exists) {
    if (!isDeepStrictEqual(await json(path.join(installed, 'hooks.json')), expected)) {
      await existingParents(home); await directory(installed);
      if (!ownedDefinition(await json(path.join(installed, 'plugin.json'))) || !ownedHooks(await json(path.join(installed, 'hooks.json')))) fail('agy_heavy_plugin_foreign_collision');
      await writeFileAtomicAsync(path.join(installed, 'hooks.json'), JSON.stringify(expected), 0o600, { createDirectory: false });
    }
  } else {
    await directory(path.join(home, '.nexus'), true);
    const source = path.join(home, '.nexus/agy-native-heavy-plugin');
    await directory(source, true);
    const previous = await json(path.join(source, 'plugin.json')), oldHooks = await json(path.join(source, 'hooks.json'));
    if (previous !== undefined && !ownedDefinition(previous) || oldHooks !== undefined && !ownedHooks(oldHooks)) fail('agy_heavy_plugin_foreign_collision');
    await writeFileAtomicAsync(path.join(source, 'plugin.json'), JSON.stringify(definition), 0o600, { createDirectory: false });
    await writeFileAtomicAsync(path.join(source, 'hooks.json'), JSON.stringify(expected), 0o600, { createDirectory: false });
    await exec(options.agyBin, ['plugin', 'validate', source], { home, cwd: source });
    await existingParents(home);
    try { await fsp.lstat(installed); fail('agy_heavy_plugin_foreign_collision'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await exec(options.agyBin, ['plugin', 'install', source], { home, cwd: source });
  }
  await existingParents(home); await directory(installed);
  if (!await enabled(home)) await exec(options.agyBin, ['plugin', 'enable', AGY_NATIVE_HEAVY_PLUGIN], { home, cwd: installed });
  await existingParents(home); await directory(installed);
  if (!ownedDefinition(await json(path.join(installed, 'plugin.json'))) || !isDeepStrictEqual(await json(path.join(installed, 'hooks.json')), expected)) fail('agy_heavy_plugin_registration_unproved');
  // Shape measured from AGY 1.2.16 `plugin install`; `plugin uninstall` leaves `imports: null`.
  const manifest = await json(path.join(home, '.gemini/config/import_manifest.json')) as { imports?: Array<{ name?: string; source?: string; components?: unknown }> | null } | undefined;
  if (!manifest?.imports?.some(entry => entry?.name === AGY_NATIVE_HEAVY_PLUGIN && entry.source === 'antigravity' && Array.isArray(entry.components) && entry.components.includes('hooks'))) fail('agy_heavy_plugin_registration_unproved');
  if (!await enabled(home)) fail('agy_heavy_plugin_disabled');
}
/** Each caller owns its own freshness check. A shared permanent install never
 * borrows the first pane's authority or cancellation signal for other panes. */
export async function ensureAgyNativeHeavyPlugin(options: AgyNativeHeavyPluginOptions): Promise<{ registered: boolean; reason?: string }> {
  const current = () => { if (options.signal?.aborted) fail('agy_heavy_plugin_context_changed'); options.assertCurrent?.(); };
  try {
    current();
    if (![options.home, options.agyBin, options.node, options.resourceDirectory].every(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value))) fail('agy_heavy_plugin_resource_invalid');
    if (process.platform === 'win32') fail('agy_heavy_plugin_platform_unproved');
    const signature = `${options.agyBin}\0${options.node}\0${options.resourceDirectory}`;
    for (;;) {
      let flight = flights.get(options.home);
      if (!flight) {
        flight = { signature, done: install(options) }; flights.set(options.home, flight);
        const owner = flight; void owner.done.finally(() => { if (flights.get(options.home) === owner) flights.delete(options.home); }).catch(() => {});
      }
      await flight.done; current();
      if (flight.signature === signature) return { registered: true };
    }
  } catch (error) {
    const reason = error instanceof Error && /^agy_heavy_plugin_[a-z_]+$/.test(error.message) ? error.message : 'agy_heavy_plugin_registration_failed';
    return { registered: false, reason };
  }
}

/** Native AGY plugin registration. Global config contains only fixed resource
 * references; session capabilities remain inherited environment values. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
/** Own deadline: execFile's timeout only sends SIGTERM and then waits for a
 * close that a CLI ignoring SIGTERM never delivers. The CLI's process group is
 * SIGKILLed after a grace and the call settles only on the kernel exit report. */
export function runAgyPluginCli(bin: string, args: readonly string[], options: { home: string; cwd: string }, deadlineMs = 20_000, graceMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { cwd: options.cwd, env: { ...process.env, HOME: options.home, AGY_CLI_DISABLE_AUTO_UPDATE: '1' }, stdio: 'ignore', detached: true, windowsHide: true });
    let expired = false, kill: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch { /* group already gone */ } };
    const deadline = setTimeout(() => { expired = true; signal('SIGTERM'); kill = setTimeout(() => signal('SIGKILL'), graceMs); }, deadlineMs);
    const settle = (error?: Error) => { clearTimeout(deadline); clearTimeout(kill); if (error) reject(error); else resolve(); };
    child.once('error', () => settle(new Error('agy_heavy_plugin_cli_failed')));
    child.once('exit', code => {
      if (expired) signal('SIGKILL'); // no group member outlives an expired call
      settle(expired ? new Error('agy_heavy_plugin_cli_timeout') : code === 0 ? undefined : new Error('agy_heavy_plugin_cli_failed'));
    });
  });
}
const defaultExec: AgyPluginExec = (bin, args, options) => runAgyPluginCli(bin, args, options);
const flights = new Map<string, { signature: string; done: Promise<void> }>();
function fail(code: string): never { throw new Error(code); }
async function directory(file: string, create = false): Promise<fs.Stats> {
  if (create) await fsp.mkdir(file, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const stat = await fsp.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(file) !== file) fail('agy_heavy_plugin_directory_invalid');
  return stat;
}
/** Writes and the CLI follow ancestors: re-pin the exact directory around each. */
async function sameDirectory(file: string, pin: fs.Stats): Promise<void> {
  const now = await directory(file);
  if (now.dev !== pin.dev || now.ino !== pin.ino) fail('agy_heavy_plugin_directory_changed');
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
    hook.type === 'command' && hook.timeout === 5 && typeof hook.command === 'string' &&
    hook.command.includes('NEXUS_AGY_HEAVY_PLUGIN=1') && hook.command.includes('/agy-tool-hook.cjs');
}
function hooks(node: string, resources: string): Record<string, unknown> {
  const script = path.join(resources, 'agy-tool-hook.cjs');
  // The integration is permanent but the app or Node may disappear. Outside
  // Nexus that keeps normal AGY policy; inside (gate token) it denies.
  const command = `if [ -x ${quote(node)} ] && [ -f ${quote(script)} ]; then NODE_OPTIONS= NEXUS_AGY_HEAVY_PLUGIN=1 NEXUS_HOOK_STATUS=1 ${quote(node)} ${quote(script)}; ` +
    `elif [ -n "$NEXUS_GATE_TOKEN" ]; then printf '%s' '{"decision":"deny","reason":"Nexus heavy-command admission is not configured for this session."}'; else printf '%s' '{"decision":"ask"}'; fi`;
  return { [AGY_NATIVE_HEAVY_PLUGIN]: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command, timeout: 5 }] }] } };
}
async function install(options: AgyNativeHeavyPluginOptions): Promise<void> {
  const { home, node, resourceDirectory: resources } = options;
  await directory(home); await existingParents(home); await directory(resources);
  for (const file of [node, ...['agy-tool-hook.cjs', 'catalog.cjs', 'job-launch.cjs', 'request.cjs'].map(name => path.join(resources, name))]) {
    const stat = await fsp.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('agy_heavy_plugin_resource_invalid');
  }
  const installed = path.join(home, '.gemini/config/plugins', AGY_NATIVE_HEAVY_PLUGIN);
  let pin: fs.Stats | undefined;
  try { pin = await directory(installed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const exists = pin !== undefined;
  if (exists && (!ownedDefinition(await json(path.join(installed, 'plugin.json'))) || !ownedHooks(await json(path.join(installed, 'hooks.json'))))) fail('agy_heavy_plugin_foreign_collision');
  const expected = hooks(node, resources);
  const exec = options.exec ?? defaultExec;
  if (pin) {
    if (!isDeepStrictEqual(await json(path.join(installed, 'hooks.json')), expected)) {
      await existingParents(home); await sameDirectory(installed, pin);
      if (!ownedDefinition(await json(path.join(installed, 'plugin.json'))) || !ownedHooks(await json(path.join(installed, 'hooks.json')))) fail('agy_heavy_plugin_foreign_collision');
      await sameDirectory(installed, pin);
      await writeFileAtomicAsync(path.join(installed, 'hooks.json'), JSON.stringify(expected), 0o600, { createDirectory: false });
      await existingParents(home); await sameDirectory(installed, pin);
    }
  } else {
    await directory(path.join(home, '.nexus'), true);
    const source = path.join(home, '.nexus/agy-native-heavy-plugin');
    const sourcePin = await directory(source, true);
    const previous = await json(path.join(source, 'plugin.json')), oldHooks = await json(path.join(source, 'hooks.json'));
    if (previous !== undefined && !ownedDefinition(previous) || oldHooks !== undefined && !ownedHooks(oldHooks)) fail('agy_heavy_plugin_foreign_collision');
    await sameDirectory(source, sourcePin);
    await writeFileAtomicAsync(path.join(source, 'plugin.json'), JSON.stringify(definition), 0o600, { createDirectory: false });
    await writeFileAtomicAsync(path.join(source, 'hooks.json'), JSON.stringify(expected), 0o600, { createDirectory: false });
    await sameDirectory(source, sourcePin);
    await exec(options.agyBin, ['plugin', 'validate', source], { home, cwd: source });
    await existingParents(home); await sameDirectory(source, sourcePin);
    try { await fsp.lstat(installed); fail('agy_heavy_plugin_foreign_collision'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await exec(options.agyBin, ['plugin', 'install', source], { home, cwd: source });
    await sameDirectory(source, sourcePin);
    await existingParents(home); pin = await directory(installed);
  }
  await existingParents(home); await sameDirectory(installed, pin);
  if (!ownedDefinition(await json(path.join(installed, 'plugin.json'))) || !isDeepStrictEqual(await json(path.join(installed, 'hooks.json')), expected)) fail('agy_heavy_plugin_registration_unproved');
  // Shape measured from AGY 1.2.16 `plugin install`; `plugin uninstall` leaves `imports: null`.
  const manifest = await json(path.join(home, '.gemini/config/import_manifest.json')) as { imports?: Array<{ name?: string; source?: string; components?: unknown }> | null } | undefined;
  if (!manifest?.imports?.some(entry => entry?.name === AGY_NATIVE_HEAVY_PLUGIN && entry.source === 'antigravity' && Array.isArray(entry.components) && entry.components.includes('hooks'))) fail('agy_heavy_plugin_registration_unproved');
  await existingParents(home); await sameDirectory(installed, pin);
  // The operator's disable is a choice: never re-enabled here (F-723 degrade).
  if (!await enabled(home)) fail('agy_heavy_plugin_disabled');
}
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Error('agy_heavy_plugin_context_changed'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('agy_heavy_plugin_context_changed'));
    signal.addEventListener('abort', stop, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
/** Each caller owns its own freshness check. A shared permanent install never
 * borrows the first pane's authority or cancellation signal for other panes;
 * a cancelled caller stops waiting at once while the bounded flight finishes.
 * `agy_heavy_plugin_disabled` reports the operator's disable (caller degrades). */
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
      try { await untilAborted(flight.done, options.signal); } catch (error) { current(); throw error; }
      current();
      if (flight.signature === signature) return { registered: true };
    }
  } catch (error) {
    const reason = error instanceof Error && /^agy_heavy_plugin_[a-z_]+$/.test(error.message) ? error.message : 'agy_heavy_plugin_registration_failed';
    return { registered: false, reason };
  }
}

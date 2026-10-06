import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { codexHookTrustEntries, mergeCodexHookTrustState } from '../agent-hooks/codex-hook-trust';
import type { HooksConfig } from '../agent-hooks/installer-utils';
import { writePrivateFileAtomic } from './cli-mcp-session-artifacts';
import { codexStatusHookArgs } from './hook-status-config';

/** Only main-generated hook definitions enter this trust decision. */
function generatedHooks(): HooksConfig {
  const hooks: NonNullable<HooksConfig['hooks']> = {};
  const args = codexStatusHookArgs();
  for (let i = 1; i < args.length; i += 2) {
    Object.assign(hooks, (parse(args[i]!) as HooksConfig).hooks);
  }
  return { hooks };
}

/** Preserve the prior per-event override of ambient inline hooks. */
export function codexPrivateHookArgs(): string[] {
  return Object.keys(generatedHooks().hooks!).flatMap((event) => ['-c', `hooks.${event}=[]`]);
}

/** Called only inside a new Main-owned artifact transaction, never in native HOME. */
export function installCodexPrivateHookTrust(privateHome: string, providerHome: string): void {
  let nativeHome = path.resolve(providerHome);
  try { nativeHome = fs.realpathSync(providerHome); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (fs.lstatSync(privateHome).isSymbolicLink() ||
      fs.realpathSync(privateHome) === nativeHome) {
    throw new Error('Codex hook trust requires a private provider home');
  }
  const configFile = path.join(privateHome, 'config.toml');
  const stat = fs.lstatSync(configFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex hook trust requires a private regular config');
  const hookFile = path.join(privateHome, 'hooks.json');
  try {
    fs.lstatSync(hookFile);
    throw new Error('Codex private hooks already exist');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = generatedHooks();
  writePrivateFileAtomic(hookFile, `${JSON.stringify(config)}\n`);
  const commands = new Set(Object.values(config.hooks!).flatMap((groups) =>
    groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command))));
  const entries = [...commands].flatMap((command) => codexHookTrustEntries(hookFile, config, command));
  writePrivateFileAtomic(configFile, mergeCodexHookTrustState(fs.readFileSync(configFile, 'utf8'), entries));
}

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
export function heavyCommandPreloadPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'heavy-command', 'preload.cjs') : path.join(app.getAppPath(), 'resources', 'heavy-command', 'preload.cjs');
}
/** NODE_OPTIONS parses quotes itself; no shell executes this environment value. */
export function appendHeavyCommandPreload(existing: string | undefined, file: string): string {
  return `${existing?.trim() ?? ''} --require ${JSON.stringify(file)}`.trim();
}

/** Main constructs these values from bundled resources after caller overrides. */
export function heavyCommandShellEnvironment(prepared: NodeJS.ProcessEnv, preload = heavyCommandPreloadPath()): Record<string, string> {
  const directory = path.dirname(fs.realpathSync(preload));
  const bash = path.join(directory, 'shell.bash');
  for (const name of ['shell.bash', 'shell.zsh', '.zshenv', 'request.cjs', 'classify.cjs']) {
    const file = path.join(directory, name);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw new Error('heavy_command_resource_identity_invalid');
  }
  const node = (prepared.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
    .slice(0, 256).map((entry) => path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node'))
    .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  return {
    ...(process.platform === 'darwin' ? { NEXUS_HEAVY_CURL: '/usr/bin/curl' } : {}),
    NEXUS_HEAVY_DIR: directory,
    NEXUS_HEAVY_NODE: node ? fs.realpathSync(node) : 'node',
    NEXUS_HEAVY_BASH_ENV: bash,
    BASH_ENV: bash,
    NEXUS_HEAVY_ORIG_BASH_ENV: prepared.BASH_ENV ?? '',
    NEXUS_HEAVY_ORIG_ZDOTDIR: prepared.ZDOTDIR ?? prepared.HOME ?? os.homedir(),
    ZDOTDIR: directory,
  };
}

/** Shells created for the human hand never inherit an AI execution capability. */
export function stripInheritedHeavyCommandEnvironment(env: Record<string, string>): void {
  const dir = env.NEXUS_HEAVY_DIR;
  if (dir && env.BASH_ENV === path.join(dir, 'shell.bash')) delete env.BASH_ENV;
  if (dir && env.ZDOTDIR === dir) {
    const original = env.NEXUS_HEAVY_ORIG_ZDOTDIR;
    if (original) env.ZDOTDIR = original; else delete env.ZDOTDIR;
  }
  for (const key of Object.keys(env)) if (key.startsWith('NEXUS_HEAVY_')) delete env[key];
}

/** Reassert the canonical Main-owned path at the physical spawn boundary. */
export function reassertHeavyCommandBashEnvironment(env: Record<string, string>, agentEntry?: string): void {
  if (!env.NEXUS_HEAVY_COMMAND_URL) { stripInheritedHeavyCommandEnvironment(env); return; }
  const directory = path.dirname(fs.realpathSync(heavyCommandPreloadPath()));
  const bash = path.join(directory, 'shell.bash');
  if (fs.realpathSync(bash) !== bash || !fs.statSync(bash).isFile()) throw new Error('heavy_command_resource_identity_invalid');
  if (agentEntry) { try { env.NEXUS_HEAVY_AGENT_ENTRY = fs.realpathSync(agentEntry); } catch { env.NEXUS_HEAVY_AGENT_ENTRY = agentEntry; } }
  else delete env.NEXUS_HEAVY_AGENT_ENTRY;
  env.NEXUS_HEAVY_DIR = directory;
  env.NEXUS_HEAVY_BASH_ENV = bash;
  env.BASH_ENV = bash;
  env.ZDOTDIR = directory;
}

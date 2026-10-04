import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import { DARWIN_NESTED_HEAVY_JOB_LAUNCH_SOURCE, DARWIN_PTY_SUPERVISOR_IDENTIFIER, NEXUS_APPLE_TEAM_ID } from '../pty/darwin-pty-supervisor';
let mainOwnedJobBase: string | undefined;
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
  for (const name of ['shell.bash', 'shell.zsh', '.zshenv', 'request.cjs', 'classify.cjs', 'job-launch.cjs', 'tool-hook.cjs', 'catalog.cjs', 'child-process.cjs', 'local-channel.cjs']) {
    const file = path.join(directory, name);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw new Error('heavy_command_resource_identity_invalid');
  }
  const node = (prepared.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
    .slice(0, 256).map((entry) => path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node'))
    .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  return {
    ...(process.platform === 'darwin' ? { NEXUS_HEAVY_CURL: '/usr/bin/curl', ...(mainOwnedJobBase ? { NEXUS_HEAVY_JOB_BASE: mainOwnedJobBase } : {}) } : {}),
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
  if (process.platform === 'darwin') { if (mainOwnedJobBase) env.NEXUS_HEAVY_JOB_BASE = mainOwnedJobBase; else delete env.NEXUS_HEAVY_JOB_BASE; }
  env.NEXUS_HEAVY_DIR = directory;
  env.NEXUS_HEAVY_BASH_ENV = bash;
  env.BASH_ENV = bash;
  env.ZDOTDIR = directory;
}

export async function nativeHeavyJobEnvironment(): Promise<Record<string, string>> {
  if (process.platform !== 'darwin') return {};
  const { prepareNativeHeavyJobBase } = await import('../pty/pty-manager');
  const command = await prepareNativeHeavyJobBase();
  const args = command?.args;
  const fixed: Record<number, string> = { 0: '-T', 1: '-e', 2: DARWIN_NESTED_HEAVY_JOB_LAUNCH_SOURCE, 3: '--', 4: '--helper', 6: '--identifier', 7: DARWIN_PTY_SUPERVISOR_IDENTIFIER,
    8: '--team-id', 10: '--cdhash', 12: '--timeout-seconds', 13: '0', 14: '--', 15: 'heavy-job' };
  if (!command || command.file !== '/usr/bin/perl' || !args || args.length !== 16 ||
      Object.entries(fixed).some(([index, value]) => args[Number(index)] !== value) ||
      !path.isAbsolute(args[5]) || fs.realpathSync(args[5]) !== args[5] || !fs.statSync(args[5]).isFile() ||
      args[9] !== (app.isPackaged ? NEXUS_APPLE_TEAM_ID : '-') || !/^[a-f0-9]{40}$/.test(args[11])) throw new Error('native_heavy_job_authority_unavailable');
  mainOwnedJobBase = JSON.stringify(command);
  return { NEXUS_HEAVY_JOB_BASE: mainOwnedJobBase };
}

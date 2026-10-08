import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import { DARWIN_NESTED_HEAVY_JOB_LAUNCH_SOURCE, DARWIN_PTY_SUPERVISOR_IDENTIFIER, NEXUS_APPLE_TEAM_ID } from '../pty/darwin-pty-supervisor';
import { heavyZshProfile, prepareHeavyZshProfile } from './native-heavy-zdotdir';
let mainOwnedJobBase: string | undefined;
export function heavyCommandPreloadPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'heavy-command', 'preload.cjs') : path.join(app.getAppPath(), 'resources', 'heavy-command', 'preload.cjs');
}
/** NODE_OPTIONS parses quotes itself; no shell executes this environment value. */
export function appendHeavyCommandPreload(existing: string | undefined, file: string): string {
  return `${existing?.trim() ?? ''} --require ${JSON.stringify(file)}`.trim();
}

/** Main constructs these values from bundled resources after caller overrides. */
export function heavyCommandShellEnvironment(prepared: NodeJS.ProcessEnv, preload = heavyCommandPreloadPath(), token?: string): Record<string, string> {
  const directory = path.dirname(fs.realpathSync(preload));
  const bash = path.join(directory, 'shell.bash');
  for (const name of ['shell.bash', 'shell.zsh', '.zshenv', 'request.cjs', 'classify.cjs', 'job-launch.cjs', 'tool-hook.cjs', 'catalog.cjs', 'child-process.cjs', 'local-channel.cjs']) {
    const file = path.join(directory, name);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw new Error('heavy_command_resource_identity_invalid');
  }
  const node = (prepared.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
    .slice(0, 256).map((entry) => path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node'))
    .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  const profile = process.platform === 'darwin' && token ? prepareHeavyZshProfile(token, directory) : undefined;
  return {
    ...(profile ? { NEXUS_HEAVY_ZDOTDIR: profile.directory } : {}),
    ...(process.platform === 'darwin' ? { NEXUS_HEAVY_CURL: '/usr/bin/curl', ...(mainOwnedJobBase ? { NEXUS_HEAVY_JOB_BASE: mainOwnedJobBase } : {}) } : {}),
    NEXUS_HEAVY_DIR: directory,
    NEXUS_HEAVY_NODE: node ? fs.realpathSync(node) : 'node',
    NEXUS_HEAVY_BASH_ENV: bash,
    BASH_ENV: bash,
    NEXUS_HEAVY_ORIG_BASH_ENV: prepared.BASH_ENV ?? '',
    NEXUS_HEAVY_ORIG_ZDOTDIR: prepared.ZDOTDIR ?? prepared.HOME ?? os.homedir(),
    ZDOTDIR: profile?.directory ?? directory,
  };
}

/** Shells created for the human hand never inherit an AI execution capability. */
export function stripInheritedHeavyCommandEnvironment(env: Record<string, string>): void {
  const dir = env.NEXUS_HEAVY_DIR;
  if (dir && env.BASH_ENV === path.join(dir, 'shell.bash')) delete env.BASH_ENV;
  if (dir && (env.ZDOTDIR === dir || env.ZDOTDIR === env.NEXUS_HEAVY_ZDOTDIR)) {
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
  const profile = heavyZshProfile(env.NEXUS_GATE_TOKEN);
  if (process.platform === 'darwin' && !profile) throw new Error('heavy_zsh_profile_authority_unavailable');
  if (profile) env.NEXUS_HEAVY_ZDOTDIR = profile.directory; else delete env.NEXUS_HEAVY_ZDOTDIR;
  env.ZDOTDIR = profile?.directory ?? directory;
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

let jobBaseBootFailed = false;
let jobBaseFlight: Promise<void> | undefined;
let jobBaseRetryAfter = 0;

/**
 * Boot não pode morrer porque o host de PTY demorou (Mac frio ou carregado):
 * o prazo de 15 s virava "NexusIDE não conseguiu inicializar". Sem a base, o
 * macOS recusa os comandos pesados dos agentes (falta a prova darwin-job);
 * a prova é refeita em background até dar certo, com o último intervalo
 * repetido, e cada spawn de agente tenta antes (ensureNativeHeavyJobBase).
 */
export async function proveNativeHeavyJobBaseAtBoot(
  retryDelaysMs: readonly number[] = [5_000, 15_000, 30_000, 60_000],
): Promise<boolean> {
  try {
    await nativeHeavyJobEnvironment();
    return true;
  } catch (error) {
    jobBaseBootFailed = true;
    console.warn('[native-heavy] base do job nativo indisponível no boot; comandos pesados dos agentes bloqueados até a nova prova', error);
    void (async () => {
      for (let attempt = 0; !mainOwnedJobBase; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]));
        await nativeHeavyJobEnvironment().catch(() => undefined);
      }
    })();
    return false;
  }
}

/** Boot falhou e a base ainda não foi provada: agente nascido agora fica sem comandos pesados. */
export function nativeHeavyJobBaseMissing(): boolean {
  return process.platform === 'darwin' && jobBaseBootFailed && !mainOwnedJobBase;
}

/**
 * Depois de um boot sem a base, o spawn físico de agente tenta prová-la antes
 * de montar o ambiente: o env fica fixo pela vida do agente. Num boot normal
 * devolve undefined (sem await extra no spawn). Uma falha recente não faz
 * cada spawn esperar o prazo do host.
 */
export function ensureNativeHeavyJobBase(): Promise<void> | undefined {
  if (!jobBaseBootFailed || mainOwnedJobBase || Date.now() < jobBaseRetryAfter) return undefined;
  jobBaseFlight ??= nativeHeavyJobEnvironment()
    .then(() => undefined, () => { jobBaseRetryAfter = Date.now() + 10_000; })
    .finally(() => { jobBaseFlight = undefined; });
  return jobBaseFlight;
}

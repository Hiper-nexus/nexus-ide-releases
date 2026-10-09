import path from 'node:path';
import fs from 'node:fs';
import type { ProjectExecutionScope } from '../shared/types';
import { sameProjectScope } from './orch/project-scoped-broadcast';
import { RUNTIME_GATES_ENV, RUNTIME_GATEWAY_ENV, RUNTIME_GATEWAY_NONCE_ENV, RUNTIME_PHASE_ENV } from '../shared/runtime-gates';
import { soakNonce } from '../shared/soak-smoke';
export function runtimeGateConfiguration(input: { smokeTest: boolean; packaged: boolean; userData: string; env: NodeJS.ProcessEnv }):
  { gateway: string; gatewayNonce: string; phase: 'exercise' | 'resume' } | null {
  const env = input.env, phase = env[RUNTIME_PHASE_ENV];
  if (!input.smokeTest || !input.packaged || env[RUNTIME_GATES_ENV] !== '1' || env.NEXUS_PACKAGED_SMOKE !== '1' ||
    !path.isAbsolute(input.userData) || env.NEXUS_USER_DATA_DIR !== input.userData || env.HOME !== path.join(input.userData, 'home') ||
    !soakNonce.safeParse(env[RUNTIME_GATEWAY_NONCE_ENV]).success || !['exercise', 'resume'].includes(phase ?? '')) return null;
  try {
    const url = new URL(env[RUNTIME_GATEWAY_ENV] ?? '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { gateway: url.origin, gatewayNonce: env[RUNTIME_GATEWAY_NONCE_ENV]!, phase: phase as 'exercise' | 'resume' };
  } catch { return null; }
}

let claudeConsent: { userData: string; gateway: string; gatewayNonce: string; scope: ProjectExecutionScope;
  signal: AbortSignal; isCurrent(): boolean; profiles: Array<{ path: string; dev: number; ino: number }> } | null = null;

function privateDirectory(directory: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) &&
      stat.uid === process.getuid?.() && fs.realpathSync(directory) === directory ? stat : null;
  } catch { return null; }
}

/** Main arms this only after the owned launcher's nonce/PPID handshake and private profile validation. No IPC/env entry point. */
export function armPrivateRuntimeClaudeConsent(input: { userData: string; gateway: string; gatewayNonce: string;
  scope: ProjectExecutionScope; signal: AbortSignal; isCurrent(): boolean }): () => void {
  if (claudeConsent || input.signal.aborted || !input.isCurrent()) throw new Error('private runtime consent unavailable');
  const profiles = [input.userData, path.join(input.userData, 'home')].map(directory => {
    const stat = privateDirectory(directory);
    if (!stat) throw new Error('private runtime consent profile refused');
    return { path: directory, dev: stat.dev, ino: stat.ino };
  });
  const owned = { ...input, scope: { ...input.scope }, profiles }; claudeConsent = owned;
  const release = (): void => { if (claudeConsent === owned) claudeConsent = null; input.signal.removeEventListener('abort', release); };
  input.signal.addEventListener('abort', release, { once: true });
  return release;
}

/** Only the exact synthetic key in an actual disposable Claude bootstrap receives the CLI's normal approved-key entry. */
export function privateRuntimeClaudeKeyResponse(home: string, options: { adapterId?: string; userDataPath?: string;
  coordinationScope?: ProjectExecutionScope; effectiveEnv?: Readonly<NodeJS.ProcessEnv> }): Record<string, unknown> {
  const owned = claudeConsent;
  if (!owned || owned.signal.aborted || options.adapterId !== 'claude' || options.userDataPath !== owned.userData ||
    !options.coordinationScope || !sameProjectScope(options.coordinationScope, owned.scope)) return {};
  try {
    if (!owned.isCurrent() || owned.profiles.some(profile => {
      const stat = privateDirectory(profile.path); return !stat || stat.dev !== profile.dev || stat.ino !== profile.ino;
    }) || path.dirname(home) !== path.join(owned.userData, 'home', '.nexus', 'ephemeral') || !privateDirectory(home)) return {};
    const current = runtimeGateConfiguration({ smokeTest: true, packaged: true, userData: owned.userData, env: process.env });
    const env = options.effectiveEnv, key = `rt-${owned.gatewayNonce}`;
    if (!current || current.gateway !== owned.gateway || current.gatewayNonce !== owned.gatewayNonce ||
      process.env.ANTHROPIC_API_KEY !== key || process.env.ANTHROPIC_BASE_URL !== owned.gateway ||
      env?.ANTHROPIC_API_KEY !== key || env.ANTHROPIC_BASE_URL !== owned.gateway ||
      env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== key ||
      env.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE !== undefined && env.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE !== owned.gatewayNonce) return {};
    // Claude 2.1.295's normal Yes choice stores trim().slice(-20), never the raw key.
    return { customApiKeyResponses: { approved: [key.trim().slice(-20)], rejected: [] } };
  } catch { return {}; }
}

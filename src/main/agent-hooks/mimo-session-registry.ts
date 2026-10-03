import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { getAgentSessionInfo, tapSessionExit, type OwnedAgentSessionInfo } from '../pty/pty-manager';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { providerSessionAccountIsCompatible } from '../persistence/provider-session-store';
import { validateMimoRootSession, type MimoRuntime, type MimoSessionBinding } from '../usage/mimo-scanner';
import { beginMimoMissionAuthority, forgetMimoMissionAuthority, mimoMessageMission, type MimoMissionTimeline } from './mimo-mission-authority';

interface RuntimeEntry {
  readonly runtime: MimoRuntime; readonly token: string; readonly stop: () => void;
  readonly timeline: MimoMissionTimeline; binding?: MimoSessionBinding;
  retiredAt?: number; revoked: boolean;
}
const runtimes = new Map<string, RuntimeEntry>();
const tails = new Map<string, RuntimeEntry>();
type Listener = (ptySessionId: string, binding: MimoSessionBinding | null) => void;
const listeners = new Set<Listener>();
const proofs = new WeakMap<MimoSessionBinding, RuntimeEntry>();
const usageProofs = new WeakSet<MimoSessionBinding>();
export function isMimoUsageBindingProved(binding: MimoSessionBinding): boolean { return usageProofs.has(binding); }

function sameAgentAuthority(agent: OwnedAgentSessionInfo | null | undefined, runtime: MimoRuntime): boolean {
  if (!agent || agent.adapterId !== 'mimo-code' || agent.paneId !== runtime.paneId ||
    agent.accountId !== runtime.accountId || !sameProjectScope(agent.scope, runtime.scope)) return false;
  try { return fs.realpathSync(agent.cwd) === runtime.cwd; } catch { return false; }
}
function sameLiveAuthority(ptySessionId: string, runtime: MimoRuntime): boolean {
  return sameAgentAuthority(getAgentSessionInfo(ptySessionId), runtime);
}

/** A result cannot survive runtime replacement, exit, account or scope changes. */
export function isMimoSessionBindingCurrent(binding: MimoSessionBinding): boolean {
  const entry = runtimes.get(binding.ptySessionId);
  return !!entry && proofs.get(binding) === entry && sameLiveAuthority(binding.ptySessionId, entry.runtime) &&
    binding.missionId === getAgentSessionInfo(binding.ptySessionId)?.missionId;
}

/** Per-event check after the native wait; old conversations keep their exact proof. */
export function resolveMimoUsageBinding(binding: MimoSessionBinding, createdAt: number, updatedAt: number): MimoSessionBinding | null {
  const entry = proofs.get(binding);
  if (!entry || entry.revoked || !providerSessionAccountIsCompatible(entry.runtime.scope, 'mimo-code',
    binding.providerSessionId, entry.runtime.accountId, entry.runtime.nativeOwnerKey)) return null;
  if (runtimes.get(binding.ptySessionId) === entry) {
    if (!sameLiveAuthority(binding.ptySessionId, entry.runtime) ||
      getAgentSessionInfo(binding.ptySessionId)?.missionId !== entry.timeline.transitions.at(-1)?.missionId) return null;
  } else if (tails.get(binding.ptySessionId) !== entry || runtimes.has(binding.ptySessionId) ||
    entry.retiredAt === undefined || updatedAt > entry.retiredAt || createdAt > entry.retiredAt) return null;
  const attribution = mimoMessageMission(entry.timeline, createdAt);
  const resolved = Object.freeze({ ...binding, missionId: attribution.missionId, historicalUnowned: !attribution.known });
  usageProofs.add(resolved); return resolved;
}
export function releaseMimoUsageBinding(binding: MimoSessionBinding): void {
  const entry = proofs.get(binding);
  if (entry && tails.get(binding.ptySessionId) === entry &&
    entry.binding?.providerSessionId === binding.providerSessionId) {
    entry.revoked = true; tails.delete(binding.ptySessionId);
  }
}

function notify(ptySessionId: string, binding: MimoSessionBinding | null): void {
  for (const listener of listeners) {
    try { listener(ptySessionId, binding); }
    catch (error) { console.warn('[mimo] usage observer failed', error instanceof Error ? error.message : 'unknown'); }
  }
}

export function unregisterMimoRuntime(ptySessionId: string, exitedAgent?: OwnedAgentSessionInfo | null): void {
  const entry = runtimes.get(ptySessionId);
  if (!entry) return;
  entry.revoked = listeners.size === 0 || !sameAgentAuthority(exitedAgent, entry.runtime) ||
    exitedAgent?.missionId !== entry.timeline.transitions.at(-1)?.missionId;
  if (!entry.revoked && entry.binding) { entry.retiredAt = Date.now(); tails.set(ptySessionId, entry); }
  forgetMimoMissionAuthority(ptySessionId);
  entry.stop();
  runtimes.delete(ptySessionId);
  notify(ptySessionId, null);
}

/** Called only by the Main spawn hook, never from a hook/renderer payload. */
export function registerMimoRuntime(runtime: MimoRuntime, token: string): void {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('MiMo hook requires a private session token');
  if (!runtime.accountId && !/^native:[a-f0-9]{64}$/.test(runtime.nativeOwnerKey ?? '')) {
    throw new Error('MiMo native session requires a proven credential identity');
  }
  unregisterMimoRuntime(runtime.ptySessionId);
  const previousTail = tails.get(runtime.ptySessionId);
  if (previousTail) { previousTail.revoked = true; tails.delete(runtime.ptySessionId); }
  const immutable = Object.freeze({ ...runtime, scope: Object.freeze({ ...runtime.scope }) });
  const stop = tapSessionExit((id, agent) => { if (id === runtime.ptySessionId) unregisterMimoRuntime(id, agent); });
  const missionId = sameLiveAuthority(runtime.ptySessionId, immutable)
    ? getAgentSessionInfo(runtime.ptySessionId)?.missionId : runtime.missionId;
  runtimes.set(runtime.ptySessionId, { runtime: immutable, token, stop, revoked: false,
    timeline: beginMimoMissionAuthority(runtime.ptySessionId, missionId) });
}

/** Prove the exact root and checkout before status or resume state may change. */
export async function validateMimoSessionBinding(ptySessionId: string, providerSessionId: string, token?: string): Promise<MimoSessionBinding | null> {
  const entry = runtimes.get(ptySessionId);
  if (!entry || !token || !/^[a-f0-9]{64}$/i.test(token) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(entry.token))) return null;
  if (!sameLiveAuthority(ptySessionId, entry.runtime)) return null;
  const missionId = getAgentSessionInfo(ptySessionId)?.missionId;
  try {
    if (!await validateMimoRootSession(entry.runtime, providerSessionId) ||
      runtimes.get(ptySessionId) !== entry || !sameLiveAuthority(ptySessionId, entry.runtime) ||
      getAgentSessionInfo(ptySessionId)?.missionId !== missionId ||
      !providerSessionAccountIsCompatible(entry.runtime.scope, 'mimo-code', providerSessionId,
        entry.runtime.accountId, entry.runtime.nativeOwnerKey)) return null;
  } catch { return null; }
  for (const [otherPty, other] of runtimes) {
    if (otherPty !== ptySessionId && other.binding?.providerSessionId === providerSessionId &&
      other.runtime.databasePath === entry.runtime.databasePath) return null;
  }
  const binding = Object.freeze({ ...entry.runtime, missionId, providerSessionId });
  proofs.set(binding, entry);
  return binding;
}

export function publishMimoSessionBinding(binding: MimoSessionBinding): void {
  const entry = runtimes.get(binding.ptySessionId);
  if (!entry || !isMimoSessionBindingCurrent(binding)) return;
  entry.binding = binding;
  notify(binding.ptySessionId, binding);
}

export function tapMimoSessionBindings(listener: Listener): () => void {
  listeners.add(listener);
  for (const [id, entry] of runtimes) if (entry.binding) listener(id, entry.binding);
  return () => listeners.delete(listener);
}

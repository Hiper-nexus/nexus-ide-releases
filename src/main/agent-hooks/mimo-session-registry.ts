import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { getAgentSessionInfo, tapSessionExit } from '../pty/pty-manager';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { providerSessionAccountIsCompatible } from '../persistence/provider-session-store';
import { validateMimoRootSession, type MimoRuntime, type MimoSessionBinding } from '../usage/mimo-scanner';

const runtimes = new Map<string, { runtime: MimoRuntime; token: string; stop: () => void; binding?: MimoSessionBinding }>();
type Listener = (ptySessionId: string, binding: MimoSessionBinding | null) => void;
const listeners = new Set<Listener>();
const proofs = new WeakMap<MimoSessionBinding, object>();

function sameLiveAuthority(ptySessionId: string, runtime: MimoRuntime): boolean {
  const agent = getAgentSessionInfo(ptySessionId);
  if (!agent || agent.adapterId !== 'mimo-code' || agent.paneId !== runtime.paneId ||
    agent.accountId !== runtime.accountId || !sameProjectScope(agent.scope, runtime.scope)) return false;
  try { return fs.realpathSync(agent.cwd) === runtime.cwd; } catch { return false; }
}

/** A result cannot survive runtime replacement, exit, account or scope changes. */
export function isMimoSessionBindingCurrent(binding: MimoSessionBinding): boolean {
  const entry = runtimes.get(binding.ptySessionId);
  return !!entry && proofs.get(binding) === entry && sameLiveAuthority(binding.ptySessionId, entry.runtime);
}

function notify(ptySessionId: string, binding: MimoSessionBinding | null): void {
  for (const listener of listeners) {
    try { listener(ptySessionId, binding); }
    catch (error) { console.warn('[mimo] usage observer failed', error instanceof Error ? error.message : 'unknown'); }
  }
}

export function unregisterMimoRuntime(ptySessionId: string): void {
  const entry = runtimes.get(ptySessionId);
  if (!entry) return;
  notify(ptySessionId, null);
  entry.stop();
  runtimes.delete(ptySessionId);
}

/** Called only by the Main spawn hook, never from a hook/renderer payload. */
export function registerMimoRuntime(runtime: MimoRuntime, token: string): void {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('MiMo hook requires a private session token');
  if (!runtime.accountId && !/^native:[a-f0-9]{64}$/.test(runtime.nativeOwnerKey ?? '')) {
    throw new Error('MiMo native session requires a proven credential identity');
  }
  unregisterMimoRuntime(runtime.ptySessionId);
  const immutable = Object.freeze({ ...runtime, scope: Object.freeze({ ...runtime.scope }) });
  const stop = tapSessionExit(id => { if (id === runtime.ptySessionId) unregisterMimoRuntime(id); });
  runtimes.set(runtime.ptySessionId, { runtime: immutable, token, stop });
}

/** Prove the exact root and checkout before status or resume state may change. */
export async function validateMimoSessionBinding(ptySessionId: string, providerSessionId: string, token?: string): Promise<MimoSessionBinding | null> {
  const entry = runtimes.get(ptySessionId);
  if (!entry || !token || !/^[a-f0-9]{64}$/i.test(token) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(entry.token))) return null;
  if (!sameLiveAuthority(ptySessionId, entry.runtime)) return null;
  try {
    if (!await validateMimoRootSession(entry.runtime, providerSessionId) ||
      runtimes.get(ptySessionId) !== entry || !sameLiveAuthority(ptySessionId, entry.runtime) ||
      !providerSessionAccountIsCompatible(entry.runtime.scope, 'mimo-code', providerSessionId,
        entry.runtime.accountId, entry.runtime.nativeOwnerKey)) return null;
  } catch { return null; }
  for (const [otherPty, other] of runtimes) {
    if (otherPty !== ptySessionId && other.binding?.providerSessionId === providerSessionId &&
      other.runtime.databasePath === entry.runtime.databasePath) return null;
  }
  const binding = Object.freeze({ ...entry.runtime, providerSessionId });
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

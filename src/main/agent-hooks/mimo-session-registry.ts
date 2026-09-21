import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { getAgentSessionInfo, tapSessionExit } from '../pty/pty-manager';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { providerSessionAccountIsCompatible } from '../persistence/provider-session-store';
import { validateMimoRootSession, type MimoRuntime, type MimoSessionBinding } from '../usage/mimo-scanner';

const runtimes = new Map<string, { runtime: MimoRuntime; token: string; stop: () => void; binding?: MimoSessionBinding }>();
type Listener = (ptySessionId: string, binding: MimoSessionBinding | null) => void;
const listeners = new Set<Listener>();

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
export function validateMimoSessionBinding(ptySessionId: string, providerSessionId: string, token?: string): MimoSessionBinding | null {
  const entry = runtimes.get(ptySessionId);
  if (!entry || !token || !/^[a-f0-9]{64}$/i.test(token) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(entry.token))) return null;
  const agent = getAgentSessionInfo(ptySessionId);
  if (!agent || agent.adapterId !== 'mimo-code' ||
    agent.paneId !== entry.runtime.paneId || agent.accountId !== entry.runtime.accountId ||
    !sameProjectScope(agent.scope, entry.runtime.scope)) return null;
  try {
    if (fs.realpathSync(agent.cwd) !== entry.runtime.cwd ||
      !validateMimoRootSession(entry.runtime, providerSessionId) ||
      !providerSessionAccountIsCompatible(agent.scope, agent.adapterId, providerSessionId, agent.accountId, entry.runtime.nativeOwnerKey)) return null;
  } catch { return null; }
  for (const [otherPty, other] of runtimes) {
    if (otherPty !== ptySessionId && other.binding?.providerSessionId === providerSessionId &&
      other.runtime.databasePath === entry.runtime.databasePath) return null;
  }
  return Object.freeze({ ...entry.runtime, providerSessionId });
}

export function publishMimoSessionBinding(binding: MimoSessionBinding): void {
  const entry = runtimes.get(binding.ptySessionId);
  if (!entry) return;
  entry.binding = binding;
  notify(binding.ptySessionId, binding);
}

export function tapMimoSessionBindings(listener: Listener): () => void {
  listeners.add(listener);
  for (const [id, entry] of runtimes) if (entry.binding) listener(id, entry.binding);
  return () => listeners.delete(listener);
}

let credentialRevision = 0;
const listeners = new Set<() => void>();

export function decisionCredentialRevision(): number { return credentialRevision; }
export function bumpDecisionCredentialRevision(): void {
  credentialRevision += 1;
  for (const listener of listeners) {
    try { listener(); } catch { console.warn('[decision-models] configuration listener failed'); }
  }
}

export function onDecisionConfigurationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

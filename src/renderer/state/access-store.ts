import { createContext, useEffect } from 'react';
import { create } from 'zustand';
import { DEFAULT_LICENSE, type LicenseState } from '../../shared/billing-types';

/** Carries workspace inertness through React portals without affecting recovery UI. */
export const WorkspaceInertContext = createContext(false);

interface AccessState {
  license: LicenseState;
  loading: boolean;
  failed: boolean;
  canUseApp: boolean;
  blockedReason: LicenseState['blockedReason'];
  maxAgents: number | null;
  cloudSync: boolean;
}
const initial: AccessState = {
  license: DEFAULT_LICENSE, loading: true, failed: false,
  canUseApp: false, blockedReason: DEFAULT_LICENSE.blockedReason,
  maxAgents: 0, cloudSync: false,
};
export const useAccessStore = create<AccessState>(() => initial);
let generation = 0;
let consumers = 0;
let unsubscribe: (() => void) | undefined;

/** Events invalidate pending reads, including the initial IPC snapshot. */
export async function refreshAccess(): Promise<void> {
  const request = ++generation;
  const hadSnapshot = !useAccessStore.getState().loading && !useAccessStore.getState().failed;
  // F-228: o último snapshot do Main fica na tela enquanto a leitura nova está
  // em voo (onChanged dispara a cada renovação ~5 min — a tela de bloqueio
  // piscava e roubava o foco do terminal). Só o resultado do Main muda
  // canUseApp; a primeira leitura segue fail-closed.
  useAccessStore.setState(hadSnapshot
    ? { loading: true, failed: false }
    : { loading: true, failed: false, canUseApp: false, maxAgents: 0, cloudSync: false });
  try {
    const license = await window.nexus.billing.get();
    if (request !== generation) return;
    useAccessStore.setState({
      license, loading: false, failed: false,
      canUseApp: license.canUseApp === true,
      blockedReason: license.blockedReason,
      maxAgents: license.limits?.maxAgents ?? (license.limits?.maxAgents === null ? null : 0),
      cloudSync: license.limits?.cloudSync === true,
    });
  } catch {
    if (request !== generation) return;
    // Falha de IPC não é negação do Main: o Main continua a autoridade em
    // todo spawn (requireAccess). Sem snapshot, segue fail-closed.
    useAccessStore.setState(hadSnapshot
      ? { loading: false, failed: true }
      : { ...initial, loading: false, failed: true, blockedReason: 'verification-unavailable' });
  }
}

export function connectAccessStore(): () => void {
  if (consumers++ === 0) {
    // Subscribe first: a logout/expiry racing the initial get must win.
    try {
      unsubscribe = window.nexus.billing.onChanged(() => { void refreshAccess(); });
      void refreshAccess();
    } catch {
      useAccessStore.setState({ ...initial, loading: false, failed: true, blockedReason: 'verification-unavailable' });
    }
  }
  return () => {
    if (--consumers !== 0) return;
    unsubscribe?.(); unsubscribe = undefined;
    generation++;
    useAccessStore.setState(initial);
  };
}

export function useAccess(): AccessState {
  useEffect(connectAccessStore, []);
  return useAccessStore();
}

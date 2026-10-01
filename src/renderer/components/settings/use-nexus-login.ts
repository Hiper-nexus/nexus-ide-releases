import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LOGIN_FINISH_FALLBACK,
  LOGIN_PENDING_TTL_MS,
  LOGIN_START_FALLBACK,
  LOGIN_TIMEOUT_MESSAGE,
  type LoginProvider,
} from '../../../shared/auth-login';

/**
 * Fase do login Nexus. Abrir o navegador NÃO é login feito: o resultado só
 * chega depois, pelo deep link nexus://auth. `waiting` é o estado honesto
 * entre as duas coisas; antes dele a tela fechava o painel e dizia nada.
 */
export type LoginPhase =
  | { kind: 'idle' }
  /** `resuming`: veio de "Abrir de novo" — a tela de espera não deve piscar. */
  | { kind: 'opening'; provider: LoginProvider; resuming: boolean }
  | { kind: 'waiting'; provider: LoginProvider }
  /** O navegador voltou e a conta está sendo atualizada (acesso, equipe). */
  | { kind: 'finishing' }
  | { kind: 'failed'; provider: LoginProvider | null; message: string };

export interface NexusLogin {
  phase: LoginPhase;
  /** Há uma ação em curso: os provedores ficam desabilitados. */
  busy: boolean;
  start: (provider: LoginProvider) => Promise<void>;
  reset: () => void;
}

interface Options {
  /** Roda quando o navegador devolveu e o Main confirmou a conta. */
  onCompleted?: () => void | Promise<void>;
}

const IDLE: LoginPhase = { kind: 'idle' };

/** Provedor da tela de espera, inclusive enquanto "Abrir de novo" reabre. */
export function waitingProviderOf(phase: LoginPhase): LoginProvider | null {
  if (phase.kind === 'waiting') return phase.provider;
  if (phase.kind === 'opening' && phase.resuming) return phase.provider;
  return null;
}

export function useNexusLogin({ onCompleted }: Options = {}): NexusLogin {
  const [phase, setPhase] = useState<LoginPhase>(IDLE);
  const phaseRef = useRef<LoginPhase>(IDLE);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completed = useRef(onCompleted);
  completed.current = onCompleted;

  const commit = useCallback((next: LoginPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const failWith = useCallback((provider: LoginProvider | null, message: string) => {
    clearTimer();
    commit({ kind: 'failed', provider, message });
  }, [clearTimer, commit]);

  const reset = useCallback(() => {
    sequence.current += 1;
    clearTimer();
    commit(IDLE);
  }, [clearTimer, commit]);

  const start = useCallback(async (provider: LoginProvider) => {
    const before = phaseRef.current;
    if (before.kind === 'opening' || before.kind === 'finishing') return;
    const mine = ++sequence.current;
    clearTimer();
    commit({ kind: 'opening', provider, resuming: before.kind === 'waiting' });
    try {
      const result = await window.nexus.app.authLogin(provider);
      if (mine !== sequence.current) return;
      if (!result.ok) {
        failWith(provider, result.error ?? LOGIN_START_FALLBACK);
        return;
      }
      commit({ kind: 'waiting', provider });
      timer.current = setTimeout(() => {
        timer.current = null;
        failWith(provider, LOGIN_TIMEOUT_MESSAGE);
      }, LOGIN_PENDING_TTL_MS);
    } catch {
      if (mine === sequence.current) failWith(provider, LOGIN_START_FALLBACK);
    }
  }, [clearTimer, commit, failWith]);

  useEffect(() => {
    // Bridge parcial (teste, preload antigo) não pode derrubar a montagem.
    const unsubscribe = window.nexus.app?.onAuthLoginResult?.((result) => {
      const current = phaseRef.current;
      if (!result.ok) {
        // Link velho/forjado não consumiu o login pendente: a espera segue.
        // E só quem iniciou o login mostra a falha (Ajustes e tela de acesso
        // podem estar montados juntos; a outra instância fica quieta).
        if (result.stale) return;
        if (current.kind !== 'waiting' && current.kind !== 'opening') return;
        sequence.current += 1;
        failWith(current.provider, result.error ?? LOGIN_START_FALLBACK);
        return;
      }
      const provider = current.kind === 'waiting' || current.kind === 'opening' ? current.provider : null;
      const mine = ++sequence.current;
      clearTimer();
      commit({ kind: 'finishing' });
      void Promise.resolve()
        .then(() => completed.current?.())
        .then(
          () => { if (mine === sequence.current) commit(IDLE); },
          () => { if (mine === sequence.current) failWith(provider, LOGIN_FINISH_FALLBACK); },
        );
    });
    return () => {
      unsubscribe?.();
      // Um authLogin ainda em voo não pode armar o prazo depois de desmontar.
      sequence.current += 1;
      clearTimer();
    };
  }, [clearTimer, commit, failWith]);

  return { phase, busy: phase.kind === 'opening' || phase.kind === 'finishing', start, reset };
}

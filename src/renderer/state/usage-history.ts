import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageHistory } from '../../shared/usage-types';

export type UsageHistoryStatus = 'unavailable' | 'loading' | 'ready' | 'error';

export interface UsageHistoryState {
  readonly status: UsageHistoryStatus;
  readonly history: UsageHistory | null;
  /** Nova leitura manual (botão "Tentar de novo"). */
  readonly reload: () => void;
}

/** Mesma cadência do perfil: rajada de telemetria vira uma leitura só. */
const REFRESH_THROTTLE_MS = 1500;

/**
 * Rollup diário de consumo (WEB-12). Autoridade: `usage:history` no main, o
 * mesmo tracker de vida útil de `useLifetimeUsage`. Sem a ponte (testes,
 * embeds) o estado é `unavailable` e a tela simplesmente não mostra o gráfico.
 */
export function useUsageHistory(enabled = true): UsageHistoryState {
  const [status, setStatus] = useState<UsageHistoryStatus>(() =>
    window.nexus?.usage?.history ? 'loading' : 'unavailable',
  );
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [nonce, setNonce] = useState(0);
  const hasDataRef = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const api = window.nexus?.usage;
    const readHistory = api?.history;
    if (!api || !readHistory) {
      setStatus('unavailable');
      return undefined;
    }
    let cancelled = false;
    let lastFetch = 0;
    const refresh = (force = false) => {
      const now = Date.now();
      if (!force && now - lastFetch < REFRESH_THROTTLE_MS) return;
      lastFetch = now;
      if (!hasDataRef.current) setStatus('loading');
      void readHistory()
        .then((next) => {
          if (cancelled) return;
          hasDataRef.current = true;
          setHistory(next);
          setStatus('ready');
        })
        .catch(() => {
          // Leitura que falha depois de já ter dados não apaga o gráfico.
          if (!cancelled && !hasDataRef.current) setStatus('error');
        });
    };
    refresh(true);
    const off = api.onChanged?.(() => refresh()) ?? (() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { status, history, reload };
}

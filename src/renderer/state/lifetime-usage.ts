import { useEffect, useState } from 'react';
import type { PetLifetimeStats } from '../../shared/pet-types';

/**
 * Totais de VIDA ÚTIL de consumo (todos os escopos/projetos): tokens
 * torrados, equivalente USD de API pública, panes e turnos. Autoridade:
 * `usage:lifetime` no main (tracker que acumula os snapshots por escopo).
 *
 * `enabled=false` suspende fetch e assinatura (ex.: modal fechado).
 */
export function useLifetimeUsage(enabled = true): PetLifetimeStats | null {
  const [stats, setStats] = useState<PetLifetimeStats | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const api = window.nexus?.usage;
    if (!api?.lifetime) return undefined;
    let cancelled = false;
    let lastFetch = 0;
    const refresh = () => {
      const now = Date.now();
      if (now - lastFetch < 1500) return;
      lastFetch = now;
      void api
        .lifetime()
        .then((s) => {
          if (!cancelled) setStats(s);
        })
        .catch(() => {});
    };
    lastFetch = 0;
    refresh();
    const off = api.onChanged(refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);

  return stats;
}

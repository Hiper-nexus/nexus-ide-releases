import {
  JEV_UNAVAILABLE_LABEL,
  type SpawnRouteInfo,
} from '../../shared/spawn-route';
import { useToastStore } from '../state/toast-store';

type Push = ReturnType<typeof useToastStore.getState>['push'];

/** Motivos já avisados nesta execução do app (um toast por motivo). */
const noticed = new Set<string>();

/**
 * Pane aberto pela heurística porque o Jev não respondeu: avisa UMA vez por
 * motivo. Sem chave/desligado aponta para onde resolver.
 */
export function noticeJevRouteFallback(
  route: SpawnRouteInfo | undefined,
  push: Push = useToastStore.getState().push,
): boolean {
  const reason = route?.jevUnavailable;
  if (!reason || noticed.has(reason)) return false;
  noticed.add(reason);
  const fix =
    reason === 'no-key' || reason === 'disabled'
      ? ' Ative em Configurações › Chaves de API › TypeSafe (Jev).'
      : '';
  push('warn', `Jev não respondeu (${JEV_UNAVAILABLE_LABEL[reason]})`, {
    detail: `O pane foi aberto pela heurística.${fix}`,
    dedupeKey: `jev-route-fallback:${reason}`,
  });
  return true;
}

export function resetJevRouteNoticesForTests(): void {
  noticed.clear();
}

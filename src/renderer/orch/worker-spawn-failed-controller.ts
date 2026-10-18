import { useEffect } from 'react';
import type { PaneWorkerSpawnFailedEvent } from '../../shared/types';
import { useToastStore } from '../state/toast-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

export interface WorkerSpawnFailedNotice {
  readonly kind: 'warn' | 'error';
  readonly title: string;
  readonly detail: string;
}

/**
 * Texto do aviso. Sucessor presente = o pane EXISTE em outro CLI (aviso);
 * ausente = o CLI pedido não subiu (erro). Puro para poder ser testado sem
 * montar a árvore React.
 */
export function workerSpawnFailedNotice(
  event: PaneWorkerSpawnFailedEvent,
): WorkerSpawnFailedNotice {
  const successor =
    event.successorName?.trim() || event.successorCli?.trim() || '';
  if (!successor) {
    return {
      kind: 'error',
      title: event.title ?? `${event.deadAdapterId} não subiu`,
      detail: event.message,
    };
  }
  return {
    kind: 'warn',
    title: event.title ?? `Assento remapeado: ${event.deadAdapterId}`,
    detail:
      `${event.deadAdapterId} não sentou — ${event.message}. ` +
      `O pane abriu com ${successor}.`,
  };
}

/**
 * O CLI pedido NÃO sentou. Duas origens, um mesmo aviso:
 *
 * - morreu no boot (o pane nem chegou a existir);
 * - o assento não tinha credencial utilizável e a cadeia de sucessão sentou
 *   outro CLI — o pane está aberto, só não com quem foi pedido.
 *
 * O segundo caso era completamente mudo (`console.warn` no main). O operador
 * pedia kimi, via claude na tela e concluía que o pedido tinha sido ignorado
 * (campo 10/09). Aviso, não bloqueio: o pane está vivo e utilizável, e a ação
 * leva direto ao lugar onde a credencial se resolve.
 */
export function useWorkerSpawnFailedController(): void {
  useEffect(() => {
    return window.nexus.orch.onWorkerSpawnFailed((event) => {
      const notice = workerSpawnFailedNotice(event);
      const openProviders = () =>
        useProductNavigationStore.getState().openSettings('providers');
      useToastStore.getState().push(notice.kind, notice.title, {
        detail: notice.detail,
        action: { label: 'Abrir Providers', onClick: openProviders },
      });
    });
  }, []);
}

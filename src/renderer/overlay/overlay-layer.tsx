import { WorkspaceInertContext } from '../state/access-store';
import { useContext, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * H6 — Overlay como camada separada.
 *
 * O problema estrutural: um overlay renderizado DENTRO da árvore do grid
 * herda três coisas do pai e não tem como recusá-las:
 *
 *   1. contexto de empilhamento — `z-index: 1300` dentro de um pai com
 *      `z-index: 55` continua atrás de qualquer irmão do pai com 56. É o caso
 *      real do UpdateModal e do painel de notificações, ambos montados dentro
 *      da `.workspace-bar` (`--z-app-chrome: 55`): a ladder nomeada existia,
 *      mas era lida dentro de uma caixa que já tinha perdido a disputa.
 *   2. `overflow` — a zona de status da barra recorta popover ancorado. O
 *      código contornava com `position: fixed` + coordenadas medidas à mão.
 *   3. `transform`/`filter` — qualquer ancestral com transform vira bloco
 *      contentor de `position: fixed`, e o overlay "fixo" passa a seguir o
 *      pai. Hoje não há; a camada garante que nunca haverá.
 *
 * A camada resolve os três de uma vez: um nó irmão de `#root`, direto no
 * `<body>`, com `--z-overlay-root` e `isolation: isolate`. Fora da árvore do
 * grid não há o que herdar; dentro da camada a ladder nomeada
 * (`--z-toast` … `--z-confirm`) volta a valer, agora entre iguais.
 *
 * O portal do React preserva a árvore REACT: context, eventos que borbulham e
 * `stopPropagation` continuam funcionando como antes. Só o DOM muda de lugar.
 * Tema, plataforma e modo pixel vivem em `<html>` (`ui-theme.ts`), então todo
 * seletor `[data-theme-pixel='on'] .x` continua alcançando a camada.
 */

const OVERLAY_ROOT_ID = 'nexus-overlay-root';

let cachedRoot: HTMLElement | null = null;

/**
 * Cria (ou recupera) o nó de portal. Idempotente: várias instâncias de
 * `OverlayLayer` compartilham a mesma raiz, e o nó sobrevive a hot-reload
 * porque é procurado por id antes de ser criado.
 */
export function getOverlayRoot(): HTMLElement {
  if (cachedRoot && cachedRoot.isConnected) return cachedRoot;

  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing instanceof HTMLElement) {
    cachedRoot = existing;
    return existing;
  }

  const node = document.createElement('div');
  node.id = OVERLAY_ROOT_ID;
  node.className = 'overlay-layer';
  document.body.appendChild(node);
  cachedRoot = node;
  return node;
}

/** Só para teste: esquece a raiz memoizada entre DOMs. */
export function resetOverlayRootForTest(): void {
  cachedRoot = null;
}

const EMPTY_SUBSCRIBE = () => () => {};

/**
 * Envelope de portal. Uso: `<OverlayLayer><MeuModal /></OverlayLayer>`.
 *
 * Renderizar com `children` nulo não custa nada — o portal fica vazio e a
 * camada não tem área de acerto (`width/height: 0` em overlay-layer.css), de
 * modo que envolver um overlay fechado não bloqueia clique nenhum.
 */
export function OverlayLayer({ children }: { children?: ReactNode }) {
  const workspaceBlocked = useContext(WorkspaceInertContext);
  // useSyncExternalStore com subscribe vazio: no servidor/SSR devolve null e
  // não toca no document; no cliente devolve a raiz já criada. Evita o
  // useEffect de duas passadas que faria o overlay piscar um frame atrás.
  const root = useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    getOverlayRoot,
    () => null,
  );
  if (!root) return null;
  return createPortal(<div style={{ display: workspaceBlocked ? 'none' : 'contents' }} ref={node => { node?.toggleAttribute('inert', workspaceBlocked); }}>{children}</div>, root);
}

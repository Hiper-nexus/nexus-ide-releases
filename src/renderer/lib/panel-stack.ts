import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Pilha de empilhamento dos painéis flutuantes do workspace (Arquivos, Painel,
 * Equipe, Memória, Configs, Diff).
 *
 * Cada painel tinha um z-index FIXO por CSS: abrir um painel de tier menor com
 * um maior já na frente fazia o novo nascer invisível atrás dele. Janela
 * flutuante é pilha: o último aberto ou clicado vem para a frente.
 *
 * A faixa BASE_Z..BASE_Z+n vive acima dos tiers estáticos dos painéis (≤34)
 * e abaixo de --z-soft-overlay (45), --z-app-chrome (55) e dos modais hard
 * (1000+): wizard, chrome e diálogos continuam cobrindo tudo. Como a pilha
 * renumera compacta (índice na ordem), o teto efetivo é BASE_Z + nº de
 * painéis abertos — nunca invade os tiers superiores.
 */
const BASE_Z = 35;

const order: string[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Índice do painel na pilha → z-index; undefined = fora da pilha (fechado). */
export function panelZFor(id: string): number | undefined {
  const at = order.indexOf(id);
  return at === -1 ? undefined : BASE_Z + at;
}

/** Sobe (ou insere) o painel no topo da pilha. */
export function raisePanel(id: string): void {
  const at = order.indexOf(id);
  if (at === order.length - 1 && at !== -1) return;
  if (at !== -1) order.splice(at, 1);
  order.push(id);
  emit();
}

/** Remove o painel da pilha (fechado/desmontado). */
export function releasePanel(id: string): void {
  const at = order.indexOf(id);
  if (at === -1) return;
  order.splice(at, 1);
  emit();
}

export function resetPanelStackForTest(): void {
  order.length = 0;
  emit();
}

/**
 * z-index dinâmico de um painel flutuante. Abrir sobe ao topo; qualquer
 * mousedown dentro do painel também (aplicar via onMouseDownCapture na raiz).
 */
export function usePanelZ(
  id: string,
  open: boolean,
): { zIndex: number | undefined; bringToFront: () => void } {
  const zIndex = useSyncExternalStore(subscribe, () => panelZFor(id));
  const bringToFront = useCallback(() => raisePanel(id), [id]);
  useEffect(() => {
    if (open) raisePanel(id);
    else releasePanel(id);
  }, [id, open]);
  useEffect(() => () => releasePanel(id), [id]);
  return { zIndex, bringToFront };
}

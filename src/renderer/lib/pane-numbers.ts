import {
  createPaneNumberRegistry,
  describePaneNumbers,
  paneNumberSeedsOf,
  type PaneNumberEntry,
} from '../../shared/pane-number';
import type { PaneModel } from '../../shared/types';

/**
 * Registro ÚNICO de números de pane do renderer (escopo: o workspace aberto).
 *
 * Um único ponto de estrangulamento de propósito: dois numeradores dariam dois
 * panes com o mesmo número, que é exatamente o modo de falha que a numeração
 * existe para impedir ("digo pane 5 e acerto outro").
 *
 * NOME, não POSIÇÃO. O número é identidade durável — o operador lê no header,
 * dita, e escreve no relato de bug. Ele NÃO é o lugar do pane na tela.
 *
 * Namespace separado do ⌘1-9 de propósito. `App.tsx` liga ⌘1-9 ao ÍNDICE do
 * pane em `listPanes(root)` (via `paneSlotOf`), que muda quando um pane abre ou
 * fecha; o número aqui não muda. O `PaneToolbar` mostra os dois chips lado a
 * lado justamente porque respondem a perguntas diferentes: "como eu chamo este
 * pane" (número) e "que tecla foca este pane agora" (slot).
 *
 * ESCOPO POR WORKSPACE: `hydratePaneNumbers` re-semeia o registro a cada
 * hidratação/troca de workspace, então os números de dois workspaces nunca se
 * misturam e cada workspace recomeça em 1.
 */
const registry = createPaneNumberRegistry();

/** Número durável do pane; atribui na primeira vez que o pane é visto. */
export function claimPaneNumber(paneId: string): number {
  return registry.assign(paneId);
}

export function paneNumberOf(paneId: string): number | null {
  return registry.numberOf(paneId);
}

/** "pane 248", "#248", "248", "pane sete" ou o id cru → id interno. */
export function resolvePaneRef(ref: string): string | null {
  return registry.resolveRef(ref);
}

/** Libera o pane. O número volta para a fila (o próximo pane pega o menor livre). */
export function releasePaneNumber(paneId: string): void {
  registry.release(paneId);
}

/** Panes vivos em ordem de número — a lista que uma recusa precisa nomear. */
export function livePaneNumbers(): readonly PaneNumberEntry[] {
  return registry.list();
}

/** "1, 2, 5" — os números válidos agora, para a mensagem de erro. */
export function validPaneNumbersLabel(): string {
  return describePaneNumbers(registry.list());
}

/**
 * Re-semeia o registro a partir da árvore recém-hidratada. É o que faz o
 * número SOBREVIVER AO RESTART e não vazar entre workspaces.
 *
 * Devolve o mapa id→número; quem hidrata grava de volta na árvore os números
 * dos panes que chegaram sem um (layout gravado por versão anterior à
 * numeração), para que a UI e o espelho do Main mostrem o mesmo valor.
 */
export function hydratePaneNumbers(
  panes: readonly PaneModel[],
): ReadonlyMap<string, number> {
  return registry.reset(paneNumberSeedsOf(panes));
}

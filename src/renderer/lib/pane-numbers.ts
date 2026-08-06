import { createPaneNumberRegistry } from '../../shared/pane-number';

/**
 * Registro ÚNICO de nomes de pane do renderer (escopo: este workspace).
 *
 * Um único ponto de estrangulamento de propósito: dois numeradores dariam dois
 * panes com o mesmo nome, que é exatamente o modo de falha que a numeração
 * existe para impedir ("digo pane 5 e acerto outro").
 *
 * NOME, não POSIÇÃO. O número é identidade durável — o operador lê no header,
 * dita, e escreve no relato de bug. Ele NÃO é o lugar do pane na tela: panes
 * abrem e fecham, e um nome que muda de dono não serve para nada disso.
 *
 * Nota de escopo (medida, não suposta): o Nexus não tem atalho numérico de pane
 * — `App.tsx` liga apenas `,`, `/`, `mod+D` e `mod+W`. Portanto não existe um
 * "slot posicional" concorrente a distinguir aqui; se um ⌘1-9 for adicionado
 * depois, ele terá de declarar qual das duas coisas endereça.
 */
const registry = createPaneNumberRegistry();

/** Nome durável do pane; atribui na primeira vez que o pane é visto. */
export function claimPaneNumber(paneId: string): number {
  return registry.assign(paneId);
}

export function paneNumberOf(paneId: string): number | null {
  return registry.numberOf(paneId);
}

/** "pane 248", "#248", "248" ou o id cru → id interno. */
export function resolvePaneRef(ref: string): string | null {
  return registry.resolveRef(ref);
}

/** Libera o pane. O nome NÃO volta para a fila — nunca é reusado. */
export function releasePaneNumber(paneId: string): void {
  registry.release(paneId);
}

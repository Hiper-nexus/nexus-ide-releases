/**
 * Número humano de pane — o punho que dá para ditar, decorar e informar.
 *
 * O id interno (`pane-mshi87ry-4`) é chave durável e continua sendo a
 * identidade: nada na camada de dados troca de chave primária. O que este
 * módulo acrescenta é um INTEIRO CURTO por pane, para "vai no pane 2" ser uma
 * frase que aponta para algo exato — hoje é impossível ditar ou memorizar um id.
 *
 * REGRA DE REUSO: **monotônico e sem reuso** dentro do escopo. O pior modo de
 * falha aqui é dizer "pane 5" e acertar outro pane; fechar o 5 e entregar o
 * número a um pane novo criaria exatamente isso. Números fechados ficam vagos
 * para sempre — barato, e a única política que preserva a frase falada.
 *
 * ESCOPO: um registro por workspace. O mesmo número nunca aponta para dois
 * panes ao mesmo tempo dentro do escopo que o usuário está vendo.
 */

export interface PaneNumberEntry {
  readonly number: number;
  readonly paneId: string;
}

export interface PaneNumberRegistry {
  /** Atribui (ou devolve) o número deste pane. Idempotente. */
  assign(paneId: string): number;
  /** Número de um pane vivo, ou `null` se fechado/desconhecido. */
  numberOf(paneId: string): number | null;
  /** Id do pane com este número, ou `null`. */
  resolve(paneNumber: number): string | null;
  /**
   * Resolve uma referência como o humano a escreve ou dita: `2`, `#2`,
   * `pane 2`, `pane-2` — ou o próprio id interno, que passa direto.
   */
  resolveRef(ref: string): string | null;
  /** Panes vivos em ordem de número (UI, ⌘1-9). */
  list(): readonly PaneNumberEntry[];
  /** Fecha o pane. O número NÃO volta para a fila. */
  release(paneId: string): void;
}

/** `2` | `#2` | `pane 2` | `pane-2` | `PANE  2` → 2 */
const SPOKEN_REF = /^\s*(?:#|pane[\s-]*)?(\d{1,6})\s*$/i;

export function createPaneNumberRegistry(): PaneNumberRegistry {
  const numberByPane = new Map<string, number>();
  const paneByNumber = new Map<number, string>();
  let next = 1;

  return {
    assign(paneId: string): number {
      const existing = numberByPane.get(paneId);
      if (existing !== undefined) return existing;
      const assigned = next;
      next += 1;
      numberByPane.set(paneId, assigned);
      paneByNumber.set(assigned, paneId);
      return assigned;
    },
    numberOf(paneId: string): number | null {
      return numberByPane.get(paneId) ?? null;
    },
    resolve(paneNumber: number): string | null {
      return paneByNumber.get(paneNumber) ?? null;
    },
    resolveRef(ref: string): string | null {
      const spoken = SPOKEN_REF.exec(ref);
      if (spoken?.[1]) {
        return paneByNumber.get(Number.parseInt(spoken[1], 10)) ?? null;
      }
      // Id interno cru continua válido: o número é adição, não substituição.
      const direct = ref.trim();
      return numberByPane.has(direct) ? direct : null;
    },
    list(): readonly PaneNumberEntry[] {
      return Object.freeze(
        [...numberByPane.entries()]
          .map(([paneId, number]) => Object.freeze({ number, paneId }))
          .sort((a, b) => a.number - b.number),
      );
    },
    release(paneId: string): void {
      const assigned = numberByPane.get(paneId);
      if (assigned === undefined) return;
      numberByPane.delete(paneId);
      // `paneByNumber` também perde a entrada: número fechado não resolve mais
      // para nada, e nunca é reatribuído (o contador só sobe).
      paneByNumber.delete(assigned);
    },
  };
}

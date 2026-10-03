/**
 * `indexOf` com memória para buscas cuja posição de partida só cresce
 * (F-764 C.3): guarda a próxima ocorrência de cada agulha e só procura de
 * novo quando a partida passa dela. Cada agulha percorre o texto no máximo
 * uma vez — os laços de OSC que refaziam `indexOf` até o fim do texto a cada
 * sequência viram lineares sem mudar o resultado.
 */
export class MonotoneSearch {
  readonly #found = new Map<string, { readonly from: number; readonly index: number }>();

  constructor(private readonly text: string) {}

  find(needle: string, from: number): number {
    const cached = this.#found.get(needle);
    // Válido só para partidas que não recuam: a ocorrência guardada é a
    // primeira a partir de `cached.from`, logo também a partir de `from`.
    if (
      cached !== undefined &&
      from >= cached.from &&
      (cached.index === -1 || cached.index >= from)
    ) {
      return cached.index;
    }
    const index = this.text.indexOf(needle, from);
    this.#found.set(needle, { from, index });
    return index;
  }
}

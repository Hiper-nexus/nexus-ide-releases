/**
 * Número humano de pane — o punho que dá para ditar, decorar e informar.
 *
 * O id interno (`pane-mshi87ry-4`) é chave durável e continua sendo a
 * identidade: nada na camada de dados troca de chave primária. O que este
 * módulo acrescenta é um INTEIRO CURTO por pane, para "vai no pane 2" ser uma
 * frase que aponta para algo exato — hoje é impossível ditar ou memorizar um id.
 *
 * O número é ADIÇÃO, nunca substituição. Todo lugar que aceita o número aceita
 * o id igual, e o protocolo (MCP, IPC, layout persistido, binding de sessão
 * PTY) continua carregando o id. Um número que virasse chave primária em
 * qualquer camada seria regressão, não feature.
 *
 * REGRA DE REUSO: **menor número livre**. Enquanto o pane vive, o número é
 * dele e de mais ninguém — dois panes vivos com o mesmo número é o único modo
 * de falha inaceitável ("digo pane 5 e acerto outro"). Quando o pane fecha, o
 * número volta para a fila e o próximo pane recebe o MENOR livre. A alternativa
 * (monotônico, nunca reusar) mantém a frase falada estável por mais tempo, mas
 * empurra o operador para "pane 312" depois de um dia de trabalho — e o valor
 * inteiro deste recurso é o número ser curto o bastante para caber na fala.
 * Quem cita um número de pane fechado recebe recusa nomeada, não um alvo errado.
 *
 * ESCOPO: **por workspace**. Um registro por workspace aberto, porque o
 * operador fala sobre "os panes na tela". Ao trocar de workspace o registro é
 * re-semeado (`reset`) a partir dos panes daquele workspace, então os números
 * de dois workspaces nunca se misturam e cada um recomeça em 1.
 */

import type { PaneModel } from './surface-payload-types';

export interface PaneNumberEntry {
  readonly number: number;
  readonly paneId: string;
}

/** O que `reset` precisa saber de um pane restaurado: id e número persistido. */
export interface PaneNumberSeed {
  readonly id: string;
  readonly paneNumber?: number;
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
   * `pane 2`, `pane-2`, `no pane 2`, `pane dois` — ou o próprio id interno,
   * que passa direto.
   */
  resolveRef(ref: string): string | null;
  /** Panes vivos em ordem de número. */
  list(): readonly PaneNumberEntry[];
  /** Fecha o pane. O número volta para a fila (menor livre). */
  release(paneId: string): void;
  /**
   * Re-semeia o registro inteiro a partir dos panes de um workspace.
   *
   * É o que faz o número SOBREVIVER AO RESTART: o layout persistido guarda
   * `paneNumber` em cada pane, e a hidratação devolve exatamente aquele número
   * ao mesmo pane. Panes sem número (layout gravado por versão anterior)
   * recebem o menor livre aqui — workspace antigo abre normal, nunca quebrado.
   *
   * Devolve o mapa id→número já resolvido, para quem hidrata gravar de volta
   * na árvore os números recém-atribuídos.
   */
  reset(panes: readonly PaneNumberSeed[]): ReadonlyMap<string, number>;
}

/**
 * Palavras-número em pt-BR (e as poucas em inglês que aparecem em ditado
 * misto). O teto é folgado de propósito: o limite real de panes vivos é bem
 * menor, e uma palavra fora da tabela apenas cai para a resolução por título.
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  um: 1, uma: 1, one: 1,
  dois: 2, duas: 2, two: 2,
  tres: 3, three: 3,
  quatro: 4, four: 4,
  cinco: 5, five: 5,
  seis: 6, six: 6,
  sete: 7, seven: 7,
  oito: 8, eight: 8,
  nove: 9, nine: 9,
  dez: 10, ten: 10,
  onze: 11, eleven: 11,
  doze: 12, twelve: 12,
  treze: 13, thirteen: 13,
  quatorze: 14, catorze: 14, fourteen: 14,
  quinze: 15, fifteen: 15,
  dezesseis: 16, sixteen: 16,
  dezessete: 17, seventeen: 17,
  dezoito: 18, eighteen: 18,
  dezenove: 19, nineteen: 19,
  vinte: 20, twenty: 20,
});

/**
 * `2` | `#2` | `pane 2` | `pane-2` | `no pane 2` | `painel 2` | `pane sete`
 *
 * Preposições e artigos soltos na frente são descartados porque o ditado real
 * é "manda no pane 7", não "pane 7". O corpo capturado é dígito OU palavra —
 * a palavra existe porque a fala do operador é a razão de o número existir.
 */
const SPOKEN_REF =
  /^\s*(?:(?:no|na|em|de|do|da|ao|para|pro|pra|o|a|os|as|to|the|in|on)\s+)*(?:#\s*|pane[\s-]*|painel[\s-]*|aba[\s-]*)?([\p{L}\d]{1,16})\s*$/iu;

/**
 * Lê uma referência falada/escrita e devolve o INTEIRO, sem consultar registro
 * nenhum. Pura de propósito: o processo Main resolve número→pane contra o seu
 * próprio espelho de panes, sem precisar do registro do renderer.
 *
 * Devolve `null` quando a referência não é um número — inclusive para um id
 * interno cru, que quem chama trata no seu próprio caminho.
 */
export function parsePaneNumberRef(ref: string): number | null {
  if (typeof ref !== 'string') return null;
  const match = SPOKEN_REF.exec(ref);
  const body = match?.[1];
  if (!body) return null;
  if (/^\d+$/.test(body)) {
    const parsed = Number.parseInt(body, 10);
    return parsed > 0 ? parsed : null;
  }
  // Palavra: normaliza acento ("três" → "tres") antes de consultar a tabela.
  const word = body
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return NUMBER_WORDS[word] ?? null;
}

/** Frase de recusa que NOMEIA os números válidos — nunca um alvo adivinhado. */
export function describePaneNumbers(
  entries: readonly PaneNumberEntry[],
): string {
  if (entries.length === 0) return 'nenhum pane aberto';
  return entries.map((entry) => entry.number).join(', ');
}

/** O menor inteiro ≥1 ainda não ocupado. */
function smallestFree(used: ReadonlySet<number>): number {
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

export function createPaneNumberRegistry(): PaneNumberRegistry {
  const numberByPane = new Map<string, number>();
  const paneByNumber = new Map<number, string>();

  function claim(paneId: string): number {
    const existing = numberByPane.get(paneId);
    if (existing !== undefined) return existing;
    const assigned = smallestFree(new Set(paneByNumber.keys()));
    numberByPane.set(paneId, assigned);
    paneByNumber.set(assigned, paneId);
    return assigned;
  }

  return {
    assign: claim,
    numberOf(paneId: string): number | null {
      return numberByPane.get(paneId) ?? null;
    },
    resolve(paneNumber: number): string | null {
      return paneByNumber.get(paneNumber) ?? null;
    },
    resolveRef(ref: string): string | null {
      // ORDEM É LOAD-BEARING: o id cru é testado ANTES do número.
      //
      // O id nasce de `randomUUID().slice(0,8)`, então ~2% deles saem só com
      // dígitos (`pane-12345678`) e o parser de número os leria como "pane
      // 12345678". Identidade sempre vence: quem manda o id recebe o pane
      // daquele id, e o número só é consultado quando a referência não é um
      // pane conhecido. O número é adição, nunca substituição.
      const direct = typeof ref === 'string' ? ref.trim() : '';
      if (numberByPane.has(direct)) return direct;
      const spoken = parsePaneNumberRef(ref);
      return spoken === null ? null : (paneByNumber.get(spoken) ?? null);
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
      // O número volta para a fila: `smallestFree` o reoferece ao próximo pane.
      paneByNumber.delete(assigned);
    },
    reset(panes: readonly PaneNumberSeed[]): ReadonlyMap<string, number> {
      numberByPane.clear();
      paneByNumber.clear();
      // Duas passadas, e a ordem importa: primeiro honra TODO número
      // persistido, para que a hidratação não realoque um pane que o operador
      // já conhece pelo número; só depois preenche os que chegaram sem.
      for (const pane of panes) {
        const persisted = pane.paneNumber;
        if (
          typeof persisted !== 'number' ||
          !Number.isInteger(persisted) ||
          persisted < 1 ||
          paneByNumber.has(persisted) ||
          numberByPane.has(pane.id)
        ) {
          continue;
        }
        numberByPane.set(pane.id, persisted);
        paneByNumber.set(persisted, pane.id);
      }
      for (const pane of panes) claim(pane.id);
      return new Map(numberByPane);
    },
  };
}

/** Conveniência tipada: a árvore de layout entrega `PaneModel`. */
export function paneNumberSeedsOf(
  panes: readonly PaneModel[],
): readonly PaneNumberSeed[] {
  return panes.map((pane) => ({ id: pane.id, paneNumber: pane.paneNumber }));
}

/**
 * Marcador de conclusão do agente — núcleo puro (sem Electron, sem I/O).
 *
 * A Via Rápida pede a TODO agente uma linha final `PRONTO: <resumo>` (ou
 * `BLOQUEADO: <motivo>`), mas o motor decidia conclusão SÓ pelo estado do PTY
 * (`busy` → `idle`). CLI cujo parsing nunca flipa para `busy` — visto ao vivo
 * com `agy`, pane parado em "Pronto" o tempo todo — era lida como "viva mas
 * nunca trabalhou", e o tick reentregava o prompt INTEIRO a cada 90s para
 * sempre. O agente já tinha escrito `PRONTO: ...` na própria tela e refazia o
 * trabalho em loop até a CLI reclamar de conversa duplicada.
 *
 * Este módulo é o ouvido: acumula a saída já sem ANSI de cada sessão e reporta
 * o PRIMEIRO marcador legítimo com o texto do próprio agente.
 *
 * A ARMADILHA, e por que ela não dispara aqui
 * -------------------------------------------
 * O prompt entregue CONTÉM as palavras `PRONTO:` e `BLOQUEADO:` (é a instrução
 * que as pede), e a TUI ecoa o prompt na tela — de novo a cada recarga/retomada
 * e a cada repaint. Um `includes('PRONTO:')` ingênuo casaria com a INSTRUÇÃO e
 * concluiria toda missão em zero segundo com zero trabalho feito: um "done"
 * falso, estritamente pior que o loop que substitui. Três travas, todas
 * errando para o lado seguro (na dúvida é eco):
 *
 *  1. ÂNCORA DE LINHA — o marcador precisa ABRIR a linha depois de tirar
 *     moldura de TUI (`│`, `┃`, `>`), marcação (`*`, `#`, crase) e espaço. Na
 *     instrução ele nasce no meio da frase (`... escreva uma linha final
 *     "PRONTO: ...`), então a instrução íntegra já morre aqui.
 *  2. EXCLUSÃO DE ECO — a âncora sozinha NÃO basta: a TUI quebra a linha por
 *     largura e a continuação do eco pode começar exatamente em `PRONTO:`. Por
 *     isso o observador guarda o texto EXATO de todo prompt que a Via Rápida
 *     entregou àquela sessão e recusa qualquer candidata cujo conteúdo seja um
 *     pedaço desse prompt (contida nele, prefixo dele, ou começando por ele).
 *  3. SESSÃO ARMADA — sem prompt registrado nenhum marcador vale. O motor só
 *     confia em resposta a uma pergunta que ele mesmo fez; `PRONTO:` que já
 *     estava na tela/scrollback não é veredito de nada.
 */

/** Marcadores pedidos no prompt da Via Rápida. Ordem = precedência de varredura. */
export const MISSION_MARKERS = [
  { token: 'PRONTO:', kind: 'done' },
  { token: 'BLOQUEADO:', kind: 'blocked' },
] as const;

export type MissionMarkerKind = (typeof MISSION_MARKERS)[number]['kind'];

export interface MissionMarkerSighting {
  readonly kind: MissionMarkerKind;
  /** A frase do próprio agente depois do marcador — é isso que o operador lê. */
  readonly text: string;
  readonly at: number;
}

/** Janela rolante de texto decodificado por sessão. */
export const MARKER_BUFFER_CHARS = 8_192;
/**
 * Resumo/motivo com menos que isso é indistinguível de eco cortado pela quebra
 * de linha da TUI (`PRONTO:` sozinho no fim de uma linha estreita). Recusar é
 * a escolha segura: perde-se um marcador vazio, nunca se inventa um "done".
 */
export const MIN_MARKER_TEXT_CHARS = 3;
/**
 * Quantos caracteres do texto do prompt bastam para provar eco quando a
 * candidata CONTINUA além do prompt (repaint com reticências, colagem da linha
 * seguinte). Curto o bastante para pegar quebra, longo o bastante para nunca
 * casar com um resumo real escrito por um agente.
 */
export const ECHO_PREFIX_CHARS = 12;
/** Teto de sessões rastreadas — o mapa não pode crescer sem fim no processo. */
export const MAX_TRACKED_SESSIONS = 256;

// Moldura de TUI (box-drawing + barra), marcação de markdown e aspas de citação
// que costumam abrir a linha onde o agente escreve o marcador. Uma classe, um
// quantificador — nada de `(?:X+)+`, que é a forma clássica de backtracking
// catastrófico em cima de saída de terminal arbitrária.
const LEADING_DECORATION = /^[\s─-▟|>*#`'"•-]+/;
const TRAILING_FRAME = /[\s─-▟|`]+$/;

/** Tira moldura/marcação das pontas e colapsa espaço interno. */
export function trimLineDecoration(line: string): string {
  return line
    .replace(LEADING_DECORATION, '')
    .replace(TRAILING_FRAME, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Forma comparável de um prompt: sem moldura, espaço colapsado, minúsculo. */
function normalizeForEcho(text: string): string {
  return text
    .replace(/[─-▟|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Trava 2. `candidate` é a linha JÁ ancorada (começa no marcador). Devolve true
 * quando ela é pedaço de algum prompt entregue — e portanto eco da instrução,
 * não veredito do agente.
 *
 * Três formas de eco, porque a tela deforma o texto de três jeitos:
 *  - a linha é um trecho literal do prompt (repaint íntegro);
 *  - a linha é um PREFIXO do trecho do prompt que começa no marcador (a TUI
 *    cortou por largura);
 *  - a linha COMEÇA pelo trecho do prompt e continua (reticências de repaint,
 *    ou a quebra colou a frase seguinte).
 */
export function isPromptEcho(
  candidate: string,
  deliveredPrompts: readonly string[],
): boolean {
  const line = normalizeForEcho(candidate);
  if (!line) return true;
  for (const prompt of deliveredPrompts) {
    const normalized = normalizeForEcho(prompt);
    if (!normalized) continue;
    if (normalized.includes(line)) return true;
    for (const { token } of MISSION_MARKERS) {
      const marker = token.toLowerCase();
      let from = normalized.indexOf(marker);
      while (from !== -1) {
        const tail = normalized.slice(from);
        if (tail.startsWith(line)) return true;
        const probe = tail.slice(0, ECHO_PREFIX_CHARS);
        if (probe.length > 0 && line.startsWith(probe)) return true;
        from = normalized.indexOf(marker, from + marker.length);
      }
    }
  }
  return false;
}

export interface ScanMissionMarkerOptions {
  /**
   * Aceitar a última linha mesmo sem `\n`. Só a morte da sessão prova que ela
   * está completa; enquanto o PTY vive, uma linha ainda chegando daria um
   * resumo CORTADO ("PRONTO: resumo.txt gra") gravado como veredito final.
   */
  readonly allowPartialLastLine?: boolean;
}

/**
 * Varre um texto já sem ANSI e devolve o PRIMEIRO marcador legítimo. Puro: a
 * decisão inteira é função do texto observado mais os prompts entregues.
 */
export function scanMissionMarker(
  text: string,
  deliveredPrompts: readonly string[],
  options: ScanMissionMarkerOptions = {},
): { readonly kind: MissionMarkerKind; readonly text: string } | null {
  if (deliveredPrompts.length === 0) return null; // trava 3: sessão não armada
  const lines = text.split('\n');
  // Sem `\n` no fim a última linha ainda está chegando: ela só entra na
  // varredura quando a sessão morre e ninguém mais pode escrever nela.
  if (!options.allowPartialLastLine && !text.endsWith('\n')) lines.pop();
  for (const rawLine of lines) {
    const line = trimLineDecoration(rawLine);
    if (!line) continue;
    for (const { token, kind } of MISSION_MARKERS) {
      // Trava 1: o marcador tem que ABRIR a linha.
      if (!line.startsWith(token)) continue;
      const body = line.slice(token.length).trim();
      if (body.length < MIN_MARKER_TEXT_CHARS) continue;
      // Trava 2: a instrução ecoada nunca é veredito.
      if (isPromptEcho(line, deliveredPrompts)) continue;
      return { kind, text: body };
    }
  }
  return null;
}

interface TrackedSession {
  /** Texto EXATO de cada prompt que a Via Rápida entregou a esta sessão. */
  readonly prompts: string[];
  buffer: string;
  marker: MissionMarkerSighting | null;
  /** Sessão morta: buffer/prompts liberados, o veredito continua legível. */
  sealed: boolean;
}

/**
 * Contabilidade por sessão em volta de `scanMissionMarker`: janela rolante (o
 * marcador chega partido entre chunks do PTY), o conjunto de prompts entregues
 * e o veredito travado. Continua livre de Electron e de qualquer I/O.
 */
export class MissionMarkerObserver {
  readonly #sessions = new Map<string, TrackedSession>();

  #evictOverflow(): void {
    while (this.#sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done) return;
      this.#sessions.delete(oldest.value);
    }
  }

  /**
   * Arma a sessão com o texto EXATO do prompt entregue. Toda entrega (largada
   * nativa, colagem, recarga, retomada) tem que passar por aqui: é esse texto
   * que a trava de eco usa para não confundir a instrução com a resposta.
   */
  registerPrompt(sessionId: string, prompt: string): void {
    if (!prompt.trim()) return;
    const tracked = this.#sessions.get(sessionId);
    if (!tracked) {
      this.#sessions.set(sessionId, {
        prompts: [prompt],
        buffer: '',
        marker: null,
        sealed: false,
      });
      this.#evictOverflow();
      return;
    }
    if (!tracked.prompts.includes(prompt)) tracked.prompts.push(prompt);
  }

  /**
   * Portão barato para o tap do PTY: falso significa que o chamador pode pular
   * o stripAnsi inteiro. Para de observar assim que o veredito existe.
   */
  isWatching(sessionId: string): boolean {
    const tracked = this.#sessions.get(sessionId);
    return Boolean(tracked && !tracked.sealed && tracked.marker === null);
  }

  /** Alimenta um chunk já sem ANSI. Devolve o veredito quando ele nasce. */
  observe(
    sessionId: string,
    plainChunk: string,
    at = Date.now(),
  ): MissionMarkerSighting | null {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked || tracked.sealed) return null;
    if (tracked.marker) return null;
    tracked.buffer = `${tracked.buffer}${plainChunk}`.slice(
      -MARKER_BUFFER_CHARS,
    );
    const found = scanMissionMarker(tracked.buffer, tracked.prompts);
    if (!found) return null;
    tracked.marker = { kind: found.kind, text: found.text, at };
    // Veredito travado: o buffer não é mais necessário e não pode reprocessar.
    tracked.buffer = '';
    return tracked.marker;
  }

  /** Veredito já observado nesta sessão, se houver. */
  markerOf(sessionId: string): MissionMarkerSighting | null {
    return this.#sessions.get(sessionId)?.marker ?? null;
  }

  /**
   * Sessão morreu: libera buffer e prompts mas PRESERVA o veredito. Um agente
   * que escreve `PRONTO:` e sai no mesmo instante ainda precisa ser ouvido pelo
   * próximo tick do observador da missão.
   */
  seal(sessionId: string, at = Date.now()): MissionMarkerSighting | null {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked) return null;
    if (!tracked.marker) {
      // Última varredura já contando a linha pendente: agora que a sessão
      // morreu, ela está completa por definição.
      const found = scanMissionMarker(tracked.buffer, tracked.prompts, {
        allowPartialLastLine: true,
      });
      if (found) tracked.marker = { kind: found.kind, text: found.text, at };
    }
    tracked.sealed = true;
    tracked.buffer = '';
    tracked.prompts.length = 0;
    return tracked.marker;
  }

  drop(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  clear(): void {
    this.#sessions.clear();
  }
}

/**
 * Instância única do processo principal: o tap do PTY (mcp-server) alimenta e a
 * Via Rápida (mission-fast-lane) lê. Um só pipeline de saída, como o resto dos
 * observadores de PTY.
 */
export const missionMarkerObserver = new MissionMarkerObserver();

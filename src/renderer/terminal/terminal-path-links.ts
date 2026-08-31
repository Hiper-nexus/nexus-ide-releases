import type { Terminal } from '@xterm/xterm';

/**
 * Clickable terminal paths (G6, paridade Overclock/VSCode): um caminho
 * absoluto impresso no output do pane vira link. O clique NUNCA confia no
 * texto — `window.nexus.app.openTerminalPath` valida no main (existe, é
 * arquivo/diretório, dentro do home) antes de abrir qualquer coisa.
 */

export interface TerminalPathMatch {
  /** Índice inicial (0-based) na linha já sem ANSI. */
  readonly start: number;
  /** Índice final exclusivo. */
  readonly end: number;
  /** Caminho limpo (sem :line:col, sem pontuação vizinha). */
  readonly text: string;
}

/**
 * Segmento de caminho absoluto POSIX legível: começa em `/` precedido por
 * início de linha ou delimitador (evita matchear o meio de `relative/path`),
 * segmentos sem espaço (prosa grudaria), sufixo opcional `:line`/`:line:col`
 * do formato file.ts:12:5 — descascado no texto devolvido.
 */
const PATH_WITH_LOCATOR =
  /(^|[\s("'`[={,])(\/(?:[\w.@+-]+\/)*[\w.@+-]+\.[\w+-]+(?::\d+){0,2})/g;

/** Pontuação que costuma colar no fim de um caminho em frases de log. */
const TRAILING_PUNCTUATION = /[),.;:!?'"\]]+$/;

/**
 * Extrai caminhos absolutos clicáveis de uma linha de terminal (já sem ANSI).
 * Puro e unit-testado: sem DOM, sem xterm, sem IPC.
 */
export function matchTerminalPaths(line: string): TerminalPathMatch[] {
  if (!line || line.length > 2_048) return [];
  const matches: TerminalPathMatch[] = [];
  PATH_WITH_LOCATOR.lastIndex = 0;
  for (let m = PATH_WITH_LOCATOR.exec(line); m !== null; m = PATH_WITH_LOCATOR.exec(line)) {
    let text = m[2];
    const absoluteStart = m.index + m[1].length;
    // Descasca locator (:line:col) e pontuação de frase do fim.
    const locator = /(?::\d+){1,2}$/.exec(text);
    if (locator) text = text.slice(0, locator.index);
    text = text.replace(TRAILING_PUNCTUATION, '');
    if (!text.includes('/', 1)) continue; // só "/" + nome não é arquivo
    if (text.length < 3 || text.length > 1_024) continue;
    const start = absoluteStart;
    const end = start + text.length;
    if (matches.some((prior) => start < prior.end && end > prior.start)) {
      continue; // sobrepõe um match anterior — mantém o primeiro
    }
    matches.push({ start, end, text });
    if (matches.length >= 8) break;
  }
  return matches;
}

/** Extrai a linha de buffer já traduzida em string simples. */
function bufferLineToText(
  term: Terminal,
  bufferLineNumber: number,
): { text: string; startY: number } | null {
  const line = term.buffer.active.getLine(bufferLineNumber);
  if (!line) return null;
  return {
    text: line.translateToString(true),
    startY: bufferLineNumber - term.buffer.active.viewportY,
  };
}

export function attachTerminalPathLinks(term: Terminal): void {
  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const translated = bufferLineToText(term, bufferLineNumber);
      if (!translated) {
        callback(undefined);
        return;
      }
      const matches = matchTerminalPaths(translated.text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      callback(
        matches.map((match) => ({
          range: {
            start: { x: match.start + 1, y: translated.startY },
            end: { x: match.end, y: translated.startY },
          },
          text: match.text,
          activate: (_event: MouseEvent, text: string) => {
            void window.nexus.app.openTerminalPath(text);
          },
        })),
      );
    },
  });
}

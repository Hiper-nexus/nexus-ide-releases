/**
 * Digest compacto do tail de um pane para consumo do Maestro (F-digest).
 *
 * `nexus_pane_read` devolvia até 200 linhas cruas; um orquestrador que lê
 * vários panes queimava tokens com moldura de TUI. O digest mantém o que
 * decide a próxima ação: as linhas de sinal da parte mais antiga da janela
 * (erros, testes, prompts, handoffs) e as últimas 30 linhas não-vazias
 * verbatim. `mode: 'full'` continua devolvendo o tail inteiro.
 *
 * Puro: sem Electron, sem PTY — a entrada já chega ANSI-stripped do
 * `readSessionOutput`.
 */

/** Linhas que costumam carregar a decisão (erro, teste, pergunta, handoff). */
const SIGNAL_PATTERN =
  /error|erro|fail|falh|exception|traceback|panic|✕|✗|FAIL|tests?:|passed|failed|warning|aviso|denied|refused|permission|\[y\/n\]|\(y\/n\)|\?\s*$|handoff|NEXUS_HANDOFF|exit code|exited/i;

/**
 * Moldura/spinner de TUI: linha que só tem box-drawing, braille de spinner,
 * blocos ou ruído de progresso — nunca é conteúdo.
 */
const GLYPH_ONLY_PATTERN =
  /^[\s─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼╀╁╂╃╄╅╆╇╈╉╊╋═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷▀▄█▌▐░▒▓⠁-⣿◐◓◑◒○◔◕●◌•∙⋅·■□▪▫▲►▼◄◆◇]+$/u;

export const DIGEST_MAX_SIGNAL_LINES = 12;
export const DIGEST_TAIL_LINES = 30;
const ELLIPSIS = '…';

export interface PaneTailDigest {
  /** Texto compactado: sinais (até 12, ordem original) + gap "…" + tail 30. */
  readonly text: string;
  /** Linhas do input emitidas verbatim (sinais + tail). */
  readonly keptLines: number;
  /** Linhas do input omitidas (inclui moldura, blanks e o miolo comprimido). */
  readonly omittedLines: number;
}

export function digestPaneTail(tail: string): PaneTailDigest {
  const lines = tail.split('\n');
  const informative = lines.map((line, index) => ({
    index,
    line,
    drop: line.trim().length === 0 || GLYPH_ONLY_PATTERN.test(line.trim()),
  }));

  // Últimas 30 linhas não-vazias verbatim (moldura pura não conta).
  const tailBlock = informative
    .filter((item) => !item.drop)
    .slice(-DIGEST_TAIL_LINES);
  const tailStart = tailBlock[0]?.index ?? lines.length;
  const earlier = informative.slice(0, tailStart);

  // Sinais da parte anterior: dedup exato (uma cópia basta — eco repetido de
  // tela não é informação nova), teto de 12 escolhidos a partir do FIM da
  // parte anterior (o resumo de teste/erro mais recente decide a próxima
  // ação), emitidos na ordem original. O que ficou de fora entre dois
  // trechos mantidos vira uma linha "…".
  const signals: Array<{ index: number; line: string }> = [];
  const seen = new Set<string>();
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const item = earlier[i]!;
    if (item.drop || !SIGNAL_PATTERN.test(item.line) || seen.has(item.line)) {
      continue;
    }
    if (signals.length >= DIGEST_MAX_SIGNAL_LINES) break;
    seen.add(item.line);
    signals.push({ index: item.index, line: item.line });
  }
  signals.reverse();

  const out: string[] = [];
  for (const [i, signal] of signals.entries()) {
    if (i === 0) {
      if (signal.index > 0) out.push(ELLIPSIS);
    } else if (signal.index > signals[i - 1]!.index + 1) {
      out.push(ELLIPSIS);
    }
    out.push(signal.line);
  }
  const lastSignal = signals.at(-1);
  if (
    (lastSignal !== undefined && tailStart > lastSignal.index + 1) ||
    (lastSignal === undefined &&
      earlier.some((item) => !item.drop))
  ) {
    out.push(ELLIPSIS);
  }
  for (const item of tailBlock) out.push(item.line);

  const keptLines = signals.length + tailBlock.length;
  return {
    text: out.join('\n'),
    keptLines,
    omittedLines: Math.max(0, lines.length - keptLines),
  };
}

/**
 * Digest compacto do tail de um pane para consumo do Maestro (F-digest).
 *
 * `nexus_pane_read` devolvia até 200 linhas cruas; um orquestrador que lê
 * vários panes queimava tokens com moldura de TUI. O digest mantém o que
 * decide a próxima ação: as linhas de sinal da parte mais antiga da janela
 * (erros, testes, prompts, handoffs) e as últimas 30 linhas não-vazias.
 * `mode: 'full'` continua devolvendo o tail inteiro.
 *
 * F-987: uma "linha" de TUI pode ser dezenas de KB de redesenho — o cursor
 * volta, o texto é reescrito e, sem os escapes, tudo fica colado ("✻✶✳✢·",
 * "WWoWorWork…", o mesmo quadro "Working (2m 54s • esc to interrupt)" mil
 * vezes). O digest agora normaliza o redesenho (CR, spinner, prefixos
 * progressivos, quadros repetidos), deduplica quadros e status, e tem teto
 * de caracteres por linha e por pane, marcando o que omitiu.
 *
 * Puro: sem Electron, sem PTY — a entrada já chega ANSI-stripped do
 * `readSessionOutput` (o que sobrar de escape é removido aqui).
 */

/** Linhas que costumam carregar a decisão (erro, teste, pergunta, handoff). */
const SIGNAL_PATTERN =
  /error|erro|fail|falh|exception|traceback|panic|✕|✗|FAIL|tests?:|passed|failed|warning|aviso|denied|refused|permission|\[y\/n\]|\(y\/n\)|\?\s*$|handoff|NEXUS_HANDOFF|exit code|exited/i;

/**
 * Moldura/spinner de TUI: linha que só tem box-drawing, braille de spinner,
 * blocos ou ruído de progresso — nunca é conteúdo.
 */
const GLYPH_ONLY_PATTERN =
  /^[\s─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼╀╁╂╃╄╅╆╇╈╉╊╋═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷▀▄█▌▐░▒▓⠁-⣿◐◓◑◒○◔◕●◌•∙⋅·■□▪▫▲►▼◄◆◇✢✳✶✻✽✺✹✸✷✴✵❋❊❉❈*…]+$/u;

/** Glifos de spinner (Claude ✢✳✶✻✽, braille do Gemini/Qwen, meia-lua): decoração pura. */
const SPINNER_GLYPHS = /[✢✳✶✻✽✺✹✸✷✴✵❋❊❉❈⠀-⣿◐◓◑◒]/gu;
/** Mesma classe sem a flag `g` — `regex.test` com `g` é stateful (lastIndex). */
const SPINNER_TEST = new RegExp(SPINNER_GLYPHS.source, 'u');

/**
 * F-1425: linha que é pura decoração de TUI — moldura/box-drawing, spinner
 * braille (Devin ⠤⠄) ou glifo do Claude Code ("✽ ✻ ✶ ✳ ✢ ·"), contador
 * ("⠋ 5") — nunca é conteúdo legível nem resposta. Dígitos soltos SEM glifo
 * (uma resposta que é só "42") não são spinner: ficam.
 */
export function isSpinnerFrameLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (GLYPH_ONLY_PATTERN.test(trimmed)) return true;
  const withoutSpinner = trimmed.replace(SPINNER_GLYPHS, '').trim();
  return withoutSpinner !== trimmed && /^[\s\d]*$/.test(withoutSpinner);
}

/** Escape residual (CSI/OSC/ESC solto) e controle, menos TAB e CR. */
// F-1406: [0-?]* (ECMA-48, 0x30–0x3F) cobre os parâmetros privados que o
// Codex 0.162 emite no boot (ESC[>4;0m, ESC[>7u) — a classe antiga [0-9;?]
// deixava ">4;0m" como texto. Mesma forma do CSI_SEQUENCE_PATTERN
// compartilhado (ansi-escape-sequences).
// eslint-disable-next-line no-control-regex
const RESIDUAL_ESCAPE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
// eslint-disable-next-line no-control-regex -- remove controles residuais (menos TAB, LF e CR) de propósito
const RESIDUAL_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Linha de status/progresso da TUI (o quadro que se redesenha): só a mais
 * recente da janela diz alguma coisa.
 */
const STATUS_LINE_PATTERN =
  /\besc to (?:interrupt|cancel)\b|\bctrl\+c to (?:interrupt|cancel|stop)\b|^\W{0,4}\p{Lu}\p{Ll}+(?:ing|ndo)\b\S{0,2}\s*\(\s*\d+(?:m\s*\d+)?s\b/iu;

export const DIGEST_MAX_SIGNAL_LINES = 12;
export const DIGEST_TAIL_LINES = 30;
/** Teto de caracteres por linha emitida (cabeça + "…" + cauda). */
export const DIGEST_MAX_LINE_CHARS = 240;
/** Teto de caracteres do texto de UM pane (`nexus_pane_read`). */
export const DIGEST_MAX_CHARS = 6_000;
/**
 * Teto da resposta inteira de `nexus_pane_read_many` em digest (JSON
 * serializado, todos os panes): conferido antes de devolver.
 */
export const DIGEST_MANY_MAX_CHARS = 24_000;
/** Panes distintos por chamada de `nexus_pane_read_many`. */
export const PANE_READ_MANY_MAX_PANES = 30;
/** Referências (grafias) por chamada antes de resolver: 4 por pane. */
export const PANE_READ_MANY_MAX_REFS = PANE_READ_MANY_MAX_PANES * 4;
/** Piso do texto por pane: marca de corte + uma linha com teto. */
export const DIGEST_MIN_CHARS = 400;
/** Reserva por item para chaves, contagens e escapes do JSON. */
const DIGEST_ENTRY_OVERHEAD_CHARS = 300;

const ELLIPSIS = '…';
const LINE_HEAD_CHARS = 60;
/** Acima disto a linha passa pela compactação de quadros repetidos. */
const LONG_LINE_CHARS = 160;
/** Só a cauda (o desenho mais recente) de uma linha gigante é analisada. */
const LONG_LINE_ANALYSIS_CHARS = 2_048;
const REPEAT_MIN_UNIT = 6;
const REPEAT_MAX_UNIT = 120;
/** Linhas idênticas com pelo menos isto de texto viram uma só (a última). */
const DEDUP_MIN_CHARS = 6;
/** Espaço reservado para a linha "… [digest: N linha(s) omitida(s) …]". */
const MARKER_RESERVE_CHARS = 120;

export interface PaneTailDigest {
  /** Texto compactado: sinais (até 12, ordem original) + gap "…" + tail 30. */
  readonly text: string;
  /** Linhas do input emitidas (sinais + tail), já normalizadas. */
  readonly keptLines: number;
  /** Linhas do input omitidas (moldura, redesenho, duplicatas, miolo, teto). */
  readonly omittedLines: number;
  /** O teto de caracteres cortou linhas que ainda seriam emitidas. */
  readonly truncated: boolean;
  /**
   * F-1425: o tail inteiro não tinha texto legível — 'spinner' (redesenho
   * animando = trabalho ativo) ou 'static' (quadro sem letra nenhuma, não
   * prova nada). Ausente quando há texto legível.
   */
  readonly noReadableText?: 'spinner' | 'static';
}

export interface DigestOptions {
  /** Teto de caracteres do texto (padrão DIGEST_MAX_CHARS). */
  readonly maxChars?: number;
}

/**
 * Teto do texto por pane quando `count` panes dividem DIGEST_MANY_MAX_CHARS
 * (descontada a reserva de JSON de cada item). Com até
 * PANE_READ_MANY_MAX_PANES o piso nunca empurra a soma além do teto.
 */
export function digestBudgetPerPane(count: number): number {
  const panes = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const share = Math.floor(
    (DIGEST_MANY_MAX_CHARS - panes * DIGEST_ENTRY_OVERHEAD_CHARS) / panes,
  );
  return Math.max(DIGEST_MIN_CHARS, Math.min(DIGEST_MAX_CHARS, share));
}

const AGGREGATE_MARKER =
  '… [digest: início cortado pelo teto total do nexus_pane_read_many]';

function keepTextTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let tail = limit > 0 ? text.slice(-limit) : '';
  // Linhas inteiras: o pedaço cortado da primeira linha sai junto.
  const newline = tail.indexOf('\n');
  if (newline >= 0 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return tail ? `${AGGREGATE_MARKER}\n${tail}` : AGGREGATE_MARKER;
}

/**
 * Rede final do read_many, conferida no JSON que será devolvido: se passar de
 * `maxChars`, todo texto acima de um mesmo limite L fica só com as suas
 * últimas linhas (L é o maior que cabe — busca binária). Não depende de a
 * divisão por pane ter acertado a reserva de JSON.
 */
export function capDigestEntries<T extends Record<string, unknown>>(
  entries: readonly T[],
  maxChars: number = DIGEST_MANY_MAX_CHARS,
): Array<T & { truncated?: boolean }> {
  const apply = (limit: number): Array<T & { truncated?: boolean }> =>
    entries.map((entry) =>
      (typeof entry.text === 'string' && entry.text.length > limit
        ? { ...entry, text: keepTextTail(entry.text, limit), truncated: true }
        : { ...entry }) as T & { truncated?: boolean },
    );
  const fits = (candidate: readonly T[]) => JSON.stringify(candidate).length <= maxChars;
  const whole = apply(Number.POSITIVE_INFINITY);
  if (fits(whole)) return whole;
  let low = 0;
  let high = Math.max(
    0,
    ...entries.map((entry) => (typeof entry.text === 'string' ? entry.text.length : 0)),
  );
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(apply(middle))) low = middle;
    else high = middle - 1;
  }
  return apply(low);
}

/**
 * Orçamento de comparações por linha: a compactação é heurística e nunca
 * pode custar mais que O(64·n) — linha uniforme ("xxxx…") ou patológica para
 * de compactar e segue intacta.
 */
const WORK_PER_CHAR = 64;

class WorkBudget {
  #left: number;
  constructor(length: number) {
    this.#left = WORK_PER_CHAR * Math.max(1, length);
  }
  get exhausted(): boolean {
    return this.#left <= 0;
  }
  sameRange(text: string, a: number, b: number, length: number): boolean {
    for (let offset = 0; offset < length; offset += 1) {
      this.#left -= 1;
      if (text.charCodeAt(a + offset) !== text.charCodeAt(b + offset)) return false;
    }
    return true;
  }
}

function distinctChars(text: string): number {
  return new Set(text).size;
}

/** Relógio/progresso que muda a cada quadro ("12s", "2m 54s", "45%"). */
const TICKING_PATTERN = /\d+(?:\.\d+)?\s?(?:ms|s|m|%)(?![\p{L}\d])/u;

/**
 * "WWoWorWorkWorki…" (cada quadro reescreve o texto com uma letra a mais):
 * uma corrida de ≥4 prefixos crescentes consecutivos vira só o último.
 */
function collapseProgressiveRuns(line: string): string {
  const budget = new WorkBudget(line.length);
  const parts: string[] = [];
  let copyFrom = 0;
  let index = 0;
  while (index < line.length && !budget.exhausted) {
    let bestStart = -1;
    let bestEnd = -1;
    for (let seed = 1; seed <= 3; seed += 1) {
      let segmentStart = index;
      let segmentLength = seed;
      let segments = 1;
      while (true) {
        const next = segmentStart + segmentLength;
        if (next + segmentLength + 1 > line.length) break;
        if (!budget.sameRange(line, segmentStart, next, segmentLength)) break;
        segmentStart = next;
        segmentLength += 1;
        segments += 1;
      }
      const end = segmentStart + segmentLength;
      if (segments >= 4 && end > bestEnd) {
        bestStart = segmentStart;
        bestEnd = end;
      }
    }
    if (bestEnd > 0 && distinctChars(line.slice(bestStart, bestEnd)) >= 2) {
      parts.push(line.slice(copyFrom, index), line.slice(bestStart, bestEnd));
      index = bestEnd;
      copyFrom = index;
    } else {
      index += 1;
    }
  }
  if (copyFrom === 0) return line;
  parts.push(line.slice(copyFrom));
  return parts.join('');
}

/**
 * O mesmo quadro colado N vezes: fica só a última cópia. Cópias precisam ser
 * idênticas; só um quadro com relógio ("2m 54s", "45%") compara sem os
 * dígitos. Unidade precisa ter letra e ≥3 caracteres distintos — "0000",
 * "----" e listas como "a1.ts a2.ts" nunca colapsam.
 */
function collapseRepeatedUnits(line: string): string {
  const budget = new WorkBudget(line.length);
  const masked = line.replace(/\d/g, '0');
  const parts: string[] = [];
  let copyFrom = 0;
  let index = 0;
  while (index < line.length && !budget.exhausted) {
    let advanced = false;
    const maxUnit = Math.min(REPEAT_MAX_UNIT, Math.floor((line.length - index) / 2));
    for (let unit = REPEAT_MIN_UNIT; unit <= maxUnit && !budget.exhausted; unit += 1) {
      if (masked.charCodeAt(index) !== masked.charCodeAt(index + unit)) continue;
      if (!budget.sameRange(masked, index, index + unit, unit)) continue;
      const pattern = line.slice(index, index + unit);
      if (!/\p{L}/u.test(pattern) || distinctChars(pattern) < 3) continue;
      const text = TICKING_PATTERN.test(pattern) ? masked : line;
      if (text === line && !budget.sameRange(line, index, index + unit, unit)) continue;
      let copies = 2;
      while (
        index + (copies + 1) * unit <= line.length &&
        budget.sameRange(text, index, index + copies * unit, unit)
      ) {
        copies += 1;
      }
      parts.push(
        line.slice(copyFrom, index),
        line.slice(index + (copies - 1) * unit, index + copies * unit),
      );
      index += copies * unit;
      copyFrom = index;
      advanced = true;
      break;
    }
    if (!advanced) index += 1;
  }
  if (copyFrom === 0) return line;
  parts.push(line.slice(copyFrom));
  return parts.join('');
}

function capLine(line: string): string {
  if (line.length <= DIGEST_MAX_LINE_CHARS) return line;
  const tailChars = DIGEST_MAX_LINE_CHARS - LINE_HEAD_CHARS - 3;
  return `${line.slice(0, LINE_HEAD_CHARS)} ${ELLIPSIS} ${line.slice(-tailChars)}`;
}

/** Uma linha crua de terminal → o que o operador veria por último nela. */
export function normalizeRedrawLine(raw: string): string {
  let line = raw;
  if (line.includes('\r')) {
    // CR volta o cursor ao início: vale o último trecho com conteúdo.
    const segments = line.split('\r');
    line = segments.findLast((segment) => segment.trim().length > 0) ?? '';
  }
  if (line.includes('\x1b')) line = line.replace(RESIDUAL_ESCAPE, '');
  line = line.replace(RESIDUAL_CONTROL, '').replace(SPINNER_GLYPHS, '');
  let clipped = false;
  if (line.length > LONG_LINE_ANALYSIS_CHARS) {
    // O começo de uma linha gigante é redesenho antigo; o fim é o estado atual.
    line = line.slice(-LONG_LINE_ANALYSIS_CHARS);
    clipped = true;
  }
  line = collapseProgressiveRuns(line);
  if (line.length > LONG_LINE_CHARS) line = collapseRepeatedUnits(line);
  line = line
    .replace(/·{2,}/g, '·')
    .replace(/(\S)[ \t]{3,}/g, '$1  ')
    .trimEnd();
  if (clipped) line = `${ELLIPSIS} ${line.trimStart()}`;
  return capLine(line);
}

/**
 * Chave de quadro: só linhas com relógio/progresso comparam sem os dígitos —
 * "linha 1"/"linha 2" continuam distintas; "Elapsed 12s"/"Elapsed 13s" não.
 */
function frameKey(line: string): string | null {
  const trimmed = line.trim();
  if (TICKING_PATTERN.test(trimmed)) return trimmed.replace(/\d+/g, '0');
  if (/^\d+$/.test(trimmed)) return '0';
  return null;
}

export function digestPaneTail(
  tail: string,
  options: DigestOptions = {},
): PaneTailDigest {
  const maxChars = Math.max(
    DIGEST_MIN_CHARS,
    Math.floor(options.maxChars ?? DIGEST_MAX_CHARS),
  );
  const lines = tail.split('\n');
  const items = lines.map((raw, index) => {
    const line = normalizeRedrawLine(raw);
    const trimmed = line.trim();
    return {
      index,
      line,
      drop: isSpinnerFrameLine(raw) || isSpinnerFrameLine(line),
      status: STATUS_LINE_PATTERN.test(trimmed),
    };
  });

  // Quadros redesenhados: só o último status da janela, só a última cópia de
  // uma linha repetida e só o último de quadros consecutivos que diferem
  // apenas no relógio.
  let lastStatus = -1;
  for (const item of items) {
    if (!item.drop && item.status) lastStatus = item.index;
  }
  const seenLater = new Set<string>();
  let nextKey: string | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.drop) continue;
    if (item.status && item.index !== lastStatus) {
      item.drop = true;
      continue;
    }
    const trimmed = item.line.trim();
    const key = frameKey(item.line);
    if (
      (trimmed.length >= DEDUP_MIN_CHARS && seenLater.has(trimmed)) ||
      (key !== null && key === nextKey)
    ) {
      item.drop = true;
      continue;
    }
    if (trimmed.length >= DEDUP_MIN_CHARS) seenLater.add(trimmed);
    nextKey = key;
  }

  // Últimas 30 linhas informativas (moldura e redesenho não contam).
  const tailBlock = items
    .filter((item) => !item.drop)
    .slice(-DIGEST_TAIL_LINES);
  const tailStart = tailBlock[0]?.index ?? lines.length;
  const earlier = items.slice(0, tailStart);

  // Sinais da parte anterior: dedup exato (uma cópia basta — eco repetido de
  // tela não é informação nova), teto de 12 escolhidos a partir do FIM da
  // parte anterior (o resumo de teste/erro mais recente decide a próxima
  // ação), emitidos na ordem original.
  let signals: Array<{ index: number; line: string }> = [];
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
  let tailLines = tailBlock.map((item) => ({ index: item.index, line: item.line }));

  // Teto por pane: sinais antigos saem primeiro, depois o começo do tail. As
  // últimas linhas (o estado atual) são as que ficam.
  const size = () =>
    [...signals, ...tailLines].reduce((total, item) => total + item.line.length + 1, 0) +
    2 * (signals.length + 2);
  const before = signals.length + tailLines.length;
  if (size() > maxChars) {
    // Reserva a linha que marca o corte.
    const limit = maxChars - MARKER_RESERVE_CHARS;
    while (size() > limit && signals.length > 0) signals = signals.slice(1);
    while (size() > limit && tailLines.length > 1) tailLines = tailLines.slice(1);
  }
  const cutByBudget = before - signals.length - tailLines.length;

  const out: string[] = [];
  const firstEmitted = signals[0]?.index ?? tailLines[0]?.index ?? lines.length;
  if (cutByBudget > 0) {
    out.push(
      `${ELLIPSIS} [digest: ${cutByBudget} linha(s) omitida(s) pelo teto de ` +
        `${maxChars} caracteres; mode:'full' devolve tudo]`,
    );
  } else if (items.slice(0, firstEmitted).some((item) => !item.drop)) {
    out.push(ELLIPSIS);
  }
  for (const [i, signal] of signals.entries()) {
    if (i > 0 && signal.index > signals[i - 1]!.index + 1) out.push(ELLIPSIS);
    out.push(signal.line);
  }
  const lastSignal = signals.at(-1);
  const tailFirst = tailLines[0]?.index ?? lines.length;
  if (
    lastSignal !== undefined &&
    items.slice(lastSignal.index + 1, tailFirst).some((item) => !item.drop)
  ) {
    out.push(ELLIPSIS);
  }
  for (const item of tailLines) out.push(item.line);

  const keptLines = signals.length + tailLines.length;
  // F-1356: se todos os quadros eram redesenho de spinner / dígitos soltos sem texto legível
  if (
    signals.length === 0 &&
    (tailLines.length === 0 || tailLines.every((item) => /^\s*\d*\s*$/.test(item.line)))
  ) {
    const hadVisibleContent = lines.some((l) => l.trim().length > 0);
    if (hadVisibleContent) {
      return {
        text: 'TUI sem texto legível',
        keptLines: 0,
        omittedLines: lines.length,
        truncated: false,
        // F-1425: spinner visível = a TUI está animando = trabalho ativo.
        // Sem spinner nenhum é quadro estático: não prova estado algum.
        noReadableText: lines.some((l) => SPINNER_TEST.test(l))
          ? 'spinner'
          : 'static',
      };
    }
  }

  return {
    text: out.join('\n'),
    keptLines,
    omittedLines: Math.max(0, lines.length - keptLines),
    truncated: cutByBudget > 0,
  };
}

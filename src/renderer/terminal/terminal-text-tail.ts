export interface TerminalTextLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(index: number): { getWidth(): number; getChars(): string } | undefined;
  translateToString(trimRight?: boolean): string;
}

export interface TerminalTextBuffer {
  readonly length: number;
  readonly baseY: number;
  readonly cursorY: number;
  getLine(index: number): TerminalTextLine | undefined;
}

export interface TerminalTextBuffers {
  readonly normal: TerminalTextBuffer;
  readonly active: TerminalTextBuffer;
}

const DEFAULT_TAIL_CHARS = 2_400;
const MIN_LINE_SCAN_BUDGET = 256;

/** UTF-16 budget, like String.slice, but never start inside a surrogate pair. */
function unicodeSuffix(text: string, maxChars: number): string {
  const suffix = text.slice(-maxChars);
  const first = suffix.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? suffix.slice(1) : suffix;
}

function readBufferTail(buffer: TerminalTextBuffer, maxChars: number): string {
  if (maxChars <= 0) return '';
  const pieces: string[] = [];
  const cursorRow = buffer.baseY + buffer.cursorY;
  const firstRow = Math.max(0, buffer.length - Math.max(MIN_LINE_SCAN_BUDGET, maxChars + 1));
  let length = 0;
  let started = false;
  let nextWrapped = false;
  let nextWide = false;
  for (let index = buffer.length - 1; index >= firstRow && length < maxChars; index--) {
    const line = buffer.getLine(index);
    if (!line) continue;
    // Spaces at the end of a continued row are part of the logical line.
    let text = line.translateToString(!nextWrapped);
    // A wide glyph that cannot fit leaves one null cell before wrapping.
    const lastCell = nextWrapped && nextWide ? line.getCell(line.length - 1) : undefined;
    if (lastCell?.getWidth() === 1 && lastCell.getChars() === '') text = text.slice(0, -1);
    if (!started && text.length === 0 && index > cursorRow) continue;
    const separator = started && !nextWrapped ? '\n' : '';
    const piece = text + separator;
    pieces.push(piece.slice(-Math.max(1, maxChars - length)));
    length += piece.length;
    nextWrapped = line.isWrapped;
    nextWide = line.getCell(0)?.getWidth() === 2;
    started = true;
  }
  return unicodeSuffix(pieces.reverse().join(''), maxChars);
}

/**
 * Read parsed text only: never flush output, mutate xterm, or serialize history.
 * Preserve normal history before an alternate screen, as the old serializer did.
 * Work is bounded by the character budget plus a small floor for blank screen rows;
 * pathological empty wrapped rows cannot make a read traverse the full history.
 */
export function readTerminalTextTail(buffers: TerminalTextBuffers, maxChars = DEFAULT_TAIL_CHARS): string {
  if (!Number.isFinite(maxChars) || maxChars < 1) return '';
  const budget = Math.floor(maxChars);
  const active = readBufferTail(buffers.active, budget);
  if (buffers.active === buffers.normal || active.length >= budget) return active;
  const normal = readBufferTail(buffers.normal, budget - active.length - (active ? 1 : 0));
  return normal && active ? `${normal}\n${active}` : normal || active;
}

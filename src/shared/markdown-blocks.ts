/**
 * Markdown dos agentes (item T3 `ChatMarkdown`), sem dependência e sem HTML.
 *
 * Parser puro: transforma o texto em blocos e nós inline que o renderer
 * monta só com elementos React. Nada aqui produz marcação — HTML cru que o
 * agente escreveu continua texto literal. O inline reaproveita
 * `parseInlineMarkdown` (negrito, itálico, tachado e código) e acrescenta
 * links, que só existem quando o destino é http/https.
 *
 * Subconjunto deliberado: títulos, parágrafos com quebra de linha, listas
 * (com aninhamento simples), citação, código cercado, linha horizontal e
 * tabela GFM simples. Tudo com teto de tamanho, de blocos e de profundidade,
 * porque a entrada vem de agente e pode ser enorme ou hostil.
 */
import { parseInlineMarkdown, type RichTextMark, type RichTextSpan } from './rich-text-marks';

/** Acima disso o texto é cortado e a tela avisa. */
export const MARKDOWN_MAX_CHARS = 100_000;
/** Blocos totais (aninhados incluídos) por texto. */
export const MARKDOWN_MAX_BLOCKS = 2_000;
/** Citações/listas aninhadas além disso viram parágrafo. */
export const MARKDOWN_MAX_DEPTH = 8;
const MAX_TABLE_COLUMNS = 32;
const MAX_LINK_LENGTH = 2_048;

export type MarkdownInline =
  | { readonly kind: 'text'; readonly text: string; readonly marks: RichTextMark[] }
  | { readonly kind: 'link'; readonly href: string; readonly label: RichTextSpan[] }
  | { readonly kind: 'break' };

export type MarkdownTableAlign = 'left' | 'center' | 'right' | null;

export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: MarkdownInline[] }
  | { readonly kind: 'paragraph'; readonly inline: MarkdownInline[] }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'quote'; readonly blocks: MarkdownBlock[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: MarkdownBlock[][] }
  | {
      readonly kind: 'table';
      readonly align: MarkdownTableAlign[];
      readonly header: MarkdownInline[][];
      readonly rows: MarkdownInline[][][];
    }
  | { readonly kind: 'rule' };

export function limitMarkdownSource(source: string): { text: string; truncated: boolean } {
  const text = typeof source === 'string' ? source : '';
  if (text.length <= MARKDOWN_MAX_CHARS) return { text, truncated: false };
  let cut = text.slice(0, MARKDOWN_MAX_CHARS);
  // Não deixa meio par substituto no fim.
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/** Só http/https, sem usuário/senha embutidos. Devolve a URL normalizada. */
export function safeExternalHref(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/* ───────────────────────── inline ───────────────────────── */

const LINK = /\[([^[\]\n]{1,1000})\]\(\s*<?([^\s<>()]{1,2048})>?(?:\s+"[^"\n]{0,500}")?\s*\)/y;
const AUTOLINK = /<(https?:\/\/[^\s<>]{1,2048})>/y;
const BARE_URL = /https?:\/\/[^\s<>"'`]{1,2048}/y;
const INLINE_SPECIAL = /[\\`[<h]/g;
const MARK_ESCAPABLE = /[*`_~\\]/;
const PUNCTUATION_ESCAPABLE = /[!"#$%&'()+,\-./:;<=>?@[\]^{|}]/;

function textNodes(buffer: string): MarkdownInline[] {
  if (!buffer) return [];
  // Sem marcador nenhum, o parser do composer devolveria um span só; pular
  // a chamada evita o custo por caractere dele em texto longo e liso.
  if (!/[*_~`\\]/.test(buffer)) return [{ kind: 'text', text: buffer, marks: [] }];
  return parseInlineMarkdown(buffer).map((span) => ({ kind: 'text', text: span.text, marks: span.marks }));
}

/**
 * Fecho de code span em O(n) por linha. Indexa uma vez os runs de crase
 * maximais por largura; cada consulta avança um cursor por largura, então
 * as consultas precisam vir da esquerda para a direita. A busca do fecho
 * ignora barra invertida, como em `readCodeSpan` (código é literal).
 * Devolve o índice logo após o fecho, ou -1.
 */
function codeSpanCloser(text: string): (open: number, width: number) => number {
  const starts = new Map<number, number[]>();
  let index = text.indexOf('`');
  while (index >= 0) {
    let end = index;
    while (text[end] === '`') end += 1;
    const list = starts.get(end - index);
    if (list) list.push(index);
    else starts.set(end - index, [index]);
    index = text.indexOf('`', end);
  }
  const cursors = new Map<number, number>();
  return (open, width) => {
    const list = starts.get(width);
    if (!list) return -1;
    let cursor = cursors.get(width) ?? 0;
    while (cursor < list.length && list[cursor]! < open + width) cursor += 1;
    cursors.set(width, cursor);
    return cursor < list.length ? list[cursor]! + width : -1;
  };
}

function trimUrlTail(url: string): string {
  // ')' final só sai se a URL não abriu '(' antes dele (Wikipedia_(x)).
  const firstOpen = url.indexOf('(');
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (/[.,;:!?'"*_~\]]/.test(ch)) { end -= 1; continue; }
    if (ch === ')' && (firstOpen < 0 || firstOpen >= end)) { end -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

/** Uma linha de texto → nós inline. Quebras de linha são do bloco. */
export function parseMarkdownInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let buffer = '';
  const flush = () => {
    for (const node of textNodes(buffer)) out.push(node);
    buffer = '';
  };
  const closer = codeSpanCloser(text);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      // Marcas ficam para o parser do composer; pontuação escapada é literal.
      if (MARK_ESCAPABLE.test(next)) buffer += ch + next;
      else if (PUNCTUATION_ESCAPABLE.test(next)) buffer += next;
      else buffer += ch + next;
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = i;
      while (text[run] === '`') run += 1;
      const end = closer(i, run - i);
      // Run sem par vai escapado: o parser do composer não procura fecho
      // de novo (essa busca, repetida por run, era quadrática).
      buffer += end < 0 ? '\\`'.repeat(run - i) : text.slice(i, end);
      i = end < 0 ? run : end;
      continue;
    }
    if (ch === '[') {
      LINK.lastIndex = i;
      const match = LINK.exec(text);
      if (match) {
        const href = safeExternalHref(match[2]!);
        if (href) {
          flush();
          out.push({ kind: 'link', href, label: parseInlineMarkdown(match[1]!) });
        } else {
          flush();
          out.push({ kind: 'text', text: match[0], marks: [] });
        }
        i += match[0].length;
        continue;
      }
    }
    if (ch === '<') {
      AUTOLINK.lastIndex = i;
      const match = AUTOLINK.exec(text);
      const href = match ? safeExternalHref(match[1]!) : null;
      if (match && href) {
        flush();
        out.push({ kind: 'link', href, label: [{ text: match[1]!, marks: [] }] });
        i += match[0].length;
        continue;
      }
    }
    if (ch === 'h' && !/[A-Za-z0-9]/.test(text[i - 1] ?? '')) {
      BARE_URL.lastIndex = i;
      const match = BARE_URL.exec(text);
      if (match) {
        const raw = trimUrlTail(match[0]);
        const href = raw.length > 'https://'.length ? safeExternalHref(raw) : null;
        if (href) {
          flush();
          out.push({ kind: 'link', href, label: [{ text: raw, marks: [] }] });
          i += raw.length;
          continue;
        }
        // Não é URL válida: o trecho todo é literal (nó próprio), sem tentar
        // de novo a cada 'h' de dentro dele.
        if (raw) {
          flush();
          out.push({ kind: 'text', text: raw, marks: [] });
          i += raw.length;
          continue;
        }
      }
    }
    // Texto comum vai em bloco até o próximo caractere que pode abrir algo.
    INLINE_SPECIAL.lastIndex = i + 1;
    const special = INLINE_SPECIAL.exec(text);
    const stop = special ? special.index : text.length;
    buffer += text.slice(i, stop);
    i = stop;
  }
  flush();
  return out;
}

/* ───────────────────────── blocos ───────────────────────── */

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;

interface Context {
  remaining: number;
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (line[count] === ' ') count += 1;
  return count;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

function headingOf(line: string): { level: number; text: string } | null {
  const open = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
  if (!open) return null;
  let text = line.slice(open[0].length).trim();
  // Fecho opcional "## Título ##": só quando separado por espaço.
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) {
    text = text.slice(0, end).trimEnd();
  }
  return { level: open[1]!.length, text };
}

interface ListMarker {
  indent: number;
  bullet: string | null;
  delimiter: string | null;
  start: number;
  contentIndent: number;
  content: string;
}

function listMarkerOf(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const indent = match[1]!.length;
  const marker = match[2]!;
  const gap = match[3]?.length ?? 0;
  const ordered = /^\d/.test(marker);
  return {
    indent,
    bullet: ordered ? null : marker,
    delimiter: ordered ? marker.slice(-1) : null,
    start: ordered ? Number.parseInt(marker.slice(0, -1), 10) : 1,
    contentIndent: indent + marker.length + (gap >= 1 && gap <= 4 ? gap : 1),
    content: match[4] ?? '',
  };
}

function sameListType(a: ListMarker, b: ListMarker): boolean {
  return a.bullet !== null ? a.bullet === b.bullet : a.delimiter === b.delimiter;
}

/** Divide uma linha de tabela respeitando `\|` e code spans. */
function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  const closer = codeSpanCloser(text);
  let cell = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = i;
      while (text[run] === '`') run += 1;
      const end = closer(i, run - i);
      const stop = end < 0 ? run : end;
      cell += text.slice(i, stop).replace(/\\\|/g, '|');
      i = stop;
      continue;
    }
    if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
      i += 1;
      if (cells.length >= MAX_TABLE_COLUMNS) return cells;
      continue;
    }
    cell += ch;
    i += 1;
  }
  cells.push(cell.trim());
  return cells.slice(0, MAX_TABLE_COLUMNS);
}

function tableAlignOf(line: string | undefined, columns: number): MarkdownTableAlign[] | null {
  if (line === undefined || !line.includes('-') || !/^[\s|:-]+$/.test(line)) return null;
  const cells = splitTableRow(line);
  if (cells.length !== columns || !cells.every((cell) => TABLE_DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

function tableStart(lines: readonly string[], i: number): MarkdownTableAlign[] | null {
  const line = lines[i] ?? '';
  if (!line.includes('|')) return null;
  return tableAlignOf(lines[i + 1], splitTableRow(line).length);
}

function startsBlock(lines: readonly string[], i: number, nested: boolean): boolean {
  const line = lines[i] ?? '';
  if (FENCE_OPEN.test(line) || headingOf(line) || RULE.test(line)) return true;
  if (nested && (QUOTE.test(line) || (listMarkerOf(line)?.indent ?? 4) <= 3)) return true;
  return tableStart(lines, i) !== null;
}

function paragraphInline(lines: readonly string[]): MarkdownInline[] {
  const inline: MarkdownInline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) inline.push({ kind: 'break' });
    for (const node of parseMarkdownInline(line.trim())) inline.push(node);
  });
  return inline;
}

/** Resultado de um leitor de bloco: o bloco e a próxima linha a ler. */
interface Parsed {
  readonly block: MarkdownBlock;
  readonly next: number;
}

function parseFence(lines: readonly string[], start: number): Parsed | null {
  const fence = FENCE_OPEN.exec(lines[start] ?? '');
  // Info string de cerca com crase não pode conter crase (CommonMark).
  if (!fence || (fence[2]![0] === '`' && fence[3]!.includes('`'))) return null;
  const indent = fence[1]!.length;
  const marker = fence[2]!;
  const word = fence[3]!.trim().split(/\s+/)[0] ?? '';
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const candidate = lines[i]!;
    i += 1;
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate);
    if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
    body.push(candidate.slice(Math.min(indent, leadingSpaces(candidate))));
  }
  return { block: { kind: 'code', language: LANGUAGE.test(word) ? word : '', text: body.join('\n') }, next: i };
}

function parseQuote(lines: readonly string[], start: number, depth: number, ctx: Context): Parsed {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length && !isBlank(lines[i])) {
    const candidate = lines[i]!;
    if (QUOTE.test(candidate)) inner.push(candidate.replace(QUOTE, ''));
    else if (!startsBlock(lines, i, true)) inner.push(candidate); // continuação preguiçosa
    else break;
    i += 1;
  }
  ctx.remaining -= 1;
  return { block: { kind: 'quote', blocks: parseBlocks(inner, depth + 1, ctx) }, next: i };
}

/** Linhas de um item: até o próximo irmão (`sibling`) ou o fim da lista. */
function collectListItem(
  lines: readonly string[],
  start: number,
  first: ListMarker,
  current: ListMarker,
): { itemLines: string[]; next: number; sibling: ListMarker | null } {
  const need = Math.min(current.contentIndent, current.indent + 2);
  const itemLines = [current.content];
  let i = start + 1;
  while (i < lines.length) {
    const candidate = lines[i]!;
    if (isBlank(candidate)) {
      // O bloco de linhas em branco é lido uma vez só: varrer adiante a cada
      // linha em branco era quadrático.
      let ahead = i + 1;
      while (ahead < lines.length && isBlank(lines[ahead])) ahead += 1;
      if (ahead < lines.length && leadingSpaces(lines[ahead]!) >= need) {
        for (; i < ahead; i += 1) itemLines.push('');
        continue;
      }
      const sibling = ahead < lines.length ? listMarkerOf(lines[ahead]!) : null;
      const continues = sibling !== null && sibling.indent < need && sibling.indent <= 3 && sameListType(first, sibling);
      return { itemLines, next: continues ? ahead : i, sibling: continues ? sibling : null };
    }
    const lead = leadingSpaces(candidate);
    if (lead >= need) {
      itemLines.push(candidate.slice(Math.min(lead, current.contentIndent)));
      i += 1;
      continue;
    }
    const sibling = listMarkerOf(candidate);
    if (sibling) return { itemLines, next: i, sibling: sameListType(first, sibling) ? sibling : null };
    if (startsBlock(lines, i, true)) break;
    itemLines.push(candidate.trimStart()); // continuação preguiçosa
    i += 1;
  }
  return { itemLines, next: i, sibling: null };
}

function parseList(lines: readonly string[], start: number, first: ListMarker, depth: number, ctx: Context): Parsed {
  const items: MarkdownBlock[][] = [];
  let current: ListMarker | null = first;
  let i = start;
  ctx.remaining -= 1;
  while (current && i < lines.length && ctx.remaining > 0) {
    const item = collectListItem(lines, i, first, current);
    items.push(parseBlocks(item.itemLines, depth + 1, ctx));
    i = item.next;
    current = item.sibling;
  }
  return { block: { kind: 'list', ordered: first.bullet === null, start: first.start, items }, next: i };
}

function parseTable(
  lines: readonly string[],
  start: number,
  align: MarkdownTableAlign[],
  nested: boolean,
  ctx: Context,
): Parsed {
  const columns = align.length;
  const cellsOf = (row: string): MarkdownInline[][] => {
    const cells = splitTableRow(row).slice(0, columns);
    while (cells.length < columns) cells.push('');
    return cells.map((cell) => parseMarkdownInline(cell));
  };
  const header = cellsOf(lines[start]!);
  const rows: MarkdownInline[][][] = [];
  let i = start + 2;
  ctx.remaining -= 1;
  while (i < lines.length && ctx.remaining > 0) {
    const row = lines[i]!;
    if (isBlank(row) || !row.includes('|') || startsBlock(lines, i, nested)) break;
    rows.push(cellsOf(row));
    ctx.remaining -= 1;
    i += 1;
  }
  return { block: { kind: 'table', align, header, rows }, next: i };
}

function parseParagraph(lines: readonly string[], start: number, nested: boolean, ctx: Context): Parsed {
  let i = start + 1;
  while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i, nested)) i += 1;
  ctx.remaining -= 1;
  return { block: { kind: 'paragraph', inline: paragraphInline(lines.slice(start, i)) }, next: i };
}

function parseBlockAt(lines: readonly string[], i: number, depth: number, ctx: Context): Parsed {
  const line = lines[i]!;
  const nested = depth < MARKDOWN_MAX_DEPTH;
  const fence = parseFence(lines, i);
  if (fence) {
    ctx.remaining -= 1;
    return fence;
  }
  const heading = headingOf(line);
  if (heading) {
    ctx.remaining -= 1;
    const level = heading.level as 1 | 2 | 3 | 4 | 5 | 6;
    return { block: { kind: 'heading', level, inline: parseMarkdownInline(heading.text) }, next: i + 1 };
  }
  if (RULE.test(line)) {
    ctx.remaining -= 1;
    return { block: { kind: 'rule' }, next: i + 1 };
  }
  if (nested && QUOTE.test(line)) return parseQuote(lines, i, depth, ctx);
  const marker = nested ? listMarkerOf(line) : null;
  if (marker && marker.indent <= 3) return parseList(lines, i, marker, depth, ctx);
  const align = tableStart(lines, i);
  if (align) return parseTable(lines, i, align, nested, ctx);
  return parseParagraph(lines, i, nested, ctx);
}

function parseBlocks(lines: readonly string[], depth: number, ctx: Context): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length && ctx.remaining > 0) {
    if (isBlank(lines[i])) {
      i += 1;
      continue;
    }
    const parsed = parseBlockAt(lines, i, depth, ctx);
    blocks.push(parsed.block);
    i = parsed.next;
  }
  return blocks;
}

/** Texto → blocos. Corte por tamanho é do chamador (`limitMarkdownSource`). */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = (typeof markdown === 'string' ? markdown : '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  return parseBlocks(lines, 0, { remaining: MARKDOWN_MAX_BLOCKS });
}

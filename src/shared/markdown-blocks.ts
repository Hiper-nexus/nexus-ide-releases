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
const MARK_ESCAPABLE = /[*`_~\\]/;
const PUNCTUATION_ESCAPABLE = /[!"#$%&'()+,\-./:;<=>?@[\]^{|}]/;

function textNodes(buffer: string): MarkdownInline[] {
  if (!buffer) return [];
  return parseInlineMarkdown(buffer).map((span) => ({ kind: 'text', text: span.text, marks: span.marks }));
}

/** Fim de um code span que abre em `open` com `width` crases, ou -1. */
function codeSpanEnd(text: string, open: number, width: number): number {
  let index = open + width;
  while (index < text.length) {
    const next = text.indexOf('`', index);
    if (next < 0) return -1;
    let end = next;
    while (text[end] === '`') end += 1;
    if (end - next === width) return end;
    index = end;
  }
  return -1;
}

function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (/[.,;:!?'"*_~\]]/.test(ch)) { end -= 1; continue; }
    if (ch === ')' && !url.slice(0, end).includes('(')) { end -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

/** Uma linha de texto → nós inline. Quebras de linha são do bloco. */
export function parseMarkdownInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let buffer = '';
  const flush = () => {
    out.push(...textNodes(buffer));
    buffer = '';
  };
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
      const end = codeSpanEnd(text, i, run - i);
      const stop = end < 0 ? run : end;
      buffer += text.slice(i, stop);
      i = stop;
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
          buffer += match[0];
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
      }
    }
    buffer += ch;
    i += 1;
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
      const end = codeSpanEnd(text, i, run - i);
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
    inline.push(...parseMarkdownInline(line.trim()));
  });
  return inline;
}

function parseBlocks(lines: readonly string[], depth: number, ctx: Context): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const nested = depth < MARKDOWN_MAX_DEPTH;
  const push = (block: MarkdownBlock) => {
    blocks.push(block);
    ctx.remaining -= 1;
  };
  let i = 0;
  while (i < lines.length && ctx.remaining > 0) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const word = fence[3]!.trim().split(/\s+/)[0] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i]!;
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i += 1;
          break;
        }
        body.push(candidate.slice(Math.min(indent, leadingSpaces(candidate))));
        i += 1;
      }
      push({ kind: 'code', language: LANGUAGE.test(word) ? word : '', text: body.join('\n') });
      continue;
    }

    const heading = headingOf(line);
    if (heading) {
      push({
        kind: 'heading',
        level: heading.level as 1 | 2 | 3 | 4 | 5 | 6,
        inline: parseMarkdownInline(heading.text),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (nested && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const candidate = lines[i]!;
        if (QUOTE.test(candidate)) inner.push(candidate.replace(QUOTE, ''));
        else if (!startsBlock(lines, i, true)) inner.push(candidate); // continuação preguiçosa
        else break;
        i += 1;
      }
      ctx.remaining -= 1;
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner, depth + 1, ctx) });
      continue;
    }

    const marker = nested ? listMarkerOf(line) : null;
    if (marker && marker.indent <= 3) {
      const items: MarkdownBlock[][] = [];
      let current: ListMarker | null = marker;
      ctx.remaining -= 1;
      while (current && i < lines.length && ctx.remaining > 0) {
        const need = Math.min(current.contentIndent, current.indent + 2);
        const itemLines = [current.content];
        let next: ListMarker | null = null;
        i += 1;
        while (i < lines.length) {
          const candidate = lines[i]!;
          if (isBlank(candidate)) {
            let ahead = i + 1;
            while (ahead < lines.length && isBlank(lines[ahead])) ahead += 1;
            if (ahead < lines.length && leadingSpaces(lines[ahead]!) >= need) {
              itemLines.push('');
              i += 1;
              continue;
            }
            const sibling = ahead < lines.length ? listMarkerOf(lines[ahead]!) : null;
            if (sibling && sibling.indent < need && sibling.indent <= 3 && sameListType(marker, sibling)) {
              i = ahead;
              next = sibling;
            }
            break;
          }
          const lead = leadingSpaces(candidate);
          if (lead >= need) {
            itemLines.push(candidate.slice(Math.min(lead, current.contentIndent)));
            i += 1;
            continue;
          }
          const sibling = listMarkerOf(candidate);
          if (sibling) {
            if (sameListType(marker, sibling)) next = sibling;
            break;
          }
          if (startsBlock(lines, i, true)) break;
          itemLines.push(candidate.trimStart()); // continuação preguiçosa
          i += 1;
        }
        items.push(parseBlocks(itemLines, depth + 1, ctx));
        current = next;
      }
      blocks.push({
        kind: 'list',
        ordered: marker.bullet === null,
        start: marker.start,
        items,
      });
      continue;
    }

    const align = tableStart(lines, i);
    if (align) {
      const columns = align.length;
      const cellsOf = (row: string): MarkdownInline[][] => {
        const cells = splitTableRow(row).slice(0, columns);
        while (cells.length < columns) cells.push('');
        return cells.map((cell) => parseMarkdownInline(cell));
      };
      const header = cellsOf(line);
      const rows: MarkdownInline[][][] = [];
      i += 2;
      ctx.remaining -= 1;
      while (i < lines.length && ctx.remaining > 0) {
        const row = lines[i]!;
        if (isBlank(row) || !row.includes('|') || startsBlock(lines, i, nested)) break;
        rows.push(cellsOf(row));
        ctx.remaining -= 1;
        i += 1;
      }
      blocks.push({ kind: 'table', align, header, rows });
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i, nested)) {
      paragraph.push(lines[i]!);
      i += 1;
    }
    push({ kind: 'paragraph', inline: paragraphInline(paragraph) });
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

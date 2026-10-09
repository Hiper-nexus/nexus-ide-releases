/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62.
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Upstream reference: apps/web/src/composer-rich-text.ts.
 * Nexus changes: Inline parser/mark vocabulary/span coalescing adapted; Nexus lossless serializer
 * supports literal Windows/UNC/regex/JSON slashes, marker escapes, variable-length literal code
 * delimiters/padding, whitespace/newline and adjacent-style boundaries, verified through actual
 * Tiptap save/remount.
 */
/**
 * Editor rich-text (item T3 "editor Tiptap" / `composer-rich-text.ts` @ 26285ab).
 *
 * O prompt armazenado continua markdown (`**bold**`); a superfície rich-text
 * renderiza com marks. Este módulo traduz entre os dois: parse de markdown em
 * spans marcados e serialização de volta. Deliberadamente pequeno: negrito,
 * itálico, tachado e código inline. Marcadores sem par ficam literais — nada
 * que o usuário digitou se perde.
 *
 * DOM-free: os testes constroem os spans direto. O editor Tiptap entra por
 * cima desta camada (mesmo contrato do upstream).
 */

export type RichTextMark = 'bold' | 'italic' | 'strike' | 'code';

export interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

export const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

function pushSpan(
  spans: RichTextSpan[],
  text: string,
  marks: RichTextMark[],
): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (
    last &&
    last.marks.length === marks.length &&
    last.marks.every((mark, index) => mark === marks[index])
  ) {
    last.text += text;
  } else {
    spans.push({ text, marks });
  }
}

/** Parse the supported inline styles, leaving unmatched and escaped markers literal. */
export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const root: RichTextSpan[] = [];
  const stack: {
    delimiter: string;
    mark: RichTextMark;
    spans: RichTextSpan[];
  }[] = [];
  const current = () => stack.at(-1)?.spans ?? root;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      let end = index;
      while (text[end] === '\\') end += 1;
      const next = text[end];
      if (next !== undefined && /[*`_~]/u.test(next)) {
        const count = end - index;
        pushSpan(current(), '\\'.repeat(Math.floor(count / 2)), []);
        if (count % 2) {
          pushSpan(current(), next, []);
          index = end + 1;
        } else index = end;
      } else {
        pushSpan(current(), text.slice(index, end), []);
        index = end;
      }
      continue;
    }
    if (char === '`') {
      const run = text.slice(index).match(/^`+/)![0];
      const code = readCodeSpan(text, index, run.length);
      if (code) {
        pushSpan(current(), code.content, ['code']);
        index = code.next;
      } else {
        pushSpan(current(), run, []);
        index += run.length;
      }
      continue;
    }
    if (char !== '*' && char !== '_' && char !== '~') {
      pushSpan(current(), char, []);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? '';
    const after = text[end] ?? '';
    const canClose =
      before !== '' &&
      !/\s/.test(before) &&
      (char !== '_' || !/\w/.test(after));
    const canOpen =
      after !== '' &&
      !/\s/.test(after) &&
      (char !== '_' || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      // Inside italic, a double marker opens bold before closing the single
      // marker. Once bold is active, closing runs unwind both styles.
      const opensNestedBold =
        top?.mark === 'italic' &&
        end - index === 2 &&
        canOpen &&
        (char === '*' || char === '_') &&
        !stack.some((frame) => frame.mark === 'bold');
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const span of top.spans)
          pushSpan(current(), span.text, [top.mark, ...span.marks]);
        index += top.delimiter.length;
      } else if (canOpen && (char !== '~' || end - index >= 2)) {
        const length = char === '~' || end - index >= 2 ? 2 : 1;
        const mark =
          char === '~' ? 'strike' : length === 2 ? 'bold' : 'italic';
        // A mark cannot nest inside itself, including alternate delimiters.
        // This bounds the stack to the supported styles for arbitrary input.
        if (stack.some((frame) => frame.mark === mark)) {
          pushSpan(current(), text.slice(index, end), []);
          index = end;
          continue;
        }
        stack.push({
          delimiter: char.repeat(length),
          mark,
          spans: [],
        });
        index += length;
      } else {
        pushSpan(current(), text.slice(index, end), []);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    pushSpan(current(), frame.delimiter, []);
    for (const span of frame.spans)
      pushSpan(current(), span.text, span.marks);
  }
  return root;
}

/** Code contents are literal, including backslashes. Match an exact tick run.
 * One padding space at both edges is removed only for non-space-only content,
 * matching Markdown code-span padding so edge ticks/spaces remain lossless.
 */
function readCodeSpan(text: string, open: number, width: number): {content: string; next: number} | null {
  let index = open + width;
  while (index < text.length && text[index] !== '\n') {
    if (text[index] !== '`') { index += 1; continue; }
    const run = text.slice(index).match(/^`+/)![0];
    if (run.length === width) {
      let content = text.slice(open + width, index);
      if (!content) return null;
      if (content.startsWith(' ') && content.endsWith(' ') && !/^ +$/u.test(content)) content = content.slice(1, -1);
      return {content, next:index + width};
    }
    index += run.length;
  }
  return null;
}

function escapeDelimitedText(text: string): string {
  // Slash runs are escapes only immediately before supported markers;
  // elsewhere they remain literal (Windows/UNC/regex/JSON paths).
  return text.replace(/([\\]*)([*`_~])/gu, (_match, slashes: string, mark: string) => '\\'.repeat(slashes.length * 2 + 1) + mark);
}

function codeDelimitedText(text: string): string {
  const width = (text.match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0) + 1;
  const ticks = '`'.repeat(width);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && !/^ +$/u.test(text));
  return ticks + (pad ? ' ' : '') + text + (pad ? ' ' : '') + ticks;
}

/** Serialize marked spans back to markdown. Nesting: strike > bold > italic > code. */
export function serializeInlineMarkdown(spans: readonly RichTextSpan[]): string {
  const order: RichTextMark[] = ['strike', 'bold', 'italic', 'code'];
  const merged: RichTextSpan[] = [];
  for (const span of spans) pushSpan(merged, span.text, span.marks);
  const fragments: string[] = [];
  for (const span of merged) {
    if (!span.text) continue;
    // Marks do not cross native line breaks. Emphasis applies to the core,
    // leaving edge whitespace literal because its delimiters cannot flank it.
    if (span.text.includes('\n')) {
      fragments.push(span.text.split('\n').map(text => serializeInlineMarkdown([{text,marks:span.marks}])).join('\n'));
      continue;
    }
    const emphasisOnly = !span.marks.includes('code') && span.marks.length > 0;
    const leading = emphasisOnly ? (span.text.match(/^\s*/u)?.[0] ?? '') : '';
    const trailing = emphasisOnly ? (span.text.slice(leading.length).match(/\s*$/u)?.[0] ?? '') : '';
    const core = span.text.slice(leading.length, span.text.length - trailing.length);
    if (!core) { fragments.push(span.text); continue; }
    let body = span.marks.includes('code') ? core : escapeDelimitedText(core);
    if (emphasisOnly) body = body.replace(/\\+$/u, slashes => slashes + slashes);
    // Close innermost first: apply delimiters from innermost mark outward.
    for (const mark of [...order].reverse()) {
      if (!span.marks.includes(mark)) continue;
      if (mark === 'code') { body = codeDelimitedText(body); continue; }
      const delim = RICH_TEXT_DELIMITERS[mark];
      body = `${delim}${body}${delim}`;
    }
    fragments.push(leading + body + trailing);
  }
  return fragments.map((fragment, index) => {
    // A literal slash at a span boundary must not escape the next span's
    // generated opening marker. At EOF/newline it stays completely literal.
    return /^[*`_~]/u.test(fragments[index + 1] ?? '')
      ? fragment.replace(/\\+$/u, slashes => slashes + slashes)
      : fragment;
  }).join('');
}

export function spanText(spans: readonly RichTextSpan[]): string {
  return spans.map((span) => span.text).join('');
}

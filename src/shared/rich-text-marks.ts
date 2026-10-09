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

/** Pontuação ASCII do CommonMark. Letra, dígito e espaço não são escape. */
function isEscapableMarkdownPunctuation(char: string): boolean {
  return /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/.test(char);
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
      const next = text[index + 1];
      // CommonMark só consome a barra antes de pontuação ASCII. `C:\Users`
      // não é escape: a barra fica.
      if (next !== undefined && isEscapableMarkdownPunctuation(next)) {
        pushSpan(current(), next, []);
        index += 2;
      } else {
        pushSpan(current(), '\\', []);
        index += 1;
      }
      continue;
    }
    if (char === '`') {
      // Multi-backtick code stays literal; a single-backtick span owns its contents.
      const run = text.slice(index).match(/^`+/)![0];
      const code = run.length === 1 ? readSingleCodeSpan(text, index) : null;
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

/**
 * A single-backtick span. Escaped backticks stay inside the span; a longer
 * run is not a closer. Empty or unclosed spans stay literal.
 */
function readSingleCodeSpan(
  text: string,
  open: number,
): { content: string; next: number } | null {
  let index = open + 1;
  let content = '';
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\n') return null;
    if (char === '\\' && index + 1 < text.length && text[index + 1] !== '\n') {
      content += text[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      if (text[index + 1] === '`') return null;
      if (content.length === 0) return null;
      return { content, next: index + 1 };
    }
    content += char;
    index += 1;
  }
  return null;
}

function escapeDelimitedText(
  text: string,
  marks: readonly RichTextMark[],
): string {
  const pattern = marks.includes('code') ? /[\\`]/gu : /[\\*`_~]/gu;
  return text.replace(pattern, (char) => `\\${char}`);
}

/** Serialize marked spans back to markdown. Nesting: strike > bold > italic > code. */
export function serializeInlineMarkdown(spans: readonly RichTextSpan[]): string {
  const order: RichTextMark[] = ['strike', 'bold', 'italic', 'code'];
  let out = '';
  for (const span of spans) {
    let body = escapeDelimitedText(span.text, span.marks);
    // Close innermost first: apply delimiters from innermost mark outward.
    for (const mark of [...order].reverse()) {
      if (!span.marks.includes(mark)) continue;
      const delim = RICH_TEXT_DELIMITERS[mark];
      body = `${delim}${body}${delim}`;
    }
    out += body;
  }
  return out;
}

export function spanText(spans: readonly RichTextSpan[]): string {
  return spans.map((span) => span.text).join('');
}

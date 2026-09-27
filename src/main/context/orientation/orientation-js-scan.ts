/**
 * Single-pass JS/TS lexer for the orientation extractors. It only knows what
 * they need — identifiers, quoted strings, template literals and punctuation
 * — and skips comments. Every character is visited a bounded number of times,
 * so the cost is linear in the input no matter how adversarial it is (the
 * regex scanners it replaces could backtrack exponentially).
 *
 * Regex literals are not recognized; a quote inside one may open a bogus
 * string, but ' and " strings stop at the end of the line, which bounds the
 * damage to that line.
 */
export type JsToken =
  | { readonly kind: 'ident'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  /** Template text with every `${...}` replaced by a single `?`. */
  | { readonly kind: 'template'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string };

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

interface TemplateFrame {
  text: string;
  /** Brace depth at which the current `${` expression closes. */
  exprDepth: number;
}

export function scanJsTokens(content: string): readonly JsToken[] {
  const tokens: JsToken[] = [];
  const templates: TemplateFrame[] = [];
  const n = content.length;
  let braceDepth = 0;
  let i = 0;

  // Reads template text from `i` until the closing backtick (emits the
  // token) or a `${` (leaves the frame open for the code loop).
  const continueTemplate = (): void => {
    const frame = templates[templates.length - 1];
    let segmentStart = i;
    while (i < n) {
      const ch = content[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        frame.text += content.slice(segmentStart, i);
        i += 1;
        templates.pop();
        tokens.push({ kind: 'template', value: frame.text });
        return;
      }
      if (ch === '$' && content[i + 1] === '{') {
        frame.text += `${content.slice(segmentStart, i)}?`;
        i += 2;
        frame.exprDepth = braceDepth;
        braceDepth += 1;
        return;
      }
      i += 1;
    }
    frame.text += content.slice(segmentStart, n);
    templates.pop();
    tokens.push({ kind: 'template', value: frame.text });
  };

  while (i < n) {
    const ch = content[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      const end = content.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i + 1;
      i = start;
      while (i < n && content[i] !== ch && content[i] !== '\n') {
        i += content[i] === '\\' ? 2 : 1;
      }
      tokens.push({ kind: 'string', value: content.slice(start, Math.min(i, n)) });
      i += 1;
      continue;
    }
    if (ch === '`') {
      i += 1;
      templates.push({ text: '', exprDepth: -1 });
      continueTemplate();
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && IDENT_PART.test(content[i])) i += 1;
      tokens.push({ kind: 'ident', value: content.slice(start, i) });
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
    } else if (ch === '}') {
      braceDepth -= 1;
      const frame = templates[templates.length - 1];
      if (frame && frame.exprDepth === braceDepth) {
        frame.exprDepth = -1;
        i += 1;
        continueTemplate();
        continue;
      }
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  // Unterminated `${` at EOF: flush what was collected.
  while (templates.length > 0) {
    tokens.push({ kind: 'template', value: templates.pop()!.text });
  }
  return tokens;
}

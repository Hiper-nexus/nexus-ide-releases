/**
 * JSONC (JSON com comentários e vírgula final), o formato de tsconfig e dos
 * temas do VS Code. Puro: sem node builtins, serve ao main e ao renderer.
 */

/** Strip `//` and `/* *‍/` comments from JSONC while leaving string contents intact. */
function stripJsonComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        out += c;
        i += 1;
        if (c === '\\' && i < n) {
          out += source[i];
          i += 1;
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function parseJsonc(source: string): unknown {
  const withoutComments = stripJsonComments(source);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

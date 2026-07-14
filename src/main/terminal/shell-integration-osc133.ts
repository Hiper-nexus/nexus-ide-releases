/**
 * Tolerant OSC 133 shell-integration parser (clean-room).
 * Raw PTY bytes remain the visual source of truth; this only emits semantics.
 *
 * Spec reference (public):
 * - OSC 133 ; A ST  — prompt start
 * - OSC 133 ; B ST  — command start
 * - OSC 133 ; C ST  — command executed
 * - OSC 133 ; D ; <exit> ST — command finished
 * - OSC 133 ; P ; cwd=<path> ST — property (cwd)
 *
 * Also accepts BEL-terminated OSC and OSC 7 / OSC 9;9 cwd variants used by
 * some terminals. Shells without integration never emit sequences → no-op.
 */

export type Osc133Event =
  | { readonly kind: 'prompt_start' }
  | { readonly kind: 'command_start' }
  | { readonly kind: 'command_executed' }
  | {
      readonly kind: 'command_finished';
      readonly exitCode: number | undefined;
    }
  | { readonly kind: 'cwd'; readonly path: string }
  | { readonly kind: 'command_line'; readonly command: string };

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

/** Max buffered incomplete sequence to avoid unbounded growth. */
const MAX_PARTIAL = 4096;

/**
 * Stateful scanner over a stream of PTY chunks. Safe if sequences never appear.
 */
export class Osc133Scanner {
  #partial = '';

  push(chunk: string): Osc133Event[] {
    const events: Osc133Event[] = [];
    let data = this.#partial + chunk;
    this.#partial = '';

    let i = 0;
    while (i < data.length) {
      const esc = data.indexOf(ESC, i);
      if (esc < 0) break;

      // OSC: ESC ]
      if (data[esc + 1] !== ']') {
        i = esc + 1;
        continue;
      }

      const bodyStart = esc + 2;
      const bel = data.indexOf(BEL, bodyStart);
      const st = data.indexOf(ST, bodyStart);
      let end = -1;
      let endLen = 0;
      if (bel >= 0 && (st < 0 || bel < st)) {
        end = bel;
        endLen = 1;
      } else if (st >= 0) {
        end = st;
        endLen = 2;
      }

      if (end < 0) {
        // Incomplete sequence — keep tail.
        const tail = data.slice(esc);
        this.#partial =
          tail.length > MAX_PARTIAL ? tail.slice(-MAX_PARTIAL) : tail;
        break;
      }

      const body = data.slice(bodyStart, end);
      const event = parseOscBody(body);
      if (event) events.push(event);
      i = end + endLen;
    }

    // Drop consumed prefix when we finished mid-scan without partial.
    if (this.#partial === '' && i > 0 && i < data.length) {
      // leftover plain text ignored for semantics
    }
    return events;
  }

  reset(): void {
    this.#partial = '';
  }
}

function parseOscBody(body: string): Osc133Event | null {
  // 133;A | 133;B | 133;C | 133;D;code | 133;P;k=v | 133;E;cmdline
  if (body.startsWith('133;')) {
    const rest = body.slice(4);
    const semi = rest.indexOf(';');
    const code = semi >= 0 ? rest.slice(0, semi) : rest;
    const arg = semi >= 0 ? rest.slice(semi + 1) : '';

    switch (code) {
      case 'A':
        return { kind: 'prompt_start' };
      case 'B':
        return { kind: 'command_start' };
      case 'C':
        return { kind: 'command_executed' };
      case 'D': {
        if (arg === '') return { kind: 'command_finished', exitCode: undefined };
        const exitCode = Number.parseInt(arg, 10);
        return {
          kind: 'command_finished',
          exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
        };
      }
      case 'P': {
        const cwdMatch = /(?:^|;)cwd=([^\x07;]+)/i.exec(arg);
        if (cwdMatch?.[1]) {
          return { kind: 'cwd', path: decodeOscPath(cwdMatch[1]) };
        }
        return null;
      }
      case 'E':
        return { kind: 'command_line', command: decodeOscPath(arg) };
      default:
        return null;
    }
  }

  // OSC 7 ; file://host/path
  if (body.startsWith('7;')) {
    const path = parseFileUrlPath(body.slice(2));
    return path ? { kind: 'cwd', path } : null;
  }

  // OSC 9 ; 9 ; path  (iTerm/fish style sometimes)
  if (body.startsWith('9;9;')) {
    const path = decodeOscPath(body.slice(4));
    return path ? { kind: 'cwd', path } : null;
  }

  return null;
}

function decodeOscPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseFileUrlPath(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  } catch {
    // file:///Users/... without full URL parse
    const stripped = url.replace(/^file:\/\/[^/]*/, '');
    return stripped ? decodeOscPath(stripped) : null;
  }
}

/** Validate cwd from OSC before trusting it for persistence. */
export function isSafeOscCwd(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.includes('\0')) return false;
  // Absolute only — reject relative and home-tilde for fail-closed.
  if (!(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path))) return false;
  return true;
}

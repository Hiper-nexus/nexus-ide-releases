// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: history helpers of
// apps/server/src/terminal/Manager.ts lifted out of the Effect PTY manager into
// a pure module; sanitizeTerminalHistoryChunk exported as
// sanitizeTerminalReplayChunk plus a stateful createReplaySanitizer() wrapper
// with a cap on the held sequence; OSC 4 palette queries stripped too (xterm.js
// answers them); plain-text runs copied in one slice instead of per character.

/**
 * Replay sanitizer (DSK-01).
 *
 * Output that is written into a terminal AGAIN — the adoption repaint tape, a
 * hibernated pane's retained output, the adoption replay — may carry terminal
 * queries (DA1/DA2, DSR/CPR, DECRQM, DECRQSS, XTVERSION, kitty `?u`, OSC
 * 4/10/11/12). A fresh xterm answers them through `term.onData`, the same
 * channel as typing, so the answer reaches the PTY as late junk at the shell
 * prompt or as keystrokes inside a TUI. Replies stored in old output are
 * dropped for the same reason: they have no visual value.
 *
 * Only replayed output goes through here. Live PTY output stays raw: a TUI that
 * asks NOW needs the answer now.
 */

/**
 * Longest escape sequence held back waiting for its terminator. Queries are a
 * few dozen characters; anything longer (sixel, OSC 52, binary noise opening an
 * OSC) is released as-is so an unterminated string cannot swallow later output.
 */
export const MAX_PENDING_CONTROL_SEQUENCE_CHARS = 4_096;

export interface TerminalReplayChunk {
  visibleText: string;
  pendingControlSequence: string;
}

export interface TerminalReplaySanitizer {
  /** Replay-safe text of `data`; a sequence cut by the chunk edge waits. */
  push(data: string): string;
  /** Sequence cut by the last chunk edge, still waiting to be classified. */
  readonly pendingControlSequence: string;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === 'n') {
    return true;
  }
  if (finalByte === 'R' && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === 'c' && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === 'p' || finalByte === 'y') && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === 'q' && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === 'u' && body.startsWith('?')) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  if (/^(10|11|12);(?:\?|rgb:)/.test(content)) {
    return true;
  }
  // Nexus: OSC 4 palette queries (4;<index>;?) are answered by xterm.js too.
  // Palette setters (4;<index>;<color>) keep their visual value.
  if (content.startsWith('4;')) {
    const slots = content.slice(2).split(';');
    for (let index = 1; index < slots.length; index += 2) {
      if (slots[index] === '?') return true;
    }
  }
  return false;
}

function stripStringTerminator(value: string): string {
  if (value.endsWith('\u001b\\')) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === '\u0007' || lastCharacter === '\u009c') {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

/** ESC plus the 8-bit C1 introducers the loop below classifies. */
function startsControlSequence(codePoint: number): boolean {
  return (
    codePoint === 0x1b ||
    codePoint === 0x9b ||
    codePoint === 0x9d ||
    codePoint === 0x90 ||
    codePoint === 0x9e ||
    codePoint === 0x9f
  );
}

/**
 * Pure step: `pendingControlSequence` from the previous chunk + `data` in,
 * replay-safe text and the still-incomplete tail out.
 */
export function sanitizeTerminalReplayChunk(
  pendingControlSequence: string,
  data: string,
): TerminalReplayChunk {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = '';
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? '')) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? '')) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    // Nexus: copy the whole plain-text run up to the next introducer at once.
    let runEnd = index + 1;
    while (runEnd < input.length && !startsControlSequence(input.charCodeAt(runEnd))) {
      runEnd += 1;
    }
    append(input.slice(index, runEnd));
    index = runEnd;
  }

  return { visibleText, pendingControlSequence: '' };
}

/**
 * Stateful wrapper for one replayed stream: carries a sequence cut by a chunk
 * edge into the next chunk, so a query split across PTY reads is still caught.
 */
export function createReplaySanitizer(): TerminalReplaySanitizer {
  let pendingControlSequence = '';
  return {
    push(data) {
      const chunk = sanitizeTerminalReplayChunk(pendingControlSequence, data);
      if (chunk.pendingControlSequence.length > MAX_PENDING_CONTROL_SEQUENCE_CHARS) {
        pendingControlSequence = '';
        return chunk.visibleText + chunk.pendingControlSequence;
      }
      pendingControlSequence = chunk.pendingControlSequence;
      return chunk.visibleText;
    },
    get pendingControlSequence() {
      return pendingControlSequence;
    },
  };
}

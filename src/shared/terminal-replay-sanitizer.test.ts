// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: the four history
// cases of apps/server/src/terminal/Manager.test.ts drive the pure sanitizer
// chunk by chunk (no Effect, no PTY manager); added 8-bit C1 CSI/DCS/OSC, OSC 4
// palette queries, the pending-sequence cap and the one-shot helper.
import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_CONTROL_SEQUENCE_CHARS,
  createReplayOutputFilter,
  createReplaySanitizer,
  sanitizeTerminalReplayChunk,
} from './terminal-replay-sanitizer';

/** Feeds chunks as the PTY delivered them and returns what is safe to replay. */
function replay(...chunks: string[]): string {
  const sanitizer = createReplaySanitizer();
  return chunks.map((chunk) => sanitizer.push(chunk)).join('');
}

describe('createReplaySanitizer (ported from t3code Manager history)', () => {
  it('strips replay-unsafe terminal query and reply sequences', () => {
    expect(
      replay(
        'prompt ',
        '\x1b[32mok\x1b[0m ',
        '\x1b]11;rgb:ffff/ffff/ffff\x07',
        '\x1b[1;1R',
        'done\n',
      ),
    ).toBe('prompt \x1b[32mok\x1b[0m done\n');
  });

  it('strips replayable CSI and DCS traffic while preserving setters', () => {
    expect(
      replay(
        'prompt ',
        // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
        '\x1b[?2026$p\x1b[?2026;2$y\x1b[>q\x1b[?u\x1b[?31u',
        // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
        '\x1bP$q m\x1b\\\x1bP1$r0m\x1b\\',
        '\x1bP+q544e\x1b\\\x1bP1+r544e=1b\x1b\\',
        // The same DCS traffic in 8-bit form.
        '\x90$q m\x9c\x901$r0m\x9c',
        '\x90+q544e\x9c\x901+r544e=1b\x9c',
        // Setters and cursor movement share final bytes with query families but
        // have visible terminal-state value and must survive replay.
        '\x1b[!p\x1b["p\x1b[4 q\x1b[u',
        'done\n',
      ),
    ).toBe('prompt \x1b[!p\x1b["p\x1b[4 q\x1b[udone\n');
  });

  it('handles CSI and DCS query sequences split across output chunks', () => {
    expect(
      replay(
        'before ',
        '\x1b[?2026$',
        'pafter ',
        '\x1bP$q ',
        'm\x1b',
        '\\after ',
        '\x9b?3',
        '1uafter ',
        '\x90+q544e',
        '\x9cafter\n',
      ),
    ).toBe('before after after after after\n');
  });

  it('preserves clear and style control sequences while dropping chunk-split query traffic', () => {
    expect(
      replay(
        'before clear\n',
        '\x1b[H\x1b[2J',
        'prompt ',
        '\x1b]11;',
        'rgb:ffff/ffff/ffff\x07\x1b[1;1',
        'R\x1b[36mdone\x1b[0m\n',
      ),
    ).toBe('before clear\n\x1b[H\x1b[2Jprompt \x1b[36mdone\x1b[0m\n');
  });
});

describe('createReplaySanitizer — Nexus additions', () => {
  it('strips the DSK-01 query set that xterm answers (DA1, CPR, DA2, DECRQM, OSC 11)', () => {
    expect(
      replay('hello\r\n\x1b[c\x1b[6n\x1b[>c\x1b[?2004$p\x1b]11;?\x07'),
    ).toBe('hello\r\n');
  });

  it('strips 8-bit C1 queries (0x9b CSI, 0x90 DCS, 0x9d OSC) and keeps 8-bit setters', () => {
    expect(
      replay(
        'a\x9bc\x9b6n\x9b>c\x9b?2004$p',
        'b\x90$q m\x9c',
        'c\x9d11;?\x07\x9d10;?\x9c',
        // Visible 8-bit traffic survives: SGR and a window title.
        '\x9b31mred\x9d0;title\x07',
      ),
    ).toBe('abc\x9b31mred\x9d0;title\x07');
  });

  it('holds 8-bit C1 queries split across chunks until they can be classified', () => {
    expect(replay('x\x9b', '6ny\x9d11', ';?\x9cz')).toBe('xyz');
  });

  it('strips OSC 4 palette queries but keeps palette setters', () => {
    expect(
      replay('\x1b]4;1;?\x07', '\x1b]4;2;rgb:00/00/00;3;?\x1b\\', '\x1b]4;1;#ff0000\x07'),
    ).toBe('\x1b]4;1;#ff0000\x07');
  });

  it('exposes the incomplete sequence it is holding for the next chunk', () => {
    const sanitizer = createReplaySanitizer();
    expect(sanitizer.push('ok\x1b]11;')).toBe('ok');
    expect(sanitizer.pendingControlSequence).toBe('\x1b]11;');
    expect(sanitizer.push('?\x07done')).toBe('done');
    expect(sanitizer.pendingControlSequence).toBe('');
  });

  it('releases an unterminated sequence past the cap instead of buffering forever', () => {
    const sanitizer = createReplaySanitizer();
    const runaway = `\x1b]0;${'x'.repeat(MAX_PENDING_CONTROL_SEQUENCE_CHARS)}`;
    // Binary noise opening an OSC must not swallow every later byte.
    expect(sanitizer.push(runaway)).toBe(runaway);
    expect(sanitizer.pendingControlSequence).toBe('');
    expect(sanitizer.push('after')).toBe('after');
  });

  it('one-shot helper reports what is still pending', () => {
    expect(sanitizeTerminalReplayChunk('', 'a\x1b[6')).toEqual({
      visibleText: 'a',
      pendingControlSequence: '\x1b[6',
    });
    expect(sanitizeTerminalReplayChunk('\x1b[6', 'nb')).toEqual({
      visibleText: 'b',
      pendingControlSequence: '',
    });
  });

  it('passes plain text and ordinary escape sequences through untouched', () => {
    const tui = 'é😀 \x1b[?1049h\x1b[2;5H\x1b[1;38;5;208mtext\x1b(B\x1b7\x1b8\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\';
    expect(replay(tui)).toBe(tui);
  });
});

describe('createReplayOutputFilter — replayed and live chunks on one subscription', () => {
  it('sanitizes only replayed chunks; live output passes raw', () => {
    const filter = createReplayOutputFilter();
    expect(filter('a\x1b[6n', true)).toBe('a');
    // A TUI asking NOW needs the answer now.
    expect(filter('\x1b[6n\x1b[c\x1b[?u', false)).toBe('\x1b[6n\x1b[c\x1b[?u');
    expect(filter('b\x1b]11;?\x07', true)).toBe('b');
  });

  it('hands a sequence left open by the replay to the live chunk that completes it', () => {
    const filter = createReplayOutputFilter();
    expect(filter('x\x1b[3', true)).toBe('x');
    expect(filter('1mred', false)).toBe('\x1b[31mred');
    expect(filter('plain', false)).toBe('plain');
  });
});

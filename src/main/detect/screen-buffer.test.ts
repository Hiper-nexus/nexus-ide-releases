import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GhosttyRuntime } from './ghostty-runtime';
import { GhosttyScreen } from './ghostty-screen';
import {
  clampClusterExtenders,
  createDetectorScreenSource,
  GHOSTTY_MAX_CLUSTER_EXTENDERS,
  GhosttyScreenBuffer,
  SessionScreenBuffer,
  type GhosttyFallbackReason,
} from './screen-buffer';

describe('SessionScreenBuffer', () => {
  it('strips ANSI and keeps plain text', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', '\x1b[1;32mgreen\x1b[0m plain\r\nnext');
    expect(buffer.text('s')).toBe('green plain\nnext');
    expect(buffer.contentSeq('s')).toBe(1);
  });

  it('rejoins an OSC sequence split across chunks', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'text\x1b]0;partial ti');
    expect(buffer.text('s')).toBe('text');
    buffer.append('s', 'tle\x07rest');
    expect(buffer.text('s')).toBe('textrest');
  });

  it('rejoins a CSI sequence split across chunks', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'a\x1b[1;');
    expect(buffer.text('s')).toBe('a');
    buffer.append('s', '32mb');
    expect(buffer.text('s')).toBe('ab');
  });

  it('F-1406: strips private-parameter CSI (Codex 0.162 XTMODKEYS/kitty) as text', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', '\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h>_ OpenAI Codex');
    expect(buffer.text('s')).toBe('>_ OpenAI Codex');
  });

  it('F-1406: holds a private-parameter CSI split across chunks, never emits its body', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'boot\x1b[>4;0');
    expect(buffer.text('s')).toBe('boot');
    buffer.append('s', 'm\x1b[>7u>_ OpenAI Codex');
    expect(buffer.text('s')).toBe('boot>_ OpenAI Codex');
  });

  it('does not bump contentSeq for pure escape traffic', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'visible');
    const seq = buffer.contentSeq('s');
    buffer.append('s', '\x1b]0;title\x07\x1b[2K');
    expect(buffer.contentSeq('s')).toBe(seq);
  });

  it('strips complete trailing escapes without lagging the text', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'done\x1b[0m');
    expect(buffer.text('s')).toBe('done');
  });

  it('caps the retained tail', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'x'.repeat(300_000));
    expect(buffer.text('s').length).toBeLessThanOrEqual(262_144);
  });

  it('keeps state per session and drops it', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('a', 'aaa');
    buffer.append('b', 'bbb');
    buffer.drop('a');
    expect(buffer.text('a')).toBe('');
    expect(buffer.text('b')).toBe('bbb');
  });
});

describe('SessionScreenBuffer.tail (F-764 C.3)', () => {
  it('devolve tudo quando o texto cabe na janela', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'a\nb\n');
    buffer.append('s', 'c');
    expect(buffer.tail('s', 100)).toBe('a\nb\nc');
    expect(buffer.tail('nada', 100)).toBe('');
  });

  it('corta no início de uma linha inteira e junta só os chunks do fim', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'linha-velha-1\n');
    buffer.append('s', 'linha-velha-2\n');
    buffer.append('s', 'nova\nfim');
    // 12 caracteres pegam "a-2\nnova\nfim": a linha cortada sai.
    expect(buffer.tail('s', 12)).toBe('nova\nfim');
    expect(buffer.text('s')).toBe('linha-velha-1\nlinha-velha-2\nnova\nfim');
  });

  it('linha única maior que a janela: devolve o fim dela', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'x'.repeat(50));
    expect(buffer.tail('s', 10)).toBe('x'.repeat(10));
  });
});

const WASM = path.resolve(__dirname, '../../../resources/ghostty/ghostty-vt.wasm');
/** Private instance per test: traps and budgets must not leak into others. */
const freshRuntime = () => GhosttyRuntime.fromBytes(new Uint8Array(fs.readFileSync(WASM)));

describe('GhosttyScreenBuffer (libghostty-vt grid, DSK-03)', () => {
  it('a redraw in place moves contentSeq; escape-only traffic does not', () => {
    const buffer = new GhosttyScreenBuffer(freshRuntime());
    const first = buffer.append('s', '\x1b[1mready>\x1b[0m ');
    const seq = buffer.contentSeq('s');
    expect(first).not.toBe(0);
    expect(seq).toBeGreaterThan(0);
    expect(buffer.text('s')).toBe('ready>');
    // The write may have changed the screen: never equal to the last scan.
    expect(buffer.append('s', '\x1b]0;new title\x07\x1b[?25l')).not.toBe(seq);
    expect(buffer.contentSeq('s')).toBe(seq);
    buffer.append('s', '\r\x1b[2Kworking...');
    expect(buffer.contentSeq('s')).toBe(seq + 1);
    expect(buffer.tail('s', 100)).toBe('working...');
  });

  it('sizes the grid from resize before the first byte', () => {
    const buffer = new GhosttyScreenBuffer(freshRuntime());
    buffer.resize('s', 30, 3);
    for (let line = 1; line <= 10; line += 1) buffer.append('s', `line ${line}\r\n`);
    expect(buffer.text('s')).toBe('line 9\nline 10');
  });

  it('sessions without a manifest stay on the stripped-text stream', () => {
    const runtime = freshRuntime();
    const buffer = new GhosttyScreenBuffer(runtime, { eligible: (id) => id === 'agent' });
    buffer.append('shell', '\x1b[32mls\x1b[0m\r\nfile\r\n');
    buffer.append('agent', 'hello');
    expect(buffer.hasGrid('shell')).toBe(false);
    expect(buffer.text('shell')).toBe('ls\nfile\n');
    expect(buffer.hasGrid('agent')).toBe(true);
    expect(runtime.liveTerminals).toBe(1);
  });

  it('a session that becomes eligible later moves to a fresh grid', () => {
    let eligible = false;
    const buffer = new GhosttyScreenBuffer(freshRuntime(), { eligible: () => eligible });
    buffer.append('s', 'before binding\n');
    const textSeq = buffer.contentSeq('s');
    eligible = true;
    buffer.append('s', 'after');
    expect(buffer.hasGrid('s')).toBe(true);
    expect(buffer.text('s')).toBe('after');
    expect(buffer.contentSeq('s')).toBeGreaterThan(textSeq);
  });

  it('falls back per session past the terminal cap and the memory ceiling', () => {
    const reasons: GhosttyFallbackReason[] = [];
    const capped = new GhosttyScreenBuffer(freshRuntime(), {
      maxTerminals: 1,
      onFallback: (reason) => reasons.push(reason),
    });
    capped.append('a', 'grid');
    capped.append('b', 'text\r\n');
    capped.append('c', 'text too');
    expect(capped.hasGrid('a')).toBe(true);
    expect(capped.hasGrid('b')).toBe(false);
    expect(capped.text('b')).toBe('text\n');
    const starved = new GhosttyScreenBuffer(freshRuntime(), {
      maxMemoryBytes: 1,
      onFallback: (reason) => reasons.push(reason),
    });
    starved.append('a', 'text');
    expect(starved.hasGrid('a')).toBe(false);
    expect(starved.text('a')).toBe('text');
    // Once per reason per buffer, never per chunk.
    expect(reasons).toEqual(['session-cap', 'memory-budget']);
  });

  it('drop frees the session terminal', () => {
    const runtime = freshRuntime();
    const buffer = new GhosttyScreenBuffer(runtime);
    buffer.append('a', 'x');
    buffer.append('b', 'y');
    expect(runtime.liveTerminals).toBe(2);
    buffer.drop('a');
    expect(runtime.liveTerminals).toBe(1);
    expect(buffer.text('a')).toBe('');
    expect(buffer.contentSeq('a')).toBe(0);
  });

  it('a wasm trap moves every session to the text stream and poisons the instance', () => {
    const runtime = freshRuntime();
    const reasons: Array<[GhosttyFallbackReason, string]> = [];
    const buffer = new GhosttyScreenBuffer(runtime, {
      onFallback: (reason, detail) => reasons.push([reason, detail]),
    });
    buffer.append('a', 'grid a');
    buffer.append('b', 'grid b');
    const seq = buffer.contentSeq('a');
    const call = runtime.call.bind(runtime);
    runtime.call = (name, ...args) => {
      if (name === 'ghostty_terminal_vt_write') throw new WebAssembly.RuntimeError('unreachable');
      return call(name, ...args);
    };
    buffer.append('a', 'after trap');
    expect(runtime.broken).toBe(true);
    expect(buffer.hasGrid('a')).toBe(false);
    expect(buffer.hasGrid('b')).toBe(false);
    expect(buffer.text('a')).toBe('after trap');
    expect(buffer.contentSeq('a')).toBeGreaterThan(seq);
    buffer.append('c', 'new session');
    expect(buffer.hasGrid('c')).toBe(false);
    expect(reasons).toEqual([['runtime-trap', 'RuntimeError']]);
  });
});


const MiB = 2 ** 20;
const memoryOf = (buffer: GhosttyScreenBuffer) => buffer.runtime.memory.buffer.byteLength;

describe('GhosttyScreenBuffer — wasm memory budget after attach (revisão DSK-03)', () => {
  /** One grapheme cluster that never ends, in the 16K-char pieces the core feeds. */
  const markFlood = '́'.repeat(16_384);
  const flood = (buffer: GhosttyScreenBuffer, id: string) => {
    for (let chunk = 0; chunk < 64 && buffer.hasGrid(id); chunk += 1) buffer.append(id, markFlood);
  };

  it('a session whose output keeps growing wasm memory leaves the grid; its neighbour stays', () => {
    const runtime = freshRuntime();
    const reasons: Array<[GhosttyFallbackReason, string]> = [];
    const buffer = new GhosttyScreenBuffer(runtime, {
      maxSessionGrowthBytes: 4 * MiB,
      // Generic budget under test: let the flood reach the wasm unclamped.
      maxClusterExtenders: Number.POSITIVE_INFINITY,
      onFallback: (reason, detail) => reasons.push([reason, detail]),
    });
    buffer.append('calm', 'neighbour');
    buffer.append('s', 'e');
    const attached = runtime.memory.buffer.byteLength;
    flood(buffer, 's');
    expect(buffer.hasGrid('s')).toBe(false);
    expect(buffer.hasGrid('calm')).toBe(true);
    expect(runtime.liveTerminals).toBe(1);
    expect(reasons).toEqual([['memory-budget', expect.stringMatching(/^session-growth=\d+$/)]]);
    expect(runtime.memory.buffer.byteLength - attached).toBeLessThan(32 * MiB);
    expect(buffer.text('calm')).toBe('neighbour');
  }, 60_000);

  // Rewritten (revisão 2, achado 1): this used to assert that once the linear
  // memory had passed the ceiling no new grid could ever start — a lockout,
  // since WebAssembly.Memory never shrinks and nothing rebuilt the instance.
  it('a peak past the ceiling is given back: the instance is rebuilt and new sessions still get a grid', () => {
    const runtime = freshRuntime();
    const reasons: Array<[GhosttyFallbackReason, string]> = [];
    const buffer = new GhosttyScreenBuffer(runtime, {
      maxMemoryBytes: 16 * MiB,
      maxSessionGrowthBytes: Number.POSITIVE_INFINITY,
      maxClusterExtenders: Number.POSITIVE_INFINITY,
      onFallback: (reason, detail) => reasons.push([reason, detail]),
    });
    buffer.append('s', 'e');
    expect(runtime.memory.buffer.byteLength).toBeLessThan(16 * MiB);
    flood(buffer, 's');
    // The grid that grew past the ceiling yields it…
    expect(buffer.hasGrid('s')).toBe(false);
    expect(runtime.memory.buffer.byteLength).toBeGreaterThanOrEqual(16 * MiB);
    // …and the peak no live grid justifies does not outlive it.
    expect(memoryOf(buffer)).toBeLessThan(4 * MiB);
    buffer.append('late', 'text');
    expect(buffer.hasGrid('late')).toBe(true);
    expect(buffer.text('late')).toBe('text');
    expect(reasons.map(([reason]) => reason)).toEqual(['memory-budget', 'runtime-recycled']);
  }, 60_000);

  it('the reviewer scenario at production budget: grids growing together never lock new or rebound sessions out', () => {
    const buffer = new GhosttyScreenBuffer(freshRuntime(), {
      // Growth source independent of the clamp: unbounded mark clusters.
      maxClusterExtenders: Number.POSITIVE_INFINITY,
    });
    const ids = Array.from({ length: 32 }, (_, index) => `pane-${index}`);
    for (const id of ids) buffer.append(id, 'e');
    const attached = memoryOf(buffer);
    let peak = attached;
    // Round-robin so every grid grows a little at a time, as busy panes do.
    const piece = '́'.repeat(4_096);
    for (let round = 0; round < 4; round += 1) {
      for (const id of ids) {
        buffer.append(id, piece);
        peak = Math.max(peak, memoryOf(buffer));
      }
    }
    const survivors = ids.filter((id) => buffer.hasGrid(id)).length;
    for (const id of ids) buffer.drop(id);
    const settled = memoryOf(buffer);
    buffer.append('new-pane', 'fresh');
    buffer.append(ids[0], 'rebound');
    console.log(
      `PROOF lockout: attached=${(attached / MiB).toFixed(1)}MiB peak=${(peak / MiB).toFixed(1)}MiB survivors=${survivors} ` +
        `afterDrop=${(settled / MiB).toFixed(1)}MiB newGrid=${buffer.hasGrid('new-pane')} reboundGrid=${buffer.hasGrid(ids[0])}`,
    );
    expect(buffer.hasGrid('new-pane')).toBe(true);
    expect(buffer.hasGrid(ids[0])).toBe(true);
    expect(buffer.text('new-pane')).toBe('fresh');
    expect(settled).toBeLessThan(64 * MiB);
    expect(peak).toBeLessThan(256 * MiB + 32 * MiB);
  }, 120_000);

  it('a session past the terminal cap waits on text and gets a grid when one leaves', () => {
    const buffer = new GhosttyScreenBuffer(freshRuntime(), { maxTerminals: 1 });
    buffer.append('a', 'grid');
    buffer.append('b', 'waiting');
    expect(buffer.hasGrid('b')).toBe(false);
    buffer.drop('a');
    buffer.append('b', '\x1b[2J\x1b[Hnow a grid');
    expect(buffer.hasGrid('b')).toBe(true);
    expect(buffer.text('b')).toBe('now a grid');
  });

  it('recycling keeps every live screen: same text, same cursor, the next relative redraw lands in place', () => {
    const reasons: GhosttyFallbackReason[] = [];
    const buffer = new GhosttyScreenBuffer(freshRuntime(), {
      maxMemoryBytes: 32 * MiB,
      maxSessionGrowthBytes: Number.POSITIVE_INFINITY,
      maxClusterExtenders: Number.POSITIVE_INFINITY,
      onFallback: (reason) => reasons.push(reason),
    });
    const control = new GhosttyScreenBuffer(freshRuntime());
    const frames: Record<string, string> = {
      // Styled lines, a soft-wrapped line, a hyperlink, the cursor mid-screen.
      tui: `\x1b[1;31mred\x1b[0m line\r\n${'L'.repeat(70)}\r\n\x1b]8;;http://x\x07link\x1b]8;;\x07\r\n> prompt here\x1b[5;12H\x1b[4m`,
      // A scroll region homes the cursor in the replay; it must still land here.
      region: 'top\r\n\x1b[2;8rinside\x1b[6;3H',
      alt: 'primary\r\n\x1b[?1049h\x1b[2J\x1b[Halt screen tui\x1b[3;5H',
    };
    for (const [id, frame] of Object.entries(frames)) {
      buffer.resize(id, 40, 10);
      control.resize(id, 40, 10);
      buffer.append(id, frame);
      control.append(id, frame);
    }
    const before = buffer.runtime;
    const seq = buffer.contentSeq('tui');
    buffer.append('flood', 'e');
    for (let chunk = 0; chunk < 8 && buffer.hasGrid('flood'); chunk += 1) buffer.append('flood', '́'.repeat(16_384));
    expect(buffer.hasGrid('flood')).toBe(false);
    // Identity only: not.toBe's diff hint deep-reads the old instance, whose memory is gone.
    expect(buffer.runtime === before).toBe(false);
    expect(reasons).toContain('runtime-recycled');
    expect(memoryOf(buffer)).toBeLessThan(32 * MiB);
    for (const id of Object.keys(frames)) {
      expect(buffer.hasGrid(id)).toBe(true);
      expect(buffer.text(id)).toBe(control.text(id));
    }
    // Same screen: the detector sees no change from the move itself.
    expect(buffer.contentSeq('tui')).toBe(seq);
    const redraw = 'Z\x1b[2A\r\x1b[2Kredrawn\x1b[1Bok';
    for (const id of Object.keys(frames)) {
      buffer.append(id, redraw);
      control.append(id, redraw);
      expect(buffer.text(id)).toBe(control.text(id));
    }
  }, 60_000);
});

describe('GhosttyScreenBuffer — grid size priced by measured cost (revisão 2, achado 9)', () => {
  it('large real terminals keep their grid at production defaults', () => {
    // 4K screens with small fonts, tall splits: all accepted by validAnalysisGrid.
    for (const [cols, rows] of [[640, 180], [334, 300], [250, 401], [1000, 500]]) {
      const reasons: GhosttyFallbackReason[] = [];
      const buffer = new GhosttyScreenBuffer(freshRuntime(), { onFallback: (reason) => reasons.push(reason) });
      buffer.append('s', 'grid');
      buffer.resize('s', cols, rows);
      buffer.append('s', '\x1b[2J\x1b[Hrepainted');
      expect([cols, rows, buffer.hasGrid('s')]).toEqual([cols, rows, true]);
      expect(buffer.text('s')).toBe('repainted');
      const fresh = new GhosttyScreenBuffer(freshRuntime());
      fresh.resize('s', cols, rows);
      fresh.append('s', 'born large');
      expect([cols, rows, fresh.hasGrid('s')]).toEqual([cols, rows, true]);
      expect(reasons).toEqual([]);
    }
  });

  it('32 panes at 640×180 all get a grid under the ceiling', () => {
    const buffer = new GhosttyScreenBuffer(freshRuntime());
    for (let index = 0; index < 32; index += 1) {
      buffer.resize(`p${index}`, 640, 180);
      buffer.append(`p${index}`, `${'x'.repeat(639)}\r\n`.repeat(180));
    }
    const grids = Array.from({ length: 32 }, (_, index) => buffer.hasGrid(`p${index}`)).filter(Boolean).length;
    console.log(`PROOF 32x640x180 filled: grids=${grids} memory=${(memoryOf(buffer) / MiB).toFixed(1)}MiB`);
    expect(grids).toBe(32);
    expect(memoryOf(buffer)).toBeLessThan(256 * MiB);
  });

  it('1000×500 grids are admitted while their reservation fits; the rest wait on text, not forever', () => {
    const reasons: Array<[GhosttyFallbackReason, string]> = [];
    const buffer = new GhosttyScreenBuffer(freshRuntime(), { onFallback: (reason, detail) => reasons.push([reason, detail]) });
    const ids = Array.from({ length: 32 }, (_, index) => `big-${index}`);
    for (const id of ids) {
      buffer.resize(id, 1000, 500);
      buffer.append(id, `${'y'.repeat(999)}\r\n`.repeat(500));
    }
    const withGrid = ids.filter((id) => buffer.hasGrid(id));
    console.log(`PROOF 32x1000x500 filled: grids=${withGrid.length} memory=${(memoryOf(buffer) / MiB).toFixed(1)}MiB reasons=${JSON.stringify(reasons)}`);
    expect(withGrid.length).toBe(18);
    expect(memoryOf(buffer)).toBeLessThanOrEqual(256 * MiB);
    expect(reasons).toEqual([['memory-budget', expect.stringMatching(/^reserved=\d+$/)]]);
    const waiting = ids.find((id) => !buffer.hasGrid(id))!;
    buffer.drop(withGrid[0]);
    buffer.append(waiting, '\x1b[2J\x1b[Hmy turn');
    expect(buffer.hasGrid(waiting)).toBe(true);
    expect(buffer.text(waiting)).toBe('my turn');
    // A waiting session that shrinks fits too.
    const other = ids.find((id) => !buffer.hasGrid(id))!;
    buffer.resize(other, 200, 50);
    buffer.append(other, 'smaller');
    expect(buffer.hasGrid(other)).toBe(false);
    buffer.drop(withGrid[1]);
    buffer.append(other, 'smaller');
    expect(buffer.hasGrid(other)).toBe(true);
  }, 60_000);
});

describe('grapheme cluster clamp (revisão DSK-03)', () => {
  const ACUTE = '́';
  const ZWJ = '‍';
  const family = `👨${ZWJ}👩${ZWJ}👧${ZWJ}👦`;

  it('leaves real text untouched: accents, emoji ZWJ families, plain ASCII', () => {
    for (const text of [`cafe${ACUTE} pronto`, `${family} ok`, 'plain \x1b[1mbold\x1b[0m']) {
      expect(clampClusterExtenders(text, 0)).toEqual({ text, trailing: 0 });
    }
    expect(clampClusterExtenders(`e${ACUTE}`, 0)).toEqual({ text: `e${ACUTE}`, trailing: 1 });
  });

  it('caps a mark run, counting what the previous chunk left open', () => {
    const cap = GHOSTTY_MAX_CLUSTER_EXTENDERS;
    expect(clampClusterExtenders(`e${ACUTE.repeat(cap + 50)}x`, 0).text).toBe(`e${ACUTE.repeat(cap)}x`);
    const first = clampClusterExtenders(`e${ACUTE.repeat(cap - 2)}`, 0);
    expect(first.trailing).toBe(cap - 2);
    const second = clampClusterExtenders(`${ACUTE.repeat(10)} next${ACUTE}`, first.trailing);
    expect(second.text).toBe(`${ACUTE.repeat(2)} next${ACUTE}`);
    expect(second.trailing).toBe(1);
    expect(clampClusterExtenders(ACUTE.repeat(5), cap)).toEqual({ text: '', trailing: cap });
    expect(clampClusterExtenders(`${ZWJ}👩`.repeat(100), 0).text).toBe(`${ZWJ}👩`.repeat(cap / 2));
  });

  it('a 1M-mark flood at production defaults keeps the grid, the memory and the clock flat', () => {
    const runtime = freshRuntime();
    const reasons: GhosttyFallbackReason[] = [];
    const buffer = new GhosttyScreenBuffer(runtime, { onFallback: (reason) => reasons.push(reason) });
    buffer.append('s', 'e');
    const attached = runtime.memory.buffer.byteLength;
    const started = performance.now();
    // 64 × 16K marks: unclamped, this grew ~256 MiB and took ~57 s in the wasm.
    for (let chunk = 0; chunk < 64; chunk += 1) buffer.append('s', ACUTE.repeat(16_384));
    buffer.append('s', ' done');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(runtime.memory.buffer.byteLength - attached).toBeLessThan(1024 * 1024);
    expect(buffer.hasGrid('s')).toBe(true);
    expect(buffer.text('s')).toBe(`e${ACUTE.repeat(GHOSTTY_MAX_CLUSTER_EXTENDERS)} done`);
    expect(reasons).toEqual([]);
  });

  it('format and default-ignorable floods (revisão 2, achado 10) keep the grid and the memory flat', () => {
    const grew: string[] = [];
    // ZWSP, ZWNJ, LRM, LRE, WJ, BOM, ALM, MVS, tags, musical format, Hangul filler.
    for (const codePoint of [0x200b, 0x200c, 0x200e, 0x202a, 0x2060, 0xfeff, 0x061c, 0x180e, 0xe0001, 0xe0020, 0xe007f, 0x1d173, 0x3164]) {
      const runtime = freshRuntime();
      const buffer = new GhosttyScreenBuffer(runtime);
      buffer.append('s', 'e');
      const attached = runtime.memory.buffer.byteLength;
      const chunk = String.fromCodePoint(codePoint).repeat(16_384);
      for (let index = 0; index < 4; index += 1) buffer.append('s', chunk);
      const growth = runtime.memory.buffer.byteLength - attached;
      if (!buffer.hasGrid('s') || growth >= MiB) grew.push(`U+${codePoint.toString(16).toUpperCase()}:${(growth / MiB).toFixed(1)}MiB`);
    }
    expect(grew).toEqual([]);
  });

  it('every code point Ghostty stores with zero width in the previous cell is clamped', () => {
    // Swept against the vendored wasm, so a Unicode table drift shows up here.
    const runtime = freshRuntime();
    const screen = GhosttyScreen.create(runtime, 200, 4);
    const terminal = (screen as unknown as { terminal: number }).terminal;
    const out = runtime.alloc(8);
    const input = runtime.alloc(32);
    const encoder = new TextEncoder();
    const cursorX = (text: string) => {
      const bytes = encoder.encode(text);
      runtime.bytes(input, bytes.length).set(bytes);
      runtime.call('ghostty_terminal_vt_write', terminal, input, bytes.length);
      runtime.call('ghostty_terminal_get', terminal, 3, out);
      return runtime.view(out, 2).getUint16(0, true);
    };
    const escapes: string[] = [];
    const cap = GHOSTTY_MAX_CLUSTER_EXTENDERS;
    for (const [from, to] of [[0xa0, 0x323af], [0xe0000, 0xe0fff]]) {
      for (let codePoint = from; codePoint <= to; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
        const char = String.fromCodePoint(codePoint);
        if (cursorX(`\x1b[H\x1b[2Ke${char}`) !== 1) continue;
        if (clampClusterExtenders(`e${char.repeat(cap + 8)}`, 0).text !== `e${char.repeat(cap)}`) {
          escapes.push(codePoint.toString(16));
        }
      }
    }
    expect(escapes).toEqual([]);
  }, 30_000);

  it('NFD Hangul, flags, tag flags, keycaps, skin tones and conjuncts pass intact', () => {
    const hangul = '한국어 텍스트를 분해된 자모로 보냅니다 열세 음절 이상'.normalize('NFD');
    for (const text of [
      hangul,
      hangul.repeat(4),
      '🇧🇷🇵🇹🇯🇵 flags',
      '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} scotland',
      '#️⃣ keycap',
      '👍🏽 ok',
      'क्षत्रिय नमस्ते',
      'می‌خواهم',
      'بِسْمِ اللَّهِ',
      `${family}${family}`,
    ]) {
      expect(clampClusterExtenders(text, 0).text).toBe(text);
    }
  });
});

describe('createDetectorScreenSource — fail-soft default', () => {
  it('uses the grid when the artifact loads', () => {
    expect(createDetectorScreenSource({ wasmPath: WASM })).toBeInstanceOf(GhosttyScreenBuffer);
  });

  it('falls back to the text stream when the wasm is missing, and says why', () => {
    const reasons: Array<[GhosttyFallbackReason, string]> = [];
    const source = createDetectorScreenSource({
      wasmPath: path.join(path.dirname(WASM), 'absent-ghostty-vt.wasm'),
      onFallback: (reason, detail) => reasons.push([reason, detail]),
    });
    expect(source).toBeInstanceOf(SessionScreenBuffer);
    expect(reasons).toEqual([['unavailable', 'ENOENT']]);
    source.append('s', '\x1b[1mstill detected\x1b[0m\n');
    expect(source.text('s')).toBe('still detected\n');
  });
});

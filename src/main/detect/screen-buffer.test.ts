import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GhosttyRuntime } from './ghostty-runtime';
import {
  createDetectorScreenSource,
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

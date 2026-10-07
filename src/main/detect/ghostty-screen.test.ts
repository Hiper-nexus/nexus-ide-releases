import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GhosttyRuntime } from './ghostty-runtime';
import { GhosttyScreen } from './ghostty-screen';

const WASM = path.resolve(__dirname, '../../../resources/ghostty/ghostty-vt.wasm');
const runtime = GhosttyRuntime.fromBytes(new Uint8Array(fs.readFileSync(WASM)));
const open: GhosttyScreen[] = [];

function screen(cols: number, rows: number): GhosttyScreen {
  const created = GhosttyScreen.create(runtime, cols, rows);
  open.push(created);
  return created;
}

afterEach(() => {
  for (const created of open.splice(0)) created.dispose();
});

/** Claude Code (Ink) style frame: transcript line, prompt box, footer. */
function claudeFrame(status: string): string {
  return [
    `⏺ ${status}`,
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  ? for shortcuts',
  ].join('\r\n');
}

describe('GhosttyScreen — rendered grid for the detector', () => {
  it('a cursor-addressed redraw (Claude/Ink) leaves ONE frame, not a stack', () => {
    const grid = screen(80, 24);
    grid.write(claudeFrame('Reading files… 0'));
    for (let frame = 1; frame <= 5; frame += 1) {
      // Ink: cursor up over the previous frame, erase to end of screen, repaint.
      grid.write(`\x1b[5A\r\x1b[J${claudeFrame(`Reading files… ${frame}`)}`);
    }
    const text = grid.plainText();
    expect(text).toBe(claudeFrame('Reading files… 5').replaceAll('\r\n', '\n').replace('❯ ', '❯'));
    expect(text.match(/\? for shortcuts/g)).toHaveLength(1);
  });

  it('a spinner rewritten with CR + erase-line (Codex) keeps only the last status', () => {
    const grid = screen(80, 24);
    grid.write('• Explored codebase\r\n');
    for (let second = 1; second <= 9; second += 1) {
      grid.write(`\r\x1b[2K• Working (${second}s • esc to interrupt)`);
    }
    expect(grid.plainText()).toBe('• Explored codebase\n• Working (9s • esc to interrupt)');
  });

  it('the alternate screen replaces the primary one and restores it on exit', () => {
    const grid = screen(60, 10);
    grid.write('shell prompt $ vim notes.txt\r\n');
    grid.write('\x1b[?1049h\x1b[H\x1b[2J~ editing notes\r\n~\r\n-- INSERT --');
    expect(grid.plainText()).toBe('~ editing notes\n~\n-- INSERT --');
    grid.write('\x1b[?1049l');
    expect(grid.plainText()).toBe('shell prompt $ vim notes.txt');
  });

  it('rejoins a soft-wrapped row into one logical line', () => {
    const grid = screen(40, 10);
    const long = `Do you want to proceed? ${'x'.repeat(70)} esc to cancel`;
    grid.write(`${long}\r\nnext`);
    expect(grid.plainText()).toBe(`${long}\nnext`);
  });

  it('keeps only the visible grid (no scrollback history)', () => {
    const grid = screen(40, 5);
    for (let line = 1; line <= 100; line += 1) grid.write(`line ${line}\r\n`);
    expect(grid.plainText()).toBe('line 97\nline 98\nline 99\nline 100');
  });

  it('reflows on resize like the PTY does', () => {
    const grid = screen(40, 6);
    for (let line = 1; line <= 5; line += 1) grid.write(`line ${line}\r\n`);
    grid.write('tail');
    grid.resize(40, 3);
    const shrunk = grid.plainText();
    expect(shrunk.endsWith('tail')).toBe(true);
    expect(shrunk.split('\n')).toHaveLength(3);
    grid.resize(120, 3);
    grid.write(`\r\n${'y'.repeat(100)}`);
    // 100 columns fit one physical row now: still one logical line either way.
    expect(grid.plainText().split('\n').at(-1)).toBe('y'.repeat(100));
  });

  it('reset empties the grid', () => {
    const grid = screen(40, 5);
    grid.write('something\r\n');
    grid.reset();
    expect(grid.plainText()).toBe('');
  });

  it('bare LF moves down without returning the carriage (ONLCR is the PTY’s job)', () => {
    const grid = screen(40, 5);
    grid.write('one\ntwo');
    expect(grid.plainText()).toBe('one\n   two');
  });

  it('frees terminals: create/dispose churn neither grows memory nor leaks counters', () => {
    const baseline = runtime.liveTerminals;
    const cycle = () => {
      const grid = GhosttyScreen.create(runtime, 200, 60);
      grid.write('z'.repeat(12_000));
      expect(grid.plainText().length).toBe(12_000);
      grid.dispose();
    };
    for (let warm = 0; warm < 5; warm += 1) cycle();
    const settled = runtime.memory.buffer.byteLength;
    for (let index = 0; index < 100; index += 1) cycle();
    // A leaked terminal keeps its ~5 MiB page pool, so 100 leaks would add
    // hundreds of wasm pages; one 64 KiB page of allocator slack is tolerated.
    expect(runtime.memory.buffer.byteLength).toBeLessThanOrEqual(settled + 65_536);
    expect(runtime.liveTerminals).toBe(baseline);
  });

  it('refuses use after dispose', () => {
    const grid = GhosttyScreen.create(runtime, 10, 2);
    grid.dispose();
    grid.dispose();
    expect(() => grid.write('x')).toThrow(/disposed/);
  });
});

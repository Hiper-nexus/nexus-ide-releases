/** @vitest-environment jsdom */
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { describe, expect, it, vi } from 'vitest';
import { cliAcceptsContinuityPrompt } from '../orch/stranded-mission-handoff';
import { readTerminalTextTail } from './terminal-text-tail';

// These tests exercise xterm's actual parser/buffer, not canvas rendering.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null, configurable: true });
});

function write(term: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => term.write(text, resolve));
}

describe('terminal text tail with real xterm', () => {
  it('preserves wide-character wraps, combining marks, and explicit blank lines', async () => {
    const term = new Terminal({ cols: 5, rows: 4, allowProposedApi: true });
    try {
      await write(term, 'abcd漢x\r\n\r\ne\u0301😀');
      expect(readTerminalTextTail(term.buffer)).toBe('abcd漢x\n\ne\u0301😀');
    } finally { term.dispose(); }
  });

  it('keeps authentication context from normal history and the active alternate screen', async () => {
    const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
    try {
      await write(term, 'Please run /login\x1b[?1049hOAuth token expired');
      const text = readTerminalTextTail(term.buffer);
      expect(text).toContain('Please run /login');
      expect(text).toContain('OAuth token expired');
      expect(cliAcceptsContinuityPrompt(text)).toBe(false);
    } finally { term.dispose(); }
  });

  it.each([
    ['OAuth access token has expired', false],
    ['Please run /login', false],
    ['Retrying in 3s • attempt 2/3', false],
    ['Yes, I trust this folder', false],
    ['Working on the requested changes', true],
  ] as const)('preserves the existing continuity decision for %s', async (text, expected) => {
    const term = new Terminal({ cols: 13, rows: 4, allowProposedApi: true });
    try {
      await write(term, text);
      expect(cliAcceptsContinuityPrompt(readTerminalTextTail(term.buffer))).toBe(expected);
    } finally { term.dispose(); }
  });

  it('benchmarks the same tail with short and full history without modifying the terminal', async () => {
    const results: Array<{ history: number; oldMedianMs: number; tailMedianMs: number }> = [];
    for (const history of [20, 5_000]) {
      const term = new Terminal({ cols: 100, rows: 24, scrollback: 5_000, allowProposedApi: true });
      const serializer = new SerializeAddon();
      term.loadAddon(serializer);
      try {
        await write(term, Array.from({ length: history }, () => 'work item '.repeat(9)).join('\r\n') + '\r\nPlease run /login — última saída 😀');
        const before = serializer.serialize();
        const measurements = { old: [] as number[], tail: [] as number[] };
        for (let sample = 0; sample < 15; sample++) {
          let start = performance.now();
          serializer.serialize().slice(-4_800);
          measurements.old.push(performance.now() - start);
          start = performance.now();
          const text = readTerminalTextTail(term.buffer);
          measurements.tail.push(performance.now() - start);
          expect(text.endsWith('Please run /login — última saída 😀')).toBe(true);
          expect(text.length).toBeLessThanOrEqual(2_400);
        }
        expect(serializer.serialize()).toBe(before);
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
        results.push({ history, oldMedianMs: median(measurements.old), tailMedianMs: median(measurements.tail) });
      } finally { term.dispose(); }
    }
    console.info('[F-396 tail benchmark]', JSON.stringify(results));
  });
});

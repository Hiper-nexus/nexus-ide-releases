import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeOscCwd,
  Osc133Scanner,
} from './shell-integration-osc133';
import { cpuTimeMs } from '../../test/cpu-time';

describe('Osc133Scanner', () => {
  it('parses A/B/C/D lifecycle and ignores plain text', () => {
    const scanner = new Osc133Scanner();
    const chunk =
      'hello\x1b]133;A\x07prompt\x1b]133;B\x07ls -la\x1b]133;C\x07out\x1b]133;D;0\x07';
    const events = scanner.push(chunk);
    expect(events.map((e) => e.kind)).toEqual([
      'prompt_start',
      'command_start',
      'command_executed',
      'command_finished',
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: 'command_finished',
      exitCode: 0,
    });
  });

  it('handles ST-terminated sequences and split chunks', () => {
    const scanner = new Osc133Scanner();
    expect(scanner.push('\x1b]133;')).toEqual([]);
    expect(scanner.push('E;echo hi\x1b\\')).toEqual([
      { kind: 'command_line', command: 'echo hi' },
    ]);
  });

  it('parses cwd from OSC 133 P, OSC 7, and OSC 9;9', () => {
    const scanner = new Osc133Scanner();
    const events = scanner.push(
      '\x1b]133;P;cwd=/Users/dev/proj\x07\x1b]7;file://host/tmp/work\x07\x1b]9;9;/Users/dev/iterm\x07',
    );
    expect(events).toEqual([
      { kind: 'cwd', path: '/Users/dev/proj' },
      { kind: 'cwd', path: '/tmp/work' },
      { kind: 'cwd', path: '/Users/dev/iterm' },
    ]);
  });

  it('decodes escaped delimiters and rejects control-bearing OSC payloads', () => {
    const scanner = new Osc133Scanner();
    expect(scanner.push('\x1b]133;P;cwd=/tmp/a%3Bb\x07')).toEqual([
      { kind: 'cwd', path: '/tmp/a;b' },
    ]);
    expect(scanner.push('\x1b]133;E;echo%07injected\x07')).toEqual([]);
  });

  it('does not throw on garbage or missing integration', () => {
    const scanner = new Osc133Scanner();
    expect(scanner.push('just normal shell output\n')).toEqual([]);
    expect(scanner.push('\x1b]999;nope\x07')).toEqual([]);
  });

  it('validates safe absolute cwd only', () => {
    expect(isSafeOscCwd('/tmp/ok')).toBe(true);
    expect(isSafeOscCwd('C:\\Users\\ok')).toBe(true);
    expect(isSafeOscCwd('relative')).toBe(false);
    expect(isSafeOscCwd('~/home')).toBe(false);
    expect(isSafeOscCwd('a\0b')).toBe(false);
    expect(isSafeOscCwd('/tmp/a\x1b]133;D;0')).toBe(false);
  });

  it('does not exit an interactive fish shell when sourced twice', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), 'resources/shell-integration/nexus-osc133.fish'),
      'utf8',
    );
    expect(script).toContain('return 0');
    expect(script).toContain('string escape --style=url');
    expect(script).not.toMatch(/\bexit 0\b/);
  });
});

/**
 * F-764 C.3: a varredura anterior, só como referência — refazia a busca de BEL
 * e de ST até o fim do texto a cada sequência. Devolve os corpos de OSC na
 * ordem em que o scanner os interpretaria.
 */
function referenceBodies(chunks: readonly string[]): string[] {
  const bodies: string[] = [];
  let partial = '';
  for (const chunk of chunks) {
    const data = partial + chunk;
    partial = '';
    let i = 0;
    while (i < data.length) {
      const esc = data.indexOf('\x1b', i);
      if (esc < 0) break;
      if (data[esc + 1] !== ']') {
        i = esc + 1;
        continue;
      }
      const bodyStart = esc + 2;
      const bel = data.indexOf('\x07', bodyStart);
      const st = data.indexOf('\x1b\\', bodyStart);
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
        const tail = data.slice(esc);
        partial = tail.length > 4096 ? tail.slice(-4096) : tail;
        break;
      }
      bodies.push(data.slice(bodyStart, end));
      i = end + endLen;
    }
  }
  return bodies;
}

describe('Osc133Scanner em tempo linear (F-764 C.3)', () => {
  const ALPHABET = ['\x1b', ']', '\\', '\x07', '133;', 'A', 'D;0', ';', '7;file:///t', 'x'];
  let seed = 133;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randomChunk = () => {
    let out = '';
    const length = Math.floor(random() * 16);
    for (let i = 0; i < length; i += 1) {
      out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    }
    return out;
  };

  it('emite os mesmos eventos que a varredura anterior em 10 mil fluxos aleatórios', () => {
    for (let round = 0; round < 10_000; round += 1) {
      const chunks = Array.from({ length: 1 + Math.floor(random() * 4) }, randomChunk);
      const scanner = new Osc133Scanner();
      const events = chunks.flatMap((chunk) => scanner.push(chunk));
      // Cada corpo de referência interpretado isolado pelo próprio parser.
      const expected = referenceBodies(chunks).flatMap((body) =>
        new Osc133Scanner().push(`\x1b]${body}\x07`),
      );
      expect(events, JSON.stringify(chunks)).toEqual(expected);
    }
  });

  it.each([
    ['OSC com BEL e sem ST', '\x1b]133;A\x07'.repeat(1_638)],
    ['OSC com ST e sem BEL', '\x1b]133;A\x1b\\'.repeat(1_489)],
    ['ESC ] sem terminador', '\x1b]'.repeat(8_192)],
  ])('%s: 16 KB em tempo linear', (_label, text) => {
    expect(cpuTimeMs(() => new Osc133Scanner().push(text))).toBeLessThan(20);
  });
});

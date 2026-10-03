import { describe, expect, it } from 'vitest';

import { OscTracker } from './osc';
import { cpuTimeMs } from '../../test/cpu-time';

describe('OscTracker', () => {
  it('captures OSC 0/2 titles with BEL and ST terminators', () => {
    const osc = new OscTracker();
    osc.feed('s', 'plain\x1b]0;✳ Claude Code\x07more');
    expect(osc.title('s')).toBe('✳ Claude Code');
    osc.feed('s', '\x1b]2;⠋ Working\x1b\\tail');
    expect(osc.title('s')).toBe('⠋ Working');
  });

  it('captures the OSC 9 progress payload after "9;"', () => {
    const osc = new OscTracker();
    osc.feed('s', '\x1b]9;4;3;\x07');
    expect(osc.progress('s')).toBe('4;3;');
    osc.feed('s', '\x1b]9;4;0;\x1b\\');
    expect(osc.progress('s')).toBe('4;0;');
  });

  it('rejoins sequences split across chunks', () => {
    const osc = new OscTracker();
    osc.feed('s', 'text\x1b]0;Spl');
    expect(osc.title('s')).toBe('');
    osc.feed('s', 'it title\x07rest');
    expect(osc.title('s')).toBe('Split title');
  });

  it('sanitizes control characters and caps length', () => {
    const osc = new OscTracker();
    osc.feed('s', `\x1b]0;ab\x01cd\x07`);
    expect(osc.title('s')).toBe('abcd');
    osc.feed('s', `\x1b]0;${'x'.repeat(400)}\x07`);
    expect(osc.title('s')).toHaveLength(256);
  });

  it('keeps state per session and drops it on exit', () => {
    const osc = new OscTracker();
    osc.feed('a', '\x1b]0;title-a\x07');
    osc.feed('b', '\x1b]0;title-b\x07');
    expect(osc.title('a')).toBe('title-a');
    osc.drop('a');
    expect(osc.title('a')).toBe('');
    expect(osc.title('b')).toBe('title-b');
  });

  it('ignores unknown OSC codes and empty payloads clear the title', () => {
    const osc = new OscTracker();
    osc.feed('s', '\x1b]0;something\x07');
    osc.feed('s', '\x1b]1337;ignored\x07');
    expect(osc.title('s')).toBe('something');
    osc.feed('s', '\x1b]0;\x07');
    expect(osc.title('s')).toBe('');
  });

  it('survives an unterminated sequence without leaking memory', () => {
    const osc = new OscTracker();
    osc.feed('s', `\x1b]0;${'y'.repeat(10_000)}`);
    osc.feed('s', 'next\x1b]0;final\x07');
    expect(osc.title('s')).toBe('final');
  });
});

/**
 * F-764 C.3: a versão anterior do `feed`, só como referência — refazia as três
 * buscas até o fim do texto a cada `ESC ]` abandonado (quadrática).
 */
function referencePayloads(chunks: readonly string[]): string[] {
  const payloads: string[] = [];
  let pending = '';
  const tail = (text: string) =>
    text.endsWith('\x1b]') ? '\x1b]' : text.endsWith('\x1b') ? '\x1b' : '';
  for (const data of chunks) {
    let text = pending + data;
    pending = '';
    if (!text.includes('\x1b]')) {
      pending = tail(text);
      continue;
    }
    for (;;) {
      const start = text.indexOf('\x1b]');
      if (start < 0) {
        pending = tail(text);
        break;
      }
      const resync = text.indexOf('\x1b]', start + 2);
      const belEnd = text.indexOf('\x07', start + 2);
      const stEnd = text.indexOf('\x1b\\', start + 2);
      let end = -1;
      let endLen = 1;
      if (belEnd >= 0 && (stEnd < 0 || belEnd < stEnd)) {
        end = belEnd;
      } else if (stEnd >= 0) {
        end = stEnd;
        endLen = 2;
      }
      if (resync >= 0 && (end < 0 || resync < end)) {
        text = text.slice(resync);
        continue;
      }
      if (end < 0) {
        pending = text.slice(start).slice(0, 4096 + 16);
        break;
      }
      payloads.push(text.slice(start + 2, end).slice(0, 4096));
      text = text.slice(end + endLen);
    }
  }
  return payloads;
}

describe('OscTracker em tempo linear (F-764 C.3)', () => {
  const ALPHABET = ['\x1b', ']', '\\', '\x07', '0', '2', '9', ';', 'a', ' '];
  let seed = 764;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randomChunk = () => {
    let out = '';
    const length = Math.floor(random() * 24);
    for (let i = 0; i < length; i += 1) {
      out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    }
    return out;
  };

  it('extrai os mesmos payloads que a versão anterior em 10 mil fluxos aleatórios', () => {
    const proto = OscTracker.prototype as unknown as {
      applyPayload: (state: unknown, payload: string) => void;
    };
    const original = proto.applyPayload;
    const seen: string[] = [];
    proto.applyPayload = function (this: unknown, state: unknown, payload: string) {
      seen.push(payload);
      original.call(this, state, payload);
    };
    try {
      for (let i = 0; i < 10_000; i += 1) {
        const chunks = Array.from({ length: 1 + Math.floor(random() * 4) }, randomChunk);
        seen.length = 0;
        const osc = new OscTracker();
        for (const chunk of chunks) osc.feed('s', chunk);
        expect(seen, JSON.stringify(chunks)).toEqual(referencePayloads(chunks));
      }
    } finally {
      proto.applyPayload = original;
    }
  });

  it.each([
    ['ESC ] sem terminador', '\x1b]'.repeat(8_192)],
    ['OSC com BEL e sem ST', '\x1b]0;t\x07'.repeat(2_730)],
    ['OSC com ST e sem BEL', '\x1b]0;t\x1b\\'.repeat(2_340)],
  ])('%s: 16 KB em tempo linear', (_label, text) => {
    // A versão anterior levava ~300 ms com 16 KB de `ESC ]` abandonados.
    expect(cpuTimeMs(() => new OscTracker().feed('s', text))).toBeLessThan(20);
  });
});

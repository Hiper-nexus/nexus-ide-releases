import { describe, expect, it } from 'vitest';
import { MonotoneSearch } from './monotone-search';

describe('MonotoneSearch (F-764 C.3)', () => {
  it('responde igual ao indexOf para partidas que só crescem', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const needles = ['\x07', '\x1b\\', '\x1b]', 'ab'];
    for (let round = 0; round < 2_000; round += 1) {
      let text = '';
      const length = Math.floor(random() * 40);
      for (let i = 0; i < length; i += 1) text += 'ab\x07\x1b]\\'[Math.floor(random() * 7)];
      const search = new MonotoneSearch(text);
      let from = 0;
      for (let step = 0; step < 12; step += 1) {
        from += Math.floor(random() * 4);
        const needle = needles[Math.floor(random() * needles.length)];
        expect(search.find(needle, from)).toBe(text.indexOf(needle, from));
      }
    }
  });

  it('refaz a busca se a partida recuar', () => {
    const search = new MonotoneSearch('x\x07y\x07');
    expect(search.find('\x07', 2)).toBe(3);
    expect(search.find('\x07', 0)).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_AMBIGUOUS_MISSION_CANDIDATES,
  isMissionNameNoise,
  normalizeMissionName,
  resolveMissionByName,
} from './mission-name-match';

interface Mission {
  id: string;
  title: string;
}

function missions(...titles: string[]): Mission[] {
  return titles.map((title, index) => ({ id: `m-${index}`, title }));
}

describe('normalizeMissionName', () => {
  it('ignores accents, case, punctuation and repeated spaces', () => {
    expect(normalizeMissionName('  SÃO   João — v2!! ')).toBe('sao joao v2');
    expect(normalizeMissionName('Site-da_loja')).toBe('site da loja');
  });

  it('returns an empty string when nothing readable is left', () => {
    expect(normalizeMissionName('?!…  ')).toBe('');
  });
});

describe('isMissionNameNoise', () => {
  it.each(['a', 'é', '?', '', '   ', undefined])('treats %j as a sound, not a name', (text) => {
    expect(isMissionNameNoise(text)).toBe(true);
  });

  it.each(['2', 'ab', 'sait da lója', 'versão dois'])('treats %j as a possible name', (text) => {
    expect(isMissionNameNoise(text)).toBe(false);
  });
});

describe('resolveMissionByName', () => {
  describe('empty target keeps the "most recent mission" behaviour', () => {
    it.each([undefined, '', '   ', '?!'])('opens the first mission for %j', (wanted) => {
      const list = missions('Recente', 'Antiga');
      expect(resolveMissionByName(wanted, list)).toEqual({
        kind: 'unique',
        mission: list[0],
        reason: 'most-recent',
      });
    });

    it('has nothing to open when there are no missions at all', () => {
      expect(resolveMissionByName(undefined, [])).toEqual({ kind: 'none' });
      expect(resolveMissionByName('checkout', [])).toEqual({ kind: 'none' });
    });
  });

  describe('no match is never turned into "the first mission"', () => {
    it('answers none when no title relates to the target', () => {
      expect(resolveMissionByName('banana', missions('Site da loja', 'API de pagamento'))).toEqual({
        kind: 'none',
      });
    });

    it('answers none for a one-letter target (it would match anything)', () => {
      expect(resolveMissionByName('a', missions('Site da loja', 'API de pagamento'))).toEqual({
        kind: 'none',
      });
    });

    it('still accepts a lone digit as a real target', () => {
      const list = missions('Missão 1', 'Missão 2');
      expect(resolveMissionByName('2', list)).toMatchObject({ kind: 'unique', mission: list[1] });
    });

    it('does not accept a partial word overlap as a silent match', () => {
      // "site novo" tem uma palavra em comum com "Site da loja", mas não todas.
      expect(resolveMissionByName('site novo', missions('Site da loja'))).toEqual({ kind: 'none' });
    });
  });

  describe('unique matches', () => {
    it('matches ignoring accents and case', () => {
      const list = missions('Refatoração do Checkout', 'API de pagamento');
      expect(resolveMissionByName('REFATORACAO DO CHECKOUT', list)).toMatchObject({
        kind: 'unique',
        mission: list[0],
        reason: 'exact',
      });
    });

    it('prefers the exact title over a longer title that starts with it', () => {
      const list = missions('Site da loja v2', 'Site da loja');
      expect(resolveMissionByName('site da loja', list)).toEqual({
        kind: 'unique',
        mission: list[1],
        reason: 'exact',
      });
    });

    it('matches a unique fragment in the middle of a title', () => {
      const list = missions('Site da loja', 'Site da loja v2', 'API de pagamento');
      expect(resolveMissionByName('loja v2', list)).toEqual({
        kind: 'unique',
        mission: list[1],
        reason: 'contains',
      });
    });

    it('matches a unique prefix', () => {
      const list = missions('Site da loja', 'API de pagamento');
      expect(resolveMissionByName('api', list)).toEqual({
        kind: 'unique',
        mission: list[1],
        reason: 'prefix',
      });
    });

    it('matches out-of-order words that are all present, ignoring filler words', () => {
      const list = missions('Pagamento via PIX', 'Site da loja');
      expect(resolveMissionByName('missão pix pagamento', list)).toEqual({
        kind: 'unique',
        mission: list[0],
        reason: 'words',
      });
    });
  });

  describe('ambiguity is reported, never resolved silently', () => {
    it('lists both missions when two titles tie on the same fragment', () => {
      const list = missions('Site da loja', 'Site da loja v2', 'API de pagamento');
      const result = resolveMissionByName('site', list);
      expect(result).toEqual({
        kind: 'ambiguous',
        total: 2,
        candidates: [
          { mission: list[0], reason: 'prefix' },
          { mission: list[1], reason: 'prefix' },
        ],
      });
    });

    it('treats a shared set of words as a tie as well', () => {
      const list = missions('Site da loja', 'Site da loja v2');
      expect(resolveMissionByName('site loja', list)).toMatchObject({
        kind: 'ambiguous',
        total: 2,
      });
    });

    it('does not trust a better tier when another mission also matches (prefix + contains)', () => {
      const list = missions('Refatorar checkout', 'Checkout PIX');
      const result = resolveMissionByName('checkout', list);
      expect(result).toEqual({
        kind: 'ambiguous',
        total: 2,
        // ordenado pelo motivo: começa com antes de contém
        candidates: [
          { mission: list[1], reason: 'prefix' },
          { mission: list[0], reason: 'contains' },
        ],
      });
    });

    it('is ambiguous when two missions share the exact title', () => {
      const list = missions('Loja', 'Loja');
      expect(resolveMissionByName('loja', list)).toMatchObject({ kind: 'ambiguous', total: 2 });
    });

    it('lists at most five candidates but still reports how many matched', () => {
      const list = missions(
        'Loja 1',
        'Loja 2',
        'Loja 3',
        'Loja 4',
        'Loja 5',
        'Loja 6',
        'Loja 7',
        'Outro assunto',
      );
      const result = resolveMissionByName('loja', list);
      expect(MAX_AMBIGUOUS_MISSION_CANDIDATES).toBe(5);
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.total).toBe(7);
      expect(result.candidates).toHaveLength(5);
      expect(result.candidates.map((c) => c.mission.title)).toEqual([
        'Loja 1',
        'Loja 2',
        'Loja 3',
        'Loja 4',
        'Loja 5',
      ]);
    });
  });

  describe('determinism', () => {
    it('gives the same answer for the same input, every time', () => {
      const list = missions('Site da loja', 'Site da loja v2', 'API de pagamento', 'Loja nova');
      const first = resolveMissionByName('loja', list);
      for (let i = 0; i < 20; i += 1) {
        expect(resolveMissionByName('loja', list)).toEqual(first);
      }
    });

    it('breaks ties by the order the list came in (most recent first)', () => {
      const a = missions('Loja B', 'Loja A');
      const b = missions('Loja A', 'Loja B');
      const orderOf = (list: Mission[]): string[] => {
        const result = resolveMissionByName('loja', list);
        return result.kind === 'ambiguous' ? result.candidates.map((c) => c.mission.title) : [];
      };
      expect(orderOf(a)).toEqual(['Loja B', 'Loja A']);
      expect(orderOf(b)).toEqual(['Loja A', 'Loja B']);
    });

    it('does not mutate the list it receives', () => {
      const list = missions('Loja 2', 'Loja 1');
      const snapshot = JSON.stringify(list);
      resolveMissionByName('loja', list);
      expect(JSON.stringify(list)).toBe(snapshot);
    });
  });

  describe('words that only connect or sound short (revisão de segurança, B3)', () => {
    const lojas = [{ title: 'Pedidos da loja' }, { title: 'Dashboard' }, { title: 'API de pagamento' }];
    it('treats a target made only of connecting words as noise, never as a match', () => {
      expect(resolveMissionByName('da', lojas)).toEqual({ kind: 'none' });
      expect(resolveMissionByName('de', lojas)).toEqual({ kind: 'none' });
      expect(isMissionNameNoise('da')).toBe(true);
      expect(isMissionNameNoise('a missão')).toBe(true);
    });
    it('does not match a short target inside another word', () => {
      expect(resolveMissionByName('das', lojas)).toEqual({ kind: 'none' });
      expect(resolveMissionByName('pag', lojas)).toEqual({ kind: 'none' });
    });
    it('still matches a short target as a whole word or a whole-word prefix', () => {
      expect(resolveMissionByName('api', lojas)).toMatchObject({ kind: 'unique', reason: 'prefix' });
    });
  });
});

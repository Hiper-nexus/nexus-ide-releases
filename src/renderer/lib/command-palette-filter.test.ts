import { describe, expect, it } from 'vitest';
import {
  filterPaletteActions,
  matchesPaletteQuery,
} from './command-palette-filter';

describe('matchesPaletteQuery', () => {
  it('query vazio casa com tudo', () => {
    expect(matchesPaletteQuery({ label: 'Qualquer' }, '')).toBe(true);
    expect(matchesPaletteQuery({ label: 'Qualquer' }, '   ')).toBe(true);
  });

  it('ignora caixa e acentos nos dois lados', () => {
    expect(matchesPaletteQuery({ label: 'Nova missão' }, 'MISSAO')).toBe(true);
    expect(matchesPaletteQuery({ label: 'Configurações' }, 'configuracoes')).toBe(
      true,
    );
  });

  it('multi-termo exige todos, em qualquer ordem', () => {
    const action = { label: 'Focar pane', keywords: 'claude terminal' };
    expect(matchesPaletteQuery(action, 'claude focar')).toBe(true);
    expect(matchesPaletteQuery(action, 'claude gemini')).toBe(false);
  });

  it('keywords contam para o match', () => {
    expect(
      matchesPaletteQuery({ label: 'Equipe', keywords: 'squad handoff' }, 'squad'),
    ).toBe(true);
  });
});

describe('filterPaletteActions', () => {
  it('preserva a ordem original', () => {
    const list = [
      { label: 'B misto', keywords: 'x' },
      { label: 'A misto', keywords: 'x' },
    ];
    expect(filterPaletteActions(list, 'misto').map((a) => a.label)).toEqual([
      'B misto',
      'A misto',
    ]);
  });
});

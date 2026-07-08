import { describe, expect, it } from 'vitest';
import {
  NARRATION_ENVELOPE,
  compressMenuForNarration,
  menuOptionLabel,
  normalizeForCompare,
  speakPayload,
  wrapNarration,
} from './live-narration';

describe('menuOptionLabel', () => {
  it('preserves the option number and shortens the label at the first separator', () => {
    expect(menuOptionLabel('1. Deploy to production — irreversible, needs approval')).toBe(
      '1. Deploy to production',
    );
    expect(menuOptionLabel('2) Roll back the release')).toBe('2. Roll back the release');
  });

  it('cuts at a colon-space and drops parenthetical detail', () => {
    expect(menuOptionLabel('3. Keep current build (safe)')).toBe('3. Keep current build');
    expect(menuOptionLabel('4. Option: extra description here')).toBe('4. Option');
  });

  it('strips a leading ❯ cursor prefix', () => {
    expect(menuOptionLabel('❯ 1. Selected option')).toBe('1. Selected option');
  });

  it('ellipsizes very long labels past 60 chars', () => {
    const long = `1. ${'a'.repeat(80)}`;
    const out = menuOptionLabel(long);
    expect(out.startsWith('1. ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(3 + 58);
  });
});

describe('compressMenuForNarration', () => {
  it('returns null when there are fewer than 3 option lines', () => {
    expect(compressMenuForNarration('1. one\n2. two')).toBeNull();
    expect(compressMenuForNarration('just some prose\nwith no menu')).toBeNull();
  });

  it('compresses a >=3 ascending numbered menu, preserving all options', () => {
    const raw = [
      'Which environment do you want?',
      '1. Production',
      '2. Staging',
      '3. Local dev',
    ].join('\n');
    const out = compressMenuForNarration(raw);
    expect(out).toBe(
      'Menu com 3 opções: 1. Production; 2. Staging; 3. Local dev. Pergunta final: Which environment do you want?',
    );
  });

  it('finds the trailing question after the menu', () => {
    const raw = ['1. A', '2. B', '3. C', 'Qual você prefere?'].join('\n');
    const out = compressMenuForNarration(raw);
    expect(out).toBe('Menu com 3 opções: 1. A; 2. B; 3. C. Pergunta final: Qual você prefere?');
  });

  it('picks the longest ascending streak as the menu', () => {
    const raw = [
      '1. old option',
      'some unrelated 5 in prose',
      'Choose:',
      '1. alpha',
      '2. beta',
      '3. gamma',
      '4. delta',
    ].join('\n');
    const out = compressMenuForNarration(raw);
    expect(out).toContain('Menu com 4 opções');
    expect(out).toContain('1. alpha; 2. beta; 3. gamma; 4. delta');
  });

  it('strips ANSI codes from option lines', () => {
    const raw = ['1. [32mGreen[0m', '2. Blue', '3. Red'].join('\n');
    const out = compressMenuForNarration(raw);
    expect(out).toContain('1. Green; 2. Blue; 3. Red');
  });
});

describe('NARRATION_ENVELOPE + wrapNarration', () => {
  it('wraps a payload behind the internal-context directive', () => {
    const wrapped = wrapNarration('o build passou');
    expect(wrapped.startsWith(NARRATION_ENVELOPE)).toBe(true);
    expect(wrapped.endsWith('o build passou')).toBe(true);
  });

  it('envelope tells the model not to read anything aloud', () => {
    expect(NARRATION_ENVELOPE).toContain('NÃO leia nada disto em voz alta');
    expect(NARRATION_ENVELOPE).toContain('EVENTO:');
  });
});

describe('speakPayload (FALE composer)', () => {
  it('emits a bare FALE with no marks by default', () => {
    expect(speakPayload('Pronto, abri a missão.')).toBe('FALE: Pronto, abri a missão.');
  });

  it('adds the first-person mark for self', () => {
    expect(speakPayload('escrevi', { self: true })).toBe(
      'FALE (é VOCÊ — 1ª pessoa, lei 9): escrevi',
    );
  });

  it('adds the menu-completeness mark', () => {
    expect(speakPayload('Menu com 3 opções: ...', { menu: true })).toBe(
      'FALE (menu: TODAS as opções, na ordem): Menu com 3 opções: ...',
    );
  });

  it('joins multiple marks with semicolons', () => {
    const out = speakPayload('x', { self: true, menu: true });
    expect(out).toBe(
      'FALE (é VOCÊ — 1ª pessoa, lei 9; menu: TODAS as opções, na ordem): x',
    );
  });
});

describe('normalizeForCompare', () => {
  it('lowercases, strips accents/punctuation, and collapses whitespace', () => {
    expect(normalizeForCompare('  Olá,  MUNDO! ')).toBe('ola mundo');
    expect(normalizeForCompare('Tela: 3 panes')).toBe('tela 3 panes');
  });

  it('treats accent-only differences as equal', () => {
    expect(normalizeForCompare('missão')).toBe(normalizeForCompare('missao'));
  });
});

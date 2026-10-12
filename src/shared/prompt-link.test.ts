import { describe, expect, it } from 'vitest';
import {
  PROMPT_LINK_MAX_LENGTH,
  readLinkedPrompt,
  sanitizeLinkedPrompt,
} from './prompt-link';

describe('sanitizeLinkedPrompt', () => {
  it('normaliza quebras de linha e mantém multi-linha', () => {
    expect(sanitizeLinkedPrompt('a\r\nb\rc\u2028d').text).toBe('a\nb\nc\nd');
  });

  it('remove zero-width e bidi, contando', () => {
    const r = sanitizeLinkedPrompt('ok\u200B\u202Eevil');
    expect(r.text).toBe('okevil');
    expect(r.hiddenCharacters).toBeGreaterThan(0);
  });

  it('mantém emoji e o ZWJ de família', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(sanitizeLinkedPrompt(family).text).toBe(family);
    expect(sanitizeLinkedPrompt(family).hiddenCharacters).toBe(0);
  });

  it('trim nas bordas', () => {
    expect(sanitizeLinkedPrompt('  pedido  ').text).toBe('pedido');
  });
});

describe('readLinkedPrompt', () => {
  it('ausente → null (formulário vazio, sem erro)', () => {
    expect(readLinkedPrompt(null)).toEqual({ ok: true, prompt: null });
  });

  it('texto comum e multi-linha passam', () => {
    expect(readLinkedPrompt('Corrigir o login\ncom testes')).toEqual({
      ok: true,
      prompt: 'Corrigir o login\ncom testes',
    });
  });

  it('só invisíveis é malicioso', () => {
    expect(readLinkedPrompt('\u200B\u200C')).toEqual({
      ok: false,
      reason: 'hidden-only',
    });
  });

  it('acima do teto é recusado', () => {
    expect(readLinkedPrompt('a'.repeat(PROMPT_LINK_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(readLinkedPrompt('a'.repeat(PROMPT_LINK_MAX_LENGTH)).ok).toBe(true);
  });
});

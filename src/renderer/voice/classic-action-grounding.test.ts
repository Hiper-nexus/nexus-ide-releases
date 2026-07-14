import { describe, expect, it } from 'vitest';
import { isClassicActionGrounded } from './classic-action-grounding';

describe('isClassicActionGrounded', () => {
  it('blocks the exact ambient fallback regression', () => {
    expect(isClassicActionGrounded(
      'Vamos ao vivo, sim. Vamos ao vivo, sim. Ahem.',
      { type: 'open_terminal' },
    )).toBe(false);
  });

  it('allows an explicit matching terminal request', () => {
    expect(isClassicActionGrounded('Jarvis abra um terminal', { type: 'open_terminal' })).toBe(true);
  });

  it('allows opening the saved-squad picker from an explicit squad choice', () => {
    expect(
      isClassicActionGrounded('quero escolher um squad', {
        type: 'open_squad_picker',
      }),
    ).toBe(true);
  });

  it('grounds repository sync in an explicit Git request', () => {
    expect(
      isClassicActionGrounded(
        'atualiza o repositório local com GitHub',
        { type: 'sync_repository' },
      ),
    ).toBe(true);
    expect(
      isClassicActionGrounded('vamos ao vivo', { type: 'sync_repository' }),
    ).toBe(false);
  });

  it('blocks a mismatched model-selected target', () => {
    expect(isClassicActionGrounded('abra as configurações', { type: 'open_terminal' })).toBe(false);
  });

  it('keeps action:none conversational replies', () => {
    expect(isClassicActionGrounded('como você está?', { type: 'none' })).toBe(true);
  });
});

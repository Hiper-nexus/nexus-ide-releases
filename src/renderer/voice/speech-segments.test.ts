import { describe, expect, it } from 'vitest';
import { splitForPipelinedSpeech } from './speech-segments';

describe('splitForPipelinedSpeech', () => {
  it('keeps short replies as one segment', () => {
    expect(splitForPipelinedSpeech('Terminal aberto.')).toEqual({
      first: 'Terminal aberto.',
      rest: '',
    });
  });

  it('só divide em duas chamadas TTS em respostas longas', () => {
    const short = 'Terminal aberto. Quer mais alguma coisa?';
    expect(splitForPipelinedSpeech(short)).toEqual({
      first: short,
      rest: '',
    });
    const medium = 'x'.repeat(399);
    expect(splitForPipelinedSpeech(medium)).toEqual({ first: medium, rest: '' });
    const long = `${'palavra '.repeat(55)}fim. Segunda frase aqui.`;
    const split = splitForPipelinedSpeech(long);
    expect(split.rest.length).toBeGreaterThan(0);
  });

  it('splits long text at a word boundary when no sentence ends early', () => {
    const text = `${'palavra '.repeat(55)}fim`;
    const split = splitForPipelinedSpeech(text);
    expect(split.first.length).toBeLessThanOrEqual(180);
    expect(split.rest.length).toBeGreaterThan(0);
    expect(`${split.first} ${split.rest}`).toBe(text.trim());
  });
});

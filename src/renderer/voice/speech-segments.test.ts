import { describe, expect, it } from 'vitest';
import { splitForPipelinedSpeech } from './speech-segments';

describe('splitForPipelinedSpeech', () => {
  it('keeps short replies as one segment', () => {
    expect(splitForPipelinedSpeech('Terminal aberto.')).toEqual({
      first: 'Terminal aberto.',
      rest: '',
    });
  });

  it('splits after the first spoken sentence', () => {
    expect(splitForPipelinedSpeech('Terminal aberto. Quer mais alguma coisa?')).toEqual({
      first: 'Terminal aberto.',
      rest: 'Quer mais alguma coisa?',
    });
  });

  it('splits long text at a word boundary when no sentence ends early', () => {
    const text = `${'palavra '.repeat(40)}fim`;
    const split = splitForPipelinedSpeech(text);
    expect(split.first.length).toBeLessThanOrEqual(180);
    expect(split.rest.length).toBeGreaterThan(0);
    expect(`${split.first} ${split.rest}`).toBe(text.trim());
  });
});

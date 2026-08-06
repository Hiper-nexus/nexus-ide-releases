import { describe, expect, it } from 'vitest';
import { dictationSttRequestParams } from './dictation-output-mode';

describe('dictationSttRequestParams', () => {
  it('default (english) manda translate explícito — modo vale em qualquer engine', () => {
    expect(dictationSttRequestParams(undefined)).toEqual({
      translate: true,
      language: 'pt',
    });
    expect(dictationSttRequestParams('english')).toEqual({
      translate: true,
      language: 'pt',
    });
  });

  it('portuguese: transcrição literal, sem tradução', () => {
    expect(dictationSttRequestParams('portuguese')).toEqual({
      translate: false,
      language: 'pt',
    });
  });
});

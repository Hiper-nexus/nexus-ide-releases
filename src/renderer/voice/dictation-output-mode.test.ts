import { describe, expect, it } from 'vitest';
import {
  DICTATION_CODE_PRIMING_PROMPT,
  dictationSttRequestParams,
} from './dictation-output-mode';

describe('dictationSttRequestParams', () => {
  it('default (english) manda translate explícito — modo vale em qualquer engine', () => {
    expect(dictationSttRequestParams(undefined)).toEqual({
      translate: true,
      language: 'pt',
      prompt: DICTATION_CODE_PRIMING_PROMPT,
      polish: 'code-prompt',
    });
    expect(dictationSttRequestParams('english')).toEqual({
      translate: true,
      language: 'pt',
      prompt: DICTATION_CODE_PRIMING_PROMPT,
      polish: 'code-prompt',
    });
  });

  it('english leva priming de código — vocabulário técnico bias no Whisper', () => {
    const prompt = dictationSttRequestParams('english').prompt;
    expect(prompt).toBeTypeOf('string');
    // Priming em inglês (a API de translations recomenda prompt em inglês) e
    // com o vocabulário do dia a dia que a tradução literal costuma mutilar.
    expect(prompt).toContain('English');
    expect(prompt).toContain('commit');
    expect(prompt).toContain('worktree');
  });

  it('portuguese: transcrição literal, sem tradução e sem priming', () => {
    expect(dictationSttRequestParams('portuguese')).toEqual({
      translate: false,
      language: 'pt',
    });
  });
});

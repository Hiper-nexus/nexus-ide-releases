import { describe, expect, it } from 'vitest';
import {
  DICTATION_CODE_PRIMING_PROMPT,
  DICTATION_CODE_LITERAL_PRIMING_PROMPT,
  codePolishAvailable,
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

describe('CODE com reescrita: STT literal, tradução uma vez só', () => {
  it('com chave de modelo de texto a STT transcreve literal e a reescrita traduz', () => {
    expect(dictationSttRequestParams('english', { polishAvailable: true })).toEqual({
      translate: false,
      language: 'pt',
      prompt: DICTATION_CODE_LITERAL_PRIMING_PROMPT,
      polish: 'code-prompt',
    });
  });

  it('sem chave de modelo de texto a própria STT traduz', () => {
    expect(dictationSttRequestParams('english', { polishAvailable: false }).translate).toBe(true);
  });

  it('CHAT segue literal e sem reescrita, com ou sem chave', () => {
    expect(dictationSttRequestParams('portuguese', { polishAvailable: true })).toEqual({
      translate: false,
      language: 'pt',
    });
  });

  it('codePolishAvailable olha só presença de chave de modelo de texto', () => {
    const key = (envVar: string, stored: boolean) => ({ envVar, hasEnv: false, hasStoredKey: stored });
    expect(codePolishAvailable([key('GEMINI_API_KEY', true)])).toBe(true);
    expect(codePolishAvailable([key('GEMINI_API_KEY', false)])).toBe(false);
    expect(codePolishAvailable([key('ELEVENLABS_API_KEY', true)])).toBe(false);
    expect(codePolishAvailable(undefined)).toBe(false);
  });
});

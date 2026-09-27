import { describe, expect, it } from 'vitest';
import {
  DICTATION_CANONICAL_NAMES,
  DICTATION_CODE_VOCABULARY,
  DICTATION_CODE_LITERAL_PRIMING_PROMPT,
  DICTATION_CODE_PRIMING_PROMPT,
  DICTATION_ENGINE_VOCABULARY,
} from './dictation-vocabulary';

describe('vocabulário do ditado — nomes canônicos no viés de todo engine', () => {
  it.each(['CLI', 'MCP', 'MiMo', 'Antigravity', 'Kimi', 'GLM', 'MiniMax', 'Devin', 'Muse', 'OpenCode'])(
    '%s chega ao viés de reconhecimento literal e tradução',
    (term) => {
      expect(DICTATION_ENGINE_VOCABULARY).toContain(term);
      expect(DICTATION_CODE_LITERAL_PRIMING_PROMPT).toContain(term);
      expect(DICTATION_CODE_PRIMING_PROMPT).toContain(term);
    },
  );

  it('Jev e Nexus entram no vocabulário que os engines recebem', () => {
    // "JEV" foi relatado como "JAV": a lista dá contexto de domínio aos
    // engines (Grok keyterm, Gemini custom_vocabulary, Whisper).
    expect(DICTATION_ENGINE_VOCABULARY).toContain('Jev');
    expect(DICTATION_ENGINE_VOCABULARY).toContain('Nexus');
    // O vocabulário de engine é o de código + os nomes — nada se perde.
    expect(DICTATION_ENGINE_VOCABULARY).toEqual([
      ...DICTATION_CODE_VOCABULARY,
      ...DICTATION_CANONICAL_NAMES,
    ]);
  });

  it('os DOIS primings (tradução e literal) carregam os nomes canônicos', () => {
    expect(DICTATION_CODE_PRIMING_PROMPT).toContain('Jev');
    expect(DICTATION_CODE_PRIMING_PROMPT).toContain('Nexus');
    expect(DICTATION_CODE_LITERAL_PRIMING_PROMPT).toContain('Jev');
    expect(DICTATION_CODE_LITERAL_PRIMING_PROMPT).toContain('Nexus');
  });
});

import { describe, expect, it } from 'vitest';
import { buildLiveSystemInstruction } from './jarvis-live-prompt';

describe('buildLiveSystemInstruction', () => {
  it('default: identifica como Jarvis, com as leis', () => {
    const s = buildLiveSystemInstruction({ assistantName: 'Jarvis' });
    expect(s).toContain('Você é Jarvis');
    expect(s).toContain('NUNCA leia em voz alta');
    expect(s).not.toContain('nunca como Jarvis');
  });

  it('nome custom pede para se apresentar como tal', () => {
    const s = buildLiveSystemInstruction({ assistantName: 'Sexta-feira' });
    expect(s).toContain('Você é Sexta-feira');
    expect(s).toContain('nunca como Jarvis');
  });

  it('inclui nome do usuário e instruções custom e memória', () => {
    const s = buildLiveSystemInstruction(
      {
        assistantName: 'Jarvis',
        userName: 'Chefe',
        customInstructions: 'responda sempre com bom humor',
      },
      'MEMÓRIA: - [deploy] sexta à tarde',
    );
    expect(s).toContain('O usuário se chama Chefe');
    expect(s).toContain('bom humor');
    expect(s).toContain('deploy');
  });
});

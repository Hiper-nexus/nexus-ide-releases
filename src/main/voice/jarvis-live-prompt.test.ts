import { describe, expect, it } from 'vitest';
import { buildLiveSystemInstruction } from './jarvis-live-prompt';

describe('buildLiveSystemInstruction', () => {
  it('default: identifica como Jarvis, com as leis', () => {
    const s = buildLiveSystemInstruction({ assistantName: 'Jarvis' });
    expect(s).toContain('You are Jarvis');
    expect(s).toContain('call nexus_action immediately');
    expect(s).toContain('new_agentic_mission');
    expect(s).toContain('never substitute voice settings');
    expect(s).toContain('read_current_view');
    expect(s).toContain('Speak only in Brazilian Portuguese');
    expect(s).not.toContain('never call yourself Jarvis');
  });

  it('nome custom pede para se apresentar como tal', () => {
    const s = buildLiveSystemInstruction({ assistantName: 'Sexta-feira' });
    expect(s).toContain('You are Sexta-feira');
    expect(s).toContain('never call yourself Jarvis');
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
    expect(s).toContain('preferred name is "Chefe"');
    expect(s).toContain('bom humor');
    expect(s).toContain('deploy');
  });
});

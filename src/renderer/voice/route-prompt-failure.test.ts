import { describe, expect, it } from 'vitest';
import { routePromptFailureMessage } from './route-prompt-failure';

describe('routePromptFailureMessage', () => {
  it('sem pane focado, diz como sair: focar um pane ou mandar a voz para a Jarvis', () => {
    const message = routePromptFailureMessage(false);
    expect(message).toContain('Nenhum pane focado');
    expect(message).toContain('Ajustes › Voz');
    expect(message).not.toMatch(/route the prompt/u);
  });

  it('com pane focado que recusou, não manda trocar ajuste', () => {
    const message = routePromptFailureMessage(true);
    expect(message).toContain('não aceitou');
    expect(message).not.toContain('Ajustes');
  });
});

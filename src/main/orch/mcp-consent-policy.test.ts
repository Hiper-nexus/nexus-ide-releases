import { describe, expect, it } from 'vitest';
import { isDestructivePaneInput } from './mcp-consent-policy';

describe('isDestructivePaneInput — texto injetado em PTY com efeito destrutivo', () => {
  it('reconhece comando destrutivo em pane_write/ask/many e agent_prompt', () => {
    expect(
      isDestructivePaneInput('nexus_pane_write', {
        text: 'npm test; rm -rf /tmp/nexus-f146',
      }),
    ).toBe(true);
    expect(
      isDestructivePaneInput('nexus_pane_write_many', {
        writes: [{ text: 'ok' }, { text: 'sudo rm -rf /' }],
      }),
    ).toBe(true);
    expect(
      isDestructivePaneInput('nexus_pane_ask', {
        question: 'rode git reset --hard agora',
      }),
    ).toBe(true);
    expect(
      isDestructivePaneInput('agent_prompt', { text: 'git push --force origin main' }),
    ).toBe(true);
  });

  it('texto normal e mera citação do comando não param no modal', () => {
    expect(isDestructivePaneInput('nexus_pane_write', { text: 'npm test' })).toBe(
      false,
    );
    // A âncora de isDestructive (início ou após ; & |) evita o falso positivo
    // de quem só cita o comando numa pergunta.
    expect(
      isDestructivePaneInput('nexus_pane_ask', {
        question: 'como evitar rm -rf acidental?',
      }),
    ).toBe(false);
  });

  it('ferramentas sem texto de PTY ficam fora do predicado', () => {
    expect(isDestructivePaneInput('nexus_pane_close', { paneId: 'pane-1' })).toBe(
      false,
    );
    // terminal_run tem o próprio piso (isDestructiveEffect); aqui é só texto.
    expect(
      isDestructivePaneInput('nexus_terminal_run', { command: 'rm -rf /' }),
    ).toBe(false);
  });
});

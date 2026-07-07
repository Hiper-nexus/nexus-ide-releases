import { describe, expect, it } from 'vitest';
import { jarvisActionFastPath } from './jarvis-action-fastpath';
import type { JarvisContext } from '../../shared/voice-ipc';

const CTX: JarvisContext = {
  workspace: 'nexus-ide',
  recents: ['nexus-ide'],
  squads: ['Code Review'],
  panes: ['pane-1 [shell]'],
  focusedPane: 'pane-1 [shell]',
  orchestrator: null,
  missions: [],
};

describe('jarvisActionFastPath', () => {
  it('abrir terminal dispara open_terminal', () => {
    const reply = jarvisActionFastPath('Abrir terminal.', CTX);
    expect(reply?.action).toEqual({ type: 'open_terminal' });
    expect(reply?.say).toContain('terminal');
  });

  it('abrir um comando ai dispara run_command', () => {
    const reply = jarvisActionFastPath('Abrir um comando AI.', CTX);
    expect(reply?.action).toEqual({ type: 'run_command', command: 'ai' });
  });

  it('roda npm test dispara run_command', () => {
    const reply = jarvisActionFastPath('roda npm test', CTX);
    expect(reply?.action).toEqual({ type: 'run_command', command: 'npm test' });
  });

  it('abre squad de code review dispara open_squad', () => {
    const reply = jarvisActionFastPath('abre o squad de code review', CTX);
    expect(reply?.action).toEqual({ type: 'open_squad', squadName: 'code review' });
  });

  it('conversa aberta não intercepta', () => {
    expect(jarvisActionFastPath('vamos dominar o mundo', CTX)).toBeNull();
    expect(jarvisActionFastPath('o que você acha?', CTX)).toBeNull();
  });
});

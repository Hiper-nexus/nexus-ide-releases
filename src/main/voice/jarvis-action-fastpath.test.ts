import { describe, expect, it } from 'vitest';
import { jarvisActionFastPath } from './jarvis-action-fastpath';
import type { JarvisContext } from '../../shared/voice-ipc';

const CTX: JarvisContext = {
  workspace: 'nexus-ide',
  userName: 'patrão',
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
    expect(reply?.say).toContain('patrão');
  });

  it('abrir um comando ai dispara run_command', () => {
    const reply = jarvisActionFastPath('Abrir um comando AI.', CTX);
    expect(reply?.action).toEqual({ type: 'run_command', command: 'ai' });
  });

  it('roda npm test dispara run_command', () => {
    const reply = jarvisActionFastPath('roda npm test', CTX);
    expect(reply?.action).toEqual({ type: 'run_command', command: 'npm test' });
  });

  it('iniciar um novo workspace dispara new_workspace', () => {
    const reply = jarvisActionFastPath('iniciar um novo workspace', CTX);
    expect(reply?.action).toEqual({ type: 'new_workspace' });
  });

  it('transcrição realtime em inglês dispara new_workspace', () => {
    for (const text of [
      'start a new workspace',
      'create new work space',
      'open a new workspace',
      'new project',
    ]) {
      const reply = jarvisActionFastPath(text, CTX);
      expect(reply?.action).toEqual({ type: 'new_workspace' });
    }
  });

  it('novo projeto ou ambiente dispara new_workspace', () => {
    expect(jarvisActionFastPath('criar um novo projeto', CTX)?.action).toEqual({
      type: 'new_workspace',
    });
    expect(jarvisActionFastPath('abre novo ambiente', CTX)?.action).toEqual({
      type: 'new_workspace',
    });
  });

  it('configurações e modos visuais disparam ações nativas', () => {
    expect(jarvisActionFastPath('abre configurações de voz', CTX)?.action).toEqual({
      type: 'open_voice_settings',
    });
    expect(jarvisActionFastPath('abrir configurações', CTX)?.action).toEqual({
      type: 'open_settings',
    });
    expect(jarvisActionFastPath('modo canvas', CTX)?.action).toEqual({
      type: 'open_canvas',
    });
    expect(jarvisActionFastPath('volta para modo grid', CTX)?.action).toEqual({
      type: 'open_grid',
    });
  });

  it('browser e navegação disparam ações nativas', () => {
    expect(jarvisActionFastPath('abrir navegador', CTX)?.action).toEqual({
      type: 'open_browser',
    });
    expect(jarvisActionFastPath('abre site example.com', CTX)?.action).toEqual({
      type: 'open_browser',
      url: 'https://example.com',
    });
    expect(jarvisActionFastPath('recarrega a página', CTX)?.action).toEqual({
      type: 'browser_reload',
    });
    expect(jarvisActionFastPath('próximo pane', CTX)?.action).toEqual({
      type: 'focus_next_pane',
    });
  });

  it('iniciar um novo squad dispara design_squad', () => {
    const reply = jarvisActionFastPath('iniciar um novo squad', CTX);
    expect(reply?.action).toEqual({ type: 'design_squad' });
  });

  it('inicia squad full stack dispara open_squad', () => {
    const reply = jarvisActionFastPath('inicia o squad full stack', CTX);
    expect(reply?.action).toEqual({ type: 'open_squad', squadName: 'full stack' });
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

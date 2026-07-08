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

  it('STT "iniciar no workspace" dispara new_workspace', () => {
    for (const text of [
      'Iniciar no Workspace.',
      'abrir workspace novo',
      'abrir novo workspace',
      'iniciar workspace',
    ]) {
      const reply = jarvisActionFastPath(text, CTX);
      expect(reply?.action).toEqual({ type: 'new_workspace' });
      expect(reply?.say).toContain('workspace');
    }
  });

  it('STT "abrir novo o workspace" (com artigo extra) dispara new_workspace', () => {
    for (const text of [
      'E aí, Jarvis? Abrir novo o Workspace.',
      'abrir novo o workspace',
      'abre um novo o workspace',
      'abrir novo workspace',
    ]) {
      const reply = jarvisActionFastPath(text, CTX);
      expect(reply?.action).toEqual({ type: 'new_workspace' });
    }
  });

  it('variantes faladas de espaço de trabalho disparam new_workspace', () => {
    for (const text of [
      'inicia um novo espaço de trabalho',
      'cria novo espaço de trabalho',
      'iniciar um novo workspais',
    ]) {
      const reply = jarvisActionFastPath(text, CTX);
      expect(reply?.action).toEqual({ type: 'new_workspace' });
    }
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

  it('foco de panes dispara ações nativas sem LLM', () => {
    expect(jarvisActionFastPath('pane anterior', CTX)?.action).toEqual({
      type: 'focus_previous_pane',
    });
    expect(jarvisActionFastPath('foca terminal', CTX)?.action).toEqual({
      type: 'focus_pane',
      paneName: 'terminal',
    });
    expect(jarvisActionFastPath('focus pane Code Review', CTX)?.action).toEqual({
      type: 'focus_pane',
      paneName: 'code review',
    });
  });

  it('iniciar um novo squad dispara design_squad', () => {
    const reply = jarvisActionFastPath('iniciar um novo squad', CTX);
    expect(reply?.action).toEqual({ type: 'design_squad' });
    expect(reply?.expectReply).toBe(true);
  });

  it('sim na revisão de squad dispara confirm_squad', () => {
    const reply = jarvisActionFastPath('sim', {
      ...CTX,
      screen: 'wizard: revisão de squad pronto — diga sim / inicia para confirmar e disparar',
    });
    expect(reply?.action).toEqual({ type: 'confirm_squad' });
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

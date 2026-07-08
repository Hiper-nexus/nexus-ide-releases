import { describe, expect, it } from 'vitest';
import { jarvisFastPath } from './jarvis-fastpath';
import type { JarvisContext } from '../../shared/voice-ipc';

const CTX: JarvisContext = {
  workspace: 'nexus-ide',
  userName: 'patrão',
  recents: ['nexus-ide', 'saasbarbearia'],
  squads: ['Code Review', 'QA Swarm'],
  panes: ['pane-1 [shell]', 'pane-2 [agente]'],
  focusedPane: 'pane-2 [agente]',
  focusedPaneKind: 'cli-agent',
  orchestrator: 'pane-3 [orquestrador]',
  missions: ['Landing page'],
  screen: 'Workspace nexus-ide em modo canvas. 2 panes abertos. Pane focado: pane-2.',
};

describe('jarvisFastPath', () => {
  it('responde consultas de panes sem LLM', () => {
    const reply = jarvisFastPath('quais panes estão abertos?', CTX);
    expect(reply?.say).toContain('2 panes');
    expect(reply?.action.type).toBe('none');
  });

  it('responde squads e missões', () => {
    expect(jarvisFastPath('quais squads eu tenho?', CTX)?.say).toContain('Code Review');
    expect(jarvisFastPath('quantas missões ativas?', CTX)?.say).toContain('Landing page');
  });

  it('responde workspace e orquestrador', () => {
    expect(jarvisFastPath('qual projeto está aberto agora?', CTX)?.say).toContain(
      'nexus-ide',
    );
    expect(jarvisFastPath('que horas são?', CTX)?.say).toContain('patrão');
    expect(jarvisFastPath('tem orquestrador ativo?', CTX)?.say).toContain('pane-3');
  });

  it('responde pane e pagina atual sem LLM', () => {
    expect(jarvisFastPath('qual pane esta focado?', CTX)?.say).toContain(
      'pane-2 [agente]',
    );
    const browserCtx: JarvisContext = {
      ...CTX,
      focusedPane: 'Preview',
      focusedPaneKind: 'browser',
      focusedPaneUrl: 'https://example.com/docs',
    };
    expect(jarvisFastPath('qual pagina estamos?', browserCtx)?.say).toContain(
      'https://example.com/docs',
    );
    expect(jarvisFastPath('onde estamos?', CTX)?.say).toContain('modo canvas');
  });

  it('responde consultas de estado em inglês sem LLM', () => {
    const browserCtx: JarvisContext = {
      ...CTX,
      focusedPane: 'Preview',
      focusedPaneKind: 'browser',
      focusedPaneUrl: 'https://example.com/docs',
    };
    expect(jarvisFastPath('what page are we on?', browserCtx)?.say).toContain(
      'https://example.com/docs',
    );
    expect(jarvisFastPath('current workspace', CTX)?.say).toContain('nexus-ide');
    expect(jarvisFastPath('where are we?', CTX)?.say).toContain('modo canvas');
    expect(jarvisFastPath('what panes are open?', CTX)?.say).toContain('2 panes');
  });

  it('fala em português mesmo quando o contexto interno da tela está em inglês', () => {
    const reply = jarvisFastPath('onde estamos?', {
      ...CTX,
      screen:
        'Current Nexus screen: files panel open on package.json with unsaved changes. Workspace: nexus-ide. View: canvas.',
    });

    expect(reply?.say).toContain('painel de arquivos');
    expect(reply?.say).toContain('package.json');
    expect(reply?.say).toContain('patrão');
    expect(reply?.say).not.toContain('Current Nexus screen');
  });

  it('NUNCA intercepta pedidos de ação — mesmo citando squad/pane', () => {
    expect(jarvisFastPath('abre o squad de code review', CTX)).toBeNull();
    expect(jarvisFastPath('roda npm test no pane', CTX)).toBeNull();
    expect(jarvisFastPath('cria uma missão nova', CTX)).toBeNull();
    expect(jarvisFastPath('fecha esses panes ai', CTX)).toBeNull();
    expect(jarvisFastPath('focus terminal', CTX)).toBeNull();
  });

  it('conversa aberta vai para o LLM', () => {
    expect(jarvisFastPath('vamos dominar o mundo', CTX)).toBeNull();
    expect(jarvisFastPath('o que você acha desse projeto?', CTX)).toBeNull();
  });

  it('lista vazia responde com fallback honesto', () => {
    const empty: JarvisContext = { ...CTX, panes: [], squads: [], missions: [] };
    expect(jarvisFastPath('quais panes abertos?', empty)?.say).toContain('Nenhum');
    const squads = jarvisFastPath('quais squads tem?', empty);
    expect(squads?.expectReply).toBe(true);
  });
});

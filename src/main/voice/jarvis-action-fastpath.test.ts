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
  it('envia sequência diretamente ao orquestrador ativo', () => {
    const active = { ...CTX, orchestrator: 'NexusIDE Squad' };
    for (const text of ['Dá sequência na missão.', 'Continue o squad.']) {
      expect(jarvisActionFastPath(text, active)?.action).toEqual({
        type: 'ask_pane',
        pergunta: 'Continue a missão atual a partir do ponto em que parou.',
      });
    }
    expect(jarvisActionFastPath('Dá sequência na missão.', CTX)).toBeNull();
  });

  it('abrir terminal dispara open_terminal', () => {
    const reply = jarvisActionFastPath('Abrir terminal.', CTX);
    expect(reply?.action).toEqual({ type: 'open_terminal' });
    expect(reply?.say).toContain('terminal');
    expect(reply?.say).toContain('patrão');
  });

  it('atualiza repositório via pane (não terminal / nexus_git)', () => {
    for (const text of [
      'Atualiza o repositório.',
      'Puxa as mudanças.',
      'git pull',
      'Sincroniza o repo.',
    ]) {
      const reply = jarvisActionFastPath(text, CTX);
      expect(reply?.action).toEqual({ type: 'sync_repo_via_pane', mode: 'pull' });
    }
  });

  it('status do git e push usam modes distintos', () => {
    expect(jarvisActionFastPath('Qual o status do git?', CTX)?.action).toEqual({
      type: 'sync_repo_via_pane',
      mode: 'status',
    });
    expect(jarvisActionFastPath('git push', CTX)?.action).toEqual({
      type: 'sync_repo_via_pane',
      mode: 'push',
    });
  });

  it('atualiza a página continua sendo browser_reload', () => {
    expect(jarvisActionFastPath('Atualiza a página.', CTX)?.action).toEqual({
      type: 'browser_reload',
    });
  });

  it('não trata "atualiza o projeto" genérico como git pull', () => {
    expect(jarvisActionFastPath('Atualiza o projeto.', CTX)).toBeNull();
  });


  it('abrir um comando ai dispara run_command', () => {
    const reply = jarvisActionFastPath('Abrir um comando AI.', CTX);
    expect(reply?.action).toEqual({ type: 'run_command', command: 'ai' });
  });

  it('roda npm test dispara run_command', () => {
    const reply = jarvisActionFastPath('roda npm test', CTX);
    expect(reply?.action).toEqual({ type: 'run_command', command: 'npm test' });
  });

  it('sincroniza GitHub via pane CLI sem transformar a operação em missão ou squad', () => {
    for (const text of [
      'atualizar repositório local com GitHub',
      'sincroniza o repositório com origin',
      'puxa as atualizações do git',
    ]) {
      expect(jarvisActionFastPath(text, CTX)?.action).toEqual({
        type: 'sync_repo_via_pane',
        mode: 'pull',
      });
    }
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
    expect(jarvisActionFastPath('abrir voz', CTX)?.action).toEqual({
      type: 'open_voice_settings',
    });
    expect(jarvisActionFastPath('abre a voz', CTX)?.action).toEqual({
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

  it('endereça o pane pelo NÚMERO, com e sem verbo', () => {
    // O número existe para caber na fala. A referência crua segue adiante: quem
    // resolve conhece os panes vivos e recusa nomeando os números válidos.
    for (const [text, paneName] of [
      ['foca o pane 7', '7'],
      ['vai pro pane 7', '7'],
      ['muda para o pane 12', '12'],
      ['focus pane 7', '7'],
      ['pane 7', '7'],
      ['no pane 7', '7'],
      ['pane sete', 'sete'],
      ['foca o pane sete', 'sete'],
      ['painel 3', '3'],
    ] as const) {
      expect(jarvisActionFastPath(text, CTX)?.action).toEqual({
        type: 'focus_pane',
        paneName,
      });
    }
  });

  it('não rouba "pane N" no meio de uma frase que pede outra coisa', () => {
    // "manda a tarefa no pane 7" é uma ENTREGA, não uma troca de foco. Tratá-la
    // como foco desviaria o trabalho para um simples reposicionamento de tela.
    const action = jarvisActionFastPath('manda a tarefa no pane 7', CTX)?.action;
    expect(action?.type).not.toBe('focus_pane');
  });

  it('ler a tela atual dispara Vision/OCR em vez de ler um pane', () => {
    for (const text of ['leia esta tela', 'leia essa página', 'o que tem aqui?']) {
      expect(jarvisActionFastPath(text, CTX)?.action).toEqual({
        type: 'read_current_view',
      });
    }
  });

  it('iniciar um novo squad dispara design_squad', () => {
    const reply = jarvisActionFastPath('iniciar um novo squad', CTX);
    expect(reply?.action).toEqual({ type: 'design_squad' });
    expect(reply?.expectReply).toBe(true);
  });

  it('abrir ou escolher modo squad sem nome abre o seletor de squads salvos', () => {
    for (const text of [
      'abrir modo squad',
      'iniciar o squad',
      'abre um squad',
      'escolher um squad',
      'quero usar um squad',
      'selecionar squad',
    ]) {
      const reply = jarvisActionFastPath(text, {
        ...CTX,
        screen:
          'wizard open: nova missão; visible step: mode; visible choices: Modo Livre, Modo Squad, Modo Agêntico',
        squads: ['Code Review', 'QA Swarm'],
      });
      expect(reply?.action).toEqual({ type: 'open_squad_picker' });
      expect(reply?.expectReply).toBe(true);
      expect(reply?.say).toMatch(/squads salvos/i);
      expect(reply?.say).toMatch(/qual.*usar/i);
    }
  });

  it('inicia pelo nome falado quando a lista de squads está visível', () => {
    const context = {
      ...CTX,
      screen:
        'wizard open: nova missão; visible step: squad-select; visible actions: Code Review, QA Swarm',
      squads: ['Code Review', 'QA Swarm'],
    };

    expect(jarvisActionFastPath('Code Review', context)?.action).toEqual({
      type: 'open_squad',
      squadName: 'Code Review',
    });
    expect(jarvisActionFastPath('quero o QA Swarm', context)?.action).toEqual({
      type: 'open_squad',
      squadName: 'QA Swarm',
    });
  });

  it('nunca transforma escolha de squad salvo em criação de squad', () => {
    const context = {
      ...CTX,
      screen: 'wizard open: nova missão; visible step: mode',
      squads: ['Code Review'],
    };

    expect(jarvisActionFastPath('escolhe modo squad', context)?.action).toEqual({
      type: 'open_squad_picker',
    });
    expect(jarvisActionFastPath('crie um squad novo', context)?.action).toEqual({
      type: 'design_squad',
    });
  });

  it('iniciar missão no modo agêntico preserva o modo antes do fast-path genérico', () => {
    expect(jarvisActionFastPath('iniciar missão no modo agêntico', CTX)?.action).toEqual({
      type: 'new_agentic_mission',
    });
    expect(
      jarvisActionFastPath(
        'criar missão agêntica para corrigir todos os testes',
        CTX,
      )?.action,
    ).toEqual({
      type: 'new_agentic_mission',
      intent: 'corrigir todos os testes',
    });
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

  it('abre codex, agy, kimi e devin com os modelos padrão corretos', () => {
    expect(jarvisActionFastPath('abre o codex', CTX)?.action).toEqual({
      type: 'open_agent',
      agentId: 'codex',
      model: 'gpt-5.6-luna',
    });
    expect(jarvisActionFastPath('no pane mando ele abrir codex', CTX)?.action).toEqual({
      type: 'open_agent',
      agentId: 'codex',
      model: 'gpt-5.6-luna',
    });
    expect(jarvisActionFastPath('abre agy', CTX)?.action).toEqual({
      type: 'open_agent',
      agentId: 'agy',
      model: 'gemini-3.8-pro-high',
    });
    expect(jarvisActionFastPath('abre o kimi', CTX)?.action).toEqual({
      type: 'open_agent',
      agentId: 'kimi',
      model: 'kimi-code/k3',
    });
    expect(jarvisActionFastPath('abre devin', CTX)?.action).toEqual({
      type: 'open_agent',
      agentId: 'devin',
      model: 'swe-2-high',
    });
  });

  it('conversa aberta não intercepta', () => {
    expect(jarvisActionFastPath('vamos dominar o mundo', CTX)).toBeNull();
    expect(jarvisActionFastPath('o que você acha?', CTX)).toBeNull();
  });
});

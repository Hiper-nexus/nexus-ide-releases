import { describe, expect, it } from 'vitest';
import {
  COARSE_VOICE_TOOLS,
  COARSE_VOICE_TOOL_NAMES,
  coarseVoiceToolsAsRealtimeDefinitions,
  resolveCoarseVoiceTool,
  systemReadToolForScope,
} from './coarse-voice-tools';

describe('ler — estado real do sistema', () => {
  it('cada scope de estado vira a ferramenta MCP somente leitura certa', () => {
    const cases: Array<[string, string]> = [
      ['panes', 'nexus_pane_list'],
      ['agentes', 'nexus_pane_list'],
      ['Missões', 'nexus_mission_list'],
      ['cotas', 'nexus_quota_status'],
      ['git', 'nexus_git_status'],
      ['saúde', 'nexus_system_doctor'],
      ['diagnóstico', 'nexus_system_doctor'],
    ];
    for (const [scope, tool] of cases) {
      expect(systemReadToolForScope(scope)).toBe(tool);
      expect(resolveCoarseVoiceTool('ler', { scope })).toMatchObject({
        kind: 'action',
        action: { action: 'mcp_tool', tool, args: {} },
      });
    }
  });

  it('pane e view seguem nos caminhos de sempre', () => {
    expect(systemReadToolForScope('pane')).toBeNull();
    expect(systemReadToolForScope('view')).toBeNull();
    expect(resolveCoarseVoiceTool('ler', {})).toMatchObject({ action: { action: 'read_pane' } });
    expect(resolveCoarseVoiceTool('ler', { scope: 'tela' })).toMatchObject({
      action: { action: 'read_current_view' },
    });
  });

  it('a descrição de consultar manda ler o estado vivo em vez de adivinhar', () => {
    const consultar = COARSE_VOICE_TOOLS.find((tool) => tool.name === 'consultar');
    const ler = COARSE_VOICE_TOOLS.find((tool) => tool.name === 'ler');
    expect(consultar?.description).toMatch(/ler/u);
    for (const scope of ['panes', 'missoes', 'cotas', 'git', 'saude']) {
      expect(ler?.description).toContain(`"${scope}"`);
    }
  });
});

describe('COARSE_VOICE_TOOLS declarations', () => {
  it('declares all 8 coarse tools with Gemini uppercase schema', () => {
    const names = COARSE_VOICE_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      'delegar', 'consultar', 'ler', 'navegar', 'encerrar',
      'comandar', 'restaurar', 'perguntar',
    ]);
    for (const tool of COARSE_VOICE_TOOLS) {
      expect(tool.parameters.type).toBe('OBJECT');
    }
  });

  it('delegar/consultar/comandar/perguntar require their key argument', () => {
    const byName = Object.fromEntries(COARSE_VOICE_TOOLS.map((t) => [t.name, t]));
    expect(byName.delegar.parameters.required).toEqual(['briefing']);
    expect(byName.consultar.parameters.required).toEqual(['pergunta']);
    expect(byName.navegar.parameters.required).toEqual(['target']);
    expect(byName.ler.parameters.required ?? []).toEqual([]);
    expect(byName.comandar.parameters.required).toEqual(['texto']);
    expect(byName.restaurar.parameters.required ?? []).toEqual([]);
    expect(byName.perguntar.parameters.required).toEqual(['pergunta']);
  });

  it('requires delegar to author an execution-ready engineering prompt', () => {
    const delegar = COARSE_VOICE_TOOLS.find((tool) => tool.name === 'delegar');
    const description = String(delegar?.parameters.properties.briefing?.description ?? '');

    expect(description).toContain('Objective');
    expect(description).toContain('Execution requirements');
    expect(description).toContain('Acceptance criteria');
    expect(description).toMatch(/do not invent/i);
  });

  it('COARSE_VOICE_TOOL_NAMES matches the declarations', () => {
    expect([...COARSE_VOICE_TOOL_NAMES]).toEqual(COARSE_VOICE_TOOLS.map((t) => t.name));
  });

  it('converts the same coarse surface to OpenAI JSON schema', () => {
    const defs = coarseVoiceToolsAsRealtimeDefinitions();
    expect(defs.map((tool) => tool.name)).toEqual([...COARSE_VOICE_TOOL_NAMES]);
    for (const definition of defs) {
      expect(definition.type).toBe('function');
      expect(definition.parameters.type).toBe('object');
    }
    const consultar = defs.find((tool) => tool.name === 'consultar');
    expect(consultar?.parameters.required).toEqual(['pergunta']);
    const ler = defs.find((tool) => tool.name === 'ler');
    expect(ler?.parameters.required).toBeUndefined();
  });
});

describe('resolveCoarseVoiceTool', () => {
  it('delegar maps to send_to_pane with the briefing verbatim', () => {
    const r = resolveCoarseVoiceTool('delegar', { briefing: 'cria a landing page' });
    expect(r).toEqual({
      kind: 'action',
      action: { action: 'send_to_pane', text: 'cria a landing page' },
      summary: 'enviar missão ao pane',
    });
  });

  it('delegar without a briefing is invalid', () => {
    expect(resolveCoarseVoiceTool('delegar', {}).kind).toBe('invalid');
  });

  it('navegar squad-picker / design-squad / wizard-fire / mission-new map to distinct flows', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'squad-picker' })).toMatchObject({
      kind: 'action',
      action: { action: 'open_squad_picker' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'design-squad' })).toMatchObject({
      kind: 'action',
      action: { action: 'design_squad' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'wizard-fire' })).toMatchObject({
      kind: 'action',
      action: { action: 'confirm_squad' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'mission-new' })).toMatchObject({
      kind: 'action',
      action: { action: 'new_mission' },
    });
  });

  it('navegar mission-agentic preserves an optional objective', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'mission-agentic' })).toMatchObject({
      kind: 'action',
      action: { action: 'new_agentic_mission' },
    });
    expect(
      resolveCoarseVoiceTool('navegar', {
        target: 'missão agêntica',
        query: 'corrigir todos os testes quebrados',
      }),
    ).toMatchObject({
      kind: 'action',
      action: {
        action: 'new_agentic_mission',
        intent: 'corrigir todos os testes quebrados',
      },
    });
  });

  it('navegar workspace-new abre o wizard de novo workspace (não new_mission)', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'workspace-new' })).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'new_workspace' })).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'novo-workspace' })).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
    expect(
      resolveCoarseVoiceTool('navegar', { target: 'workspace', query: 'new_workspace' }),
    ).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
    expect(
      resolveCoarseVoiceTool('navegar', { target: 'workspace', query: 'workspace-new' }),
    ).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'workspace' })).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
    expect(
      resolveCoarseVoiceTool('navegar', { target: 'workspace', query: 'novo' }),
    ).toMatchObject({
      kind: 'action',
      action: { action: 'new_workspace' },
    });
  });

  it('navegar workspace/squad/pane/terminal/browser map to nexus actions', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'workspace', query: 'nexus' })).toMatchObject(
      { kind: 'action', action: { action: 'open_workspace', workspaceName: 'nexus' } },
    );
    expect(resolveCoarseVoiceTool('navegar', { target: 'squad', query: 'builders' })).toMatchObject(
      { kind: 'action', action: { action: 'open_squad', squadName: 'builders' } },
    );
    expect(resolveCoarseVoiceTool('navegar', { target: 'pane', query: 'codex' })).toMatchObject(
      { kind: 'action', action: { action: 'focus_pane', paneName: 'codex' } },
    );
    expect(resolveCoarseVoiceTool('navegar', { target: 'terminal' })).toMatchObject(
      { kind: 'action', action: { action: 'open_terminal' } },
    );
    expect(
      resolveCoarseVoiceTool('navegar', { target: 'browser', query: 'https://x.dev' }),
    ).toMatchObject({ kind: 'action', action: { action: 'open_browser', url: 'https://x.dev' } });
  });

  it('navegar screen resolves grid/board/settings/voz', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'grid' })).toMatchObject({
      action: { action: 'open_terminal' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'board' })).toMatchObject({
      action: { action: 'open_board' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'voz' })).toMatchObject({
      action: { action: 'open_voice_settings' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'voz' })).toMatchObject({
      action: { action: 'open_voice_settings' },
    });
    // a bare screen name works as the target too
    expect(resolveCoarseVoiceTool('navegar', { target: 'settings' })).toMatchObject({
      action: { action: 'open_settings' },
    });
  });

  it('navegar with an unknown target/screen is invalid', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'nonsense' }).kind).toBe('invalid');
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'nope' }).kind).toBe(
      'invalid',
    );
    expect(resolveCoarseVoiceTool('navegar', {}).kind).toBe('invalid');
  });

  it('consultar answers context directly while ler executes a real pane read', () => {
    expect(resolveCoarseVoiceTool('consultar', { pergunta: 'quais panes?' })).toEqual({
      kind: 'direct',
      intent: 'consult',
      query: 'quais panes?',
    });
    expect(resolveCoarseVoiceTool('ler', { paneId: 'ativo' })).toEqual({
      kind: 'action',
      action: { action: 'read_pane', paneId: 'ativo' },
      summary: 'ler pane ativo',
    });
    expect(resolveCoarseVoiceTool('ler', {})).toEqual({
      kind: 'action',
      action: { action: 'read_pane' },
      summary: 'ler pane ativo',
    });
  });

  it('ler com escopo de tela/visão executa a leitura da view atual', () => {
    expect(resolveCoarseVoiceTool('ler', { scope: 'view' })).toEqual({
      kind: 'action',
      action: { action: 'read_current_view' },
      summary: 'ler visão atual',
    });
    expect(resolveCoarseVoiceTool('ler', { scope: 'tela' })).toMatchObject({
      kind: 'action',
      action: { action: 'read_current_view' },
    });
  });

  it('encerrar resolves to end, unknown tools are invalid', () => {
    expect(resolveCoarseVoiceTool('encerrar', {})).toEqual({ kind: 'end' });
    expect(resolveCoarseVoiceTool('quux', {}).kind).toBe('invalid');
  });

  it('comandar maps to send_to_pane with literal texto', () => {
    const r = resolveCoarseVoiceTool('comandar', { texto: 'npm test' });
    expect(r).toEqual({
      kind: 'action',
      action: { action: 'send_to_pane', text: 'npm test' },
      summary: 'enviar missão ao pane',
    });
  });

  it('comandar with paneId carries it through', () => {
    const r = resolveCoarseVoiceTool('comandar', { texto: 'ls -la', paneId: 'p1' });
    expect(r).toMatchObject({
      kind: 'action',
      action: { action: 'send_to_pane', text: 'ls -la', paneId: 'p1' },
    });
  });

  it('comandar without texto is invalid', () => {
    expect(resolveCoarseVoiceTool('comandar', {}).kind).toBe('invalid');
  });

  it('restaurar resolves to restore with optional alvo', () => {
    expect(resolveCoarseVoiceTool('restaurar', {})).toEqual({ kind: 'restore' });
    expect(resolveCoarseVoiceTool('restaurar', { alvo: 'landing' })).toEqual({
      kind: 'restore',
      alvo: 'landing',
    });
  });

  it('perguntar resolves to direct ask intent', () => {
    const r = resolveCoarseVoiceTool('perguntar', { pergunta: 'qual o status?' });
    expect(r).toEqual({
      kind: 'direct',
      intent: 'ask',
      query: 'qual o status?',
      paneId: undefined,
    });
  });

  it('perguntar with paneId carries it through', () => {
    const r = resolveCoarseVoiceTool('perguntar', { pergunta: 'está pronto?', paneId: 'p2' });
    expect(r).toEqual({
      kind: 'direct',
      intent: 'ask',
      query: 'está pronto?',
      paneId: 'p2',
    });
  });

  it('perguntar without pergunta is invalid', () => {
    expect(resolveCoarseVoiceTool('perguntar', {}).kind).toBe('invalid');
  });
});

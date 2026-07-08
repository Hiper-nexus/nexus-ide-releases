import { describe, expect, it } from 'vitest';
import {
  COARSE_VOICE_TOOLS,
  COARSE_VOICE_TOOL_NAMES,
  resolveCoarseVoiceTool,
} from './coarse-voice-tools';

describe('COARSE_VOICE_TOOLS declarations', () => {
  it('declares the 4 coarse tools (+ encerrar) with Gemini uppercase schema', () => {
    const names = COARSE_VOICE_TOOLS.map((t) => t.name);
    expect(names).toEqual(['delegar', 'consultar', 'ler', 'navegar', 'encerrar']);
    for (const tool of COARSE_VOICE_TOOLS) {
      expect(tool.parameters.type).toBe('OBJECT');
    }
  });

  it('delegar/consultar require their key argument; ler/encerrar do not', () => {
    const byName = Object.fromEntries(COARSE_VOICE_TOOLS.map((t) => [t.name, t]));
    expect(byName.delegar.parameters.required).toEqual(['briefing']);
    expect(byName.consultar.parameters.required).toEqual(['pergunta']);
    expect(byName.navegar.parameters.required).toEqual(['target']);
    expect(byName.ler.parameters.required ?? []).toEqual([]);
  });

  it('COARSE_VOICE_TOOL_NAMES matches the declarations', () => {
    expect([...COARSE_VOICE_TOOL_NAMES]).toEqual(COARSE_VOICE_TOOLS.map((t) => t.name));
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

  it('navegar screen resolves grid/board/settings/canvas/voz', () => {
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'grid' })).toMatchObject({
      action: { action: 'open_grid' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'board' })).toMatchObject({
      action: { action: 'open_board' },
    });
    expect(resolveCoarseVoiceTool('navegar', { target: 'screen', query: 'voz' })).toMatchObject({
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

  it('consultar/ler resolve to direct-answer intents', () => {
    expect(resolveCoarseVoiceTool('consultar', { pergunta: 'quais panes?' })).toEqual({
      kind: 'direct',
      intent: 'consult',
      query: 'quais panes?',
    });
    expect(resolveCoarseVoiceTool('ler', { paneId: 'ativo' })).toEqual({
      kind: 'direct',
      intent: 'read',
      query: 'ativo',
      paneId: 'ativo',
    });
    expect(resolveCoarseVoiceTool('ler', {})).toEqual({
      kind: 'direct',
      intent: 'read',
      query: 'ativo',
      paneId: undefined,
    });
  });

  it('encerrar resolves to end, unknown tools are invalid', () => {
    expect(resolveCoarseVoiceTool('encerrar', {})).toEqual({ kind: 'end' });
    expect(resolveCoarseVoiceTool('quux', {}).kind).toBe('invalid');
  });
});

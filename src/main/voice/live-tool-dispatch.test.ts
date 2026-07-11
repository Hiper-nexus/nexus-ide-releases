import { describe, expect, it } from 'vitest';
import {
  isExplicitNewWorkspaceIntent,
  sanitizeNexusActionArgs,
} from './live-tool-dispatch';
import type { NexusRealtimeActionArgs } from '../jarvis/realtime/nexus-realtime-tools';

const hasQuestionOn = (validPaneId: string) => (paneId: string) => paneId === validPaneId;

describe('sanitizeNexusActionArgs (C3 follow-up 2)', () => {
  it('mantém paneId de send_to_pane quando o pane TEM pergunta pendente no router', () => {
    const args: NexusRealtimeActionArgs = {
      action: 'send_to_pane',
      text: 'usa o Postgres',
      paneId: 'pane-42',
    };
    const out = sanitizeNexusActionArgs(args, hasQuestionOn('pane-42'));
    expect(out.args).toEqual(args);
    expect(out.strippedPaneId).toBeNull();
  });

  it('REMOVE paneId inventado pelo modelo (sem pergunta pendente) — cai no gate de delegação', () => {
    const args: NexusRealtimeActionArgs = {
      action: 'send_to_pane',
      text: 'rm -rf tudo',
      paneId: 'pane-shell',
    };
    const out = sanitizeNexusActionArgs(args, hasQuestionOn('pane-42'));
    expect(out.args).toEqual({ action: 'send_to_pane', text: 'rm -rf tudo' });
    expect('paneId' in out.args).toBe(false);
    expect(out.strippedPaneId).toBe('pane-shell');
  });

  it('não toca em send_to_pane sem paneId nem em outras ações', () => {
    const plain: NexusRealtimeActionArgs = { action: 'send_to_pane', text: 'oi' };
    expect(sanitizeNexusActionArgs(plain, () => false)).toEqual({
      args: plain,
      strippedPaneId: null,
    });
    const ask: NexusRealtimeActionArgs = {
      action: 'ask_pane',
      pergunta: 'status?',
      paneId: 'pane-1',
    };
    expect(sanitizeNexusActionArgs(ask, () => false)).toEqual({
      args: ask,
      strippedPaneId: null,
    });
  });
});

describe('isExplicitNewWorkspaceIntent', () => {
  it.each([
    'crie um novo workspace',
    'iniciar novo projeto',
    'create a new workspace',
    'crear nuevo espacio de trabajo',
  ])('aceita criação explícita: %s', (text) => {
    expect(isExplicitNewWorkspaceIntent(text)).toBe(true);
  });

  it.each([
    'Jarvis, me escuta?',
    'Arzú, ¿me escucha?',
    'abra o workspace nexus',
    'qual projeto está aberto?',
    '',
  ])('bloqueia fala sem criação explícita: %s', (text) => {
    expect(isExplicitNewWorkspaceIntent(text)).toBe(false);
  });
});

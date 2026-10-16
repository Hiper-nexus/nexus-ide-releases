import { describe, expect, it, vi } from 'vitest';
import {
  answerProviderWithoutSession,
  isExplicitEngineeringWorkIntent,
  isExplicitNewWorkspaceIntent,
  isPlausiblePaneRef,
  sanitizeNexusActionArgs,
} from './live-tool-dispatch';
import type { NexusRealtimeActionArgs } from '../jarvis/realtime/nexus-realtime-tools';

const hasQuestionOn = (validPaneId: string) => (paneId: string) => paneId === validPaneId;

describe('answerProviderWithoutSession', () => {
  it('returns a failed tool output directly to a ready provider', () => {
    const sendToolResult = vi.fn();
    answerProviderWithoutSession(
      {
        provider: { isReady: true, sendToolResult },
      } as never,
      { callId: 'call-1', name: 'consultar', arguments: {}, argumentsJson: '{}' },
      {
        ok: false,
        tool: 'none',
        summary: 'sessão de voz indisponível',
        output: { error: 'session_unavailable' },
      },
    );
    expect(sendToolResult).toHaveBeenCalledWith('call-1', {
      ok: false,
      tool: 'none',
      summary: 'sessão de voz indisponível',
      output: { error: 'session_unavailable' },
    });
  });

  it('never emits an output for local synthetic calls', () => {
    const sendToolResult = vi.fn();
    answerProviderWithoutSession(
      { provider: { isReady: true, sendToolResult } } as never,
      { callId: 'local:consult:1', name: 'consultar', arguments: {}, argumentsJson: '{}' },
      { ok: false, tool: 'none', summary: 'indisponível', output: {} },
    );
    expect(sendToolResult).not.toHaveBeenCalled();
  });
});

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

  it.each([
    ['pane-mshi87ry-4', 'id canônico'],
    ['1', 'número'],
    ['2', 'número'],
    ['pane 2', 'número falado'],
    ['#2', 'número com hash'],
    ['pane-2', 'número com hífen'],
    ['pane dois', 'número por extenso'],
    ['claude · worker', 'título falado'],
  ])(
    'MANTÉM paneId plausível sem pergunta pendente: %s (%s) — o operador endereça o pane',
    (paneId) => {
      const args: NexusRealtimeActionArgs = {
        action: 'send_to_pane',
        text: 'roda os testes',
        paneId,
      };
      const out = sanitizeNexusActionArgs(args, () => false);
      expect(out.args).toEqual(args);
      expect(out.strippedPaneId).toBeNull();
    },
  );

  it('apara espaços ao redor da referência para o renderer casar o id exato', () => {
    const out = sanitizeNexusActionArgs(
      { action: 'send_to_pane', text: 'oi', paneId: '  pane-9 \n' },
      () => false,
    );
    expect(out.args).toEqual({ action: 'send_to_pane', text: 'oi', paneId: 'pane-9' });
    expect(out.strippedPaneId).toBeNull();
  });

  it.each([
    ['   ', 'só espaços'],
    ['pane-1\nrm -rf /', 'quebra de linha'],
    ['pane-1\u0000', 'caractere nulo'],
    ['x'.repeat(81), 'gigante'],
  ])('REMOVE paneId ilegível (%j, %s) — cai no gate de delegação', (paneId) => {
    const out = sanitizeNexusActionArgs(
      { action: 'send_to_pane', text: 'rm -rf tudo', paneId },
      hasQuestionOn('pane-42'),
    );
    expect(out.args).toEqual({ action: 'send_to_pane', text: 'rm -rf tudo' });
    expect('paneId' in out.args).toBe(false);
    expect(out.strippedPaneId).toBe(paneId);
  });

  it('isPlausiblePaneRef aceita o que o renderer sabe resolver e barra o lixo', () => {
    for (const ok of ['pane-1', '7', '#7', 'pane 7', 'orq · squad', 'a'.repeat(80)]) {
      expect(isPlausiblePaneRef(ok)).toBe(true);
    }
    for (const bad of ['', '  ', 'a'.repeat(81), 'a\nb', 'a\tb']) {
      expect(isPlausiblePaneRef(bad)).toBe(false);
    }
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

describe('isExplicitEngineeringWorkIntent', () => {
  it.each([
    'corrija esse erro agora',
    'analise os logs e resolva o bug',
    'implemente a correção no login',
    'refactor the realtime controller',
    'analyze the logs and apply the patch',
    'faça a correção no realtime',
  ])('exige delegação para trabalho explícito: %s', (text) => {
    expect(isExplicitEngineeringWorkIntent(text)).toBe(true);
  });

  it.each([
    'como corrigir esse erro?',
    'por que o login falhou?',
    'o que você acha disso?',
    'Jarvis',
    'não analise os logs',
    'não implemente isso',
    'ele disse corrige o login',
    'she said apply the patch',
  ])('não transforma pergunta/conversa em trabalho: %s', (text) => {
    expect(isExplicitEngineeringWorkIntent(text)).toBe(false);
  });
});

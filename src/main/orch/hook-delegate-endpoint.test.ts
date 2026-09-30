import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../observability/main-trace', () => ({ trace: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ squadCliPolicy: 'governed' }),
}));
vi.mock('../context/business-model/business-model-ensure', () => ({
  ensureBusinessModel: vi.fn(async () => null),
}));

import { trace } from '../observability/main-trace';
import { ensureBusinessModel } from '../context/business-model/business-model-ensure';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { OPERATOR_DELEGATION_DOCTRINE } from './operator-delegation-doctrine';
import {
  AUXILIARY_CONTEXT_HEADER,
  MAESTRO_TURN_REMINDER,
  __resetLeanRemindersForTests,
  formatDelegationContext,
  handleHookDelegateHttp,
  handleHookDelegateRequest,
  parseUserPrompt,
} from './hook-delegate-endpoint';
import type { distillOperatorPreferenceMemory } from '../memory/operator-preference-memory';
import type { operatorWorkspaceMemoryContext } from './operator-workspace-memory';

const operator = { role: 'user' as const, sessionId: 's1' };
const LONG = 'Implemente a tela de login, escreva os testes e revise a segurança do fluxo.';

describe('hook /hook/delegate', () => {
  it('parseUserPrompt lê o prompt do payload UserPromptSubmit', () => {
    expect(parseUserPrompt({ hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe('x');
    expect(parseUserPrompt({ prompt: '' })).toBeNull();
    expect(parseUserPrompt('lixo')).toBeNull();
  });

  const delegation = (parts: number, writers: number) => ({
    delegation: { parts, writers, confidence: 0.8, model: 'j' },
    writesCode: 0.1,
  });

  it('aconselha: additionalContext curto com as partes', async () => {
    const advise = vi.fn(async () => delegation(3, 1));
    const out = await handleHookDelegateRequest(operator, { prompt: LONG }, { advise });
    const text = (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(out.payload.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
    expect(text).toContain('~3 partes');
    expect(text).toContain('nexus_pane_spawn');
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('a mão promovida pelo Main continua recebendo conselho de delegação', async () => {
    __resetLeanRemindersForTests();
    const ctx = { role: 'orchestrator' as const, missionId: 'm', sessionId: 'promoted', promotedFromUserSession: true as const };
    const out = await handleHookDelegateRequest(ctx, { prompt: LONG }, { advise: async () => delegation(3, 1) });
    expect(JSON.stringify(out.payload)).toContain('nexus_pane_spawn');
    expect((await handleHookDelegateRequest({ ...ctx, promotedFromUserSession: undefined }, { prompt: LONG }, { advise: async () => delegation(3, 1) })).payload).toEqual({});
  });

  it('silêncio: sem conselho, sessão de missão, worker, payload inválido, exceção', async () => {
    expect((await handleHookDelegateRequest(operator, { prompt: LONG }, { advise: vi.fn(async () => null) })).payload).toEqual({});
    const advise = vi.fn(async () => delegation(3, 0));
    expect((await handleHookDelegateRequest({ ...operator, missionId: 'm' }, { prompt: LONG }, { advise })).payload).toEqual({});
    expect((await handleHookDelegateRequest({ role: 'worker', sessionId: 's' }, { prompt: LONG }, { advise })).payload).toEqual({});
    expect((await handleHookDelegateRequest(operator, { nope: 1 }, { advise })).payload).toEqual({});
    expect(advise).not.toHaveBeenCalled();
    const boom = vi.fn(async () => { throw new Error('x'); });
    expect((await handleHookDelegateRequest(operator, { prompt: LONG }, { advise: boom })).payload).toEqual({});
  });

  describe('dica do navegador Nexus (pedido de página/extração/responsividade)', () => {
    it('pedido de extração recebe a dica do nexus_browser_*', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(
        operator,
        { prompt: 'quero extrair o título e o preço de https://exemplo.test' },
        { advise: vi.fn(async () => null) },
      );
      const text = (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(text).toContain('nexus_browser_*');
    });

    it('pedido de responsividade e de screenshot também disparam a dica', async () => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => null);
      const responsive = await handleHookDelegateRequest(
        operator,
        { prompt: 'analise a responsividade desta página' },
        { advise },
      );
      expect(
        (responsive.payload.hookSpecificOutput as { additionalContext: string }).additionalContext,
      ).toContain('nexus_browser_responsive');

      const shot = await handleHookDelegateRequest(
        { ...operator, sessionId: 's-shot' },
        { prompt: 'me manda um screenshot do dashboard' },
        { advise },
      );
      expect(
        (shot.payload.hookSpecificOutput as { additionalContext: string }).additionalContext,
      ).toContain('nexus_browser_*');
    });

    it('não dispara para pedidos sem sinal de página/extração (sem chamada extra ao Jev)', async () => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => null);
      const out = await handleHookDelegateRequest(operator, { prompt: LONG }, { advise });
      expect(out.payload).toEqual({});
    });

    it.each(['extrair o zip de release para dist/', 'faça a extração de método nesse service'])(
      '"extrair" fora de contexto web não dispara a dica: %s',
      async (prompt) => {
        __resetLeanRemindersForTests();
        const out = await handleHookDelegateRequest(operator, { prompt }, { advise: vi.fn(async () => null) });
        expect(JSON.stringify(out.payload)).not.toContain('nexus_browser_');
      },
    );

    it('lembra uma vez por sessão dentro do intervalo', async () => {
      __resetLeanRemindersForTests();
      let now = 2_000_000;
      const deps = { advise: vi.fn(async () => null), now: () => now };
      const prompt = 'extraia o nome e o preço desta página';
      expect((await handleHookDelegateRequest(operator, { prompt }, deps)).payload).not.toEqual({});
      expect((await handleHookDelegateRequest(operator, { prompt }, deps)).payload).toEqual({});
      now += 31 * 60_000;
      expect((await handleHookDelegateRequest(operator, { prompt }, deps)).payload).not.toEqual({});
    });
  });

  describe('lembrete da ponytail (pedido de código)', () => {
    const code = { delegation: null, writesCode: 0.9 };

    it('pedido de código recebe o lembrete curto da skill ponytail', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(operator, { prompt: LONG }, { advise: vi.fn(async () => code) });
      const text = (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(text).toContain('ponytail');
      expect(text.length).toBeLessThanOrEqual(260);
    });

    it('lembra uma vez por sessão dentro do intervalo, e de novo depois dele', async () => {
      __resetLeanRemindersForTests();
      let now = 1_000_000;
      const deps = { advise: vi.fn(async () => code), now: () => now };
      expect((await handleHookDelegateRequest(operator, { prompt: LONG }, deps)).payload).not.toEqual({});
      expect((await handleHookDelegateRequest(operator, { prompt: LONG }, deps)).payload).toEqual({});
      expect((await handleHookDelegateRequest({ ...operator, sessionId: 's2' }, { prompt: LONG }, deps)).payload)
        .not.toEqual({});
      now += 31 * 60_000;
      expect((await handleHookDelegateRequest(operator, { prompt: LONG }, deps)).payload).not.toEqual({});
    });

    it('conversa, pergunta ou leitura (writesCode baixo) não recebe lembrete', async () => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => ({ delegation: null, writesCode: 0.3 }));
      expect((await handleHookDelegateRequest(operator, { prompt: LONG }, { advise })).payload).toEqual({});
    });

    it('delegação e lembrete saem juntos no mesmo additionalContext', async () => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => ({ ...delegation(3, 1), writesCode: 0.9 }));
      const out = await handleHookDelegateRequest(operator, { prompt: LONG }, { advise });
      const text = (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(text).toContain('~3 partes');
      expect(text).toContain('ponytail');
      expect(text.length).toBeLessThanOrEqual(660);
    });
  });

  describe('contexto de design (pedido de interface)', () => {
    const scope = { rootRealPath: '/repo' } as never;
    const withScope = { ...operator, scope };
    const UI = 'Crie a tela de checkout de pagamentos com o resumo do pedido.';
    const noAdvice = vi.fn(async () => null);
    const designText = 'Regra de design do projeto (teste)';

    function context(out: { payload: Record<string, unknown> }): string {
      return (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
    }

    it('injeta a regra de design do workspace do pane, mesmo sem conselho do Jev', async () => {
      __resetLeanRemindersForTests();
      const design = vi.fn(() => designText);
      const out = await handleHookDelegateRequest(withScope, { prompt: UI }, { advise: noAdvice, design });
      expect(design).toHaveBeenCalledWith(UI, '/repo');
      expect(context(out)).toContain(designText);
    });

    it('prefere a worktree da execução ao checkout de coordenação', async () => {
      __resetLeanRemindersForTests();
      const design = vi.fn(() => designText);
      const ctx = { ...withScope, executionScope: { rootRealPath: '/repo/.nexus/worktrees/t1' } as never };
      await handleHookDelegateRequest(ctx, { prompt: UI }, { advise: noAdvice, design });
      expect(design).toHaveBeenCalledWith(UI, '/repo/.nexus/worktrees/t1');
    });

    it('uma vez por sessão dentro do intervalo', async () => {
      __resetLeanRemindersForTests();
      let now = 5_000_000;
      const deps = { advise: noAdvice, design: vi.fn(() => designText), now: () => now };
      expect(context(await handleHookDelegateRequest(withScope, { prompt: UI }, deps))).toContain(designText);
      expect((await handleHookDelegateRequest(withScope, { prompt: UI }, deps)).payload).toEqual({});
      now += 31 * 60_000;
      expect(context(await handleHookDelegateRequest(withScope, { prompt: UI }, deps))).toContain(designText);
    });

    it('helper que nasceu com a regra ou a carta no brief não recebe de novo', async () => {
      __resetLeanRemindersForTests();
      const design = vi.fn(() => designText);
      for (const brief of [`${UI}\n\nRegra de design do projeto (sempre que…)`, `${UI}\n\n# Design Charter (anti-generic AI look)`]) {
        expect((await handleHookDelegateRequest(withScope, { prompt: brief }, { advise: noAdvice, design })).payload)
          .toEqual({});
      }
      expect(design).not.toHaveBeenCalled();
    });

    it('sem escopo de workspace ou sem sessão, fica em silêncio', async () => {
      __resetLeanRemindersForTests();
      const design = vi.fn(() => designText);
      expect((await handleHookDelegateRequest(operator, { prompt: UI }, { advise: noAdvice, design })).payload).toEqual({});
      expect((await handleHookDelegateRequest({ role: 'user' as const, scope }, { prompt: UI }, { advise: noAdvice, design })).payload)
        .toEqual({});
      expect(design).not.toHaveBeenCalled();
    });

    it('Jev com erro não derruba o contexto de design', async () => {
      __resetLeanRemindersForTests();
      const boom = vi.fn(async () => { throw new Error('x'); });
      const out = await handleHookDelegateRequest(withScope, { prompt: UI }, { advise: boom, design: () => designText });
      expect(context(out)).toContain(designText);
    });
  });

  it('no Codex o contexto se apresenta como auxiliar (chega depois do prompt)', async () => {
    __resetLeanRemindersForTests();
    const advise = vi.fn(async () => delegation(3, 1));
    const codex = await handleHookDelegateRequest({ ...operator, providerId: 'codex' }, { prompt: LONG }, { advise });
    const claude = await handleHookDelegateRequest({ ...operator, providerId: 'claude' }, { prompt: LONG }, { advise });
    const text = (out: typeof codex) => (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(text(codex).startsWith(AUXILIARY_CONTEXT_HEADER)).toBe(true);
    expect(text(claude)).not.toContain(AUXILIARY_CONTEXT_HEADER);
  });

  it('Codex recebe a doutrina do operador pelo hook, uma vez por sessão a cada 30 min', async () => {
    __resetLeanRemindersForTests();
    let now = 9_000_000;
    const deps = { advise: vi.fn(async () => null), now: () => now };
    const codex = { ...operator, providerId: 'codex' };
    const text = (out: { payload: Record<string, unknown> }) =>
      (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
    const first = text(await handleHookDelegateRequest(codex, { prompt: 'oi, tudo certo?' }, deps));
    expect(first.startsWith(AUXILIARY_CONTEXT_HEADER)).toBe(true);
    expect(first).toContain(OPERATOR_DELEGATION_DOCTRINE);
    expect((await handleHookDelegateRequest(codex, { prompt: 'e agora?' }, deps)).payload).toEqual({});
    now += 31 * 60_000;
    expect(text(await handleHookDelegateRequest(codex, { prompt: 'de novo' }, deps))).toContain(OPERATOR_DELEGATION_DOCTRINE);
    // Claude lê as instructions do MCP uma vez no system prompt: não precisa do hook.
    expect((await handleHookDelegateRequest({ ...operator, providerId: 'claude' }, { prompt: 'oi' }, deps)).payload)
      .toEqual({});
  });

  describe('Maestro de missão (F-701)', () => {
    const maestro = { role: 'orchestrator' as const, missionId: 'm', sessionId: 'maestro' };
    const text = (out: { payload: Record<string, unknown> }) =>
      (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;

    it('lembra de delegar a cada 30 min, também na entrega de um worker; entrega não vai ao Jev', async () => {
      __resetLeanRemindersForTests();
      let now = 5_000_000;
      const advise = vi.fn(async () => null);
      const deps = { advise, now: () => now, maestroDoctrine: () => 'DOUTRINA' };
      const delivery = '[nexus handoff delivery_metadata] from=pane-w1 handoff_id=h-7 summary: pronto';
      expect(text(await handleHookDelegateRequest(maestro, { prompt: delivery }, deps))).toBe(MAESTRO_TURN_REMINDER);
      expect(advise).not.toHaveBeenCalled();
      now += 60_000;
      expect((await handleHookDelegateRequest(maestro, { prompt: 'solta mais panes' }, deps)).payload).toEqual({});
      now += 30 * 60_000;
      expect(text(await handleHookDelegateRequest(maestro, { prompt: 'e agora?' }, deps))).toBe(MAESTRO_TURN_REMINDER);
      expect(advise).toHaveBeenCalledTimes(2);
    });

    it('F-708: pedido divisível digitado no Maestro vira "abra N workers", no lugar do lembrete', async () => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => delegation(4, 1));
      const out = await handleHookDelegateRequest(
        maestro,
        { prompt: LONG },
        { advise, maestroDoctrine: () => 'DOUTRINA' },
      );
      expect(text(out)).toContain('~4 partes (3 de leitura, 1 de escrita)');
      expect(text(out)).toContain('Não faça as partes você mesmo');
      expect(text(out)).not.toContain(MAESTRO_TURN_REMINDER);
    });

    it('F-708: missão de execução direta não recebe diretiva nem chama o Jev', async () => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => delegation(4, 1));
      const out = await handleHookDelegateRequest(maestro, { prompt: LONG }, { advise, maestroDoctrine: () => null });
      expect(out.payload).toEqual({});
      expect(advise).not.toHaveBeenCalled();
    });

    it('o Codex, que não lê as instructions do MCP, recebe a doutrina inteira', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(
        { ...maestro, providerId: 'codex' },
        { prompt: 'continue' },
        { advise: vi.fn(async () => null), maestroDoctrine: () => 'DOUTRINA DO MAESTRO' },
      );
      expect(text(out)).toBe(`${AUXILIARY_CONTEXT_HEADER}\nDOUTRINA DO MAESTRO`);
    });

    it('a mão promovida recebe o lembrete junto com o conselho do Jev', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(
        { ...maestro, promotedFromUserSession: true as const },
        { prompt: LONG },
        { advise: async () => delegation(3, 1), maestroDoctrine: () => 'DOUTRINA' },
      );
      expect(text(out)).toContain(MAESTRO_TURN_REMINDER);
      expect(text(out)).toContain('~3 partes');
    });

    it('missão sem delegação (execução direta, pergunta aos panes), worker e operador sem missão: nada', async () => {
      __resetLeanRemindersForTests();
      const deps = { advise: vi.fn(async () => null), maestroDoctrine: () => null };
      expect((await handleHookDelegateRequest(maestro, { prompt: 'oi' }, deps)).payload).toEqual({});
      const always = { advise: vi.fn(async () => null), maestroDoctrine: () => 'DOUTRINA' };
      expect((await handleHookDelegateRequest({ role: 'worker', missionId: 'm', sessionId: 'w' }, { prompt: 'oi' }, always)).payload)
        .toEqual({});
      expect((await handleHookDelegateRequest({ ...operator, providerId: 'claude' }, { prompt: 'oi' }, always)).payload)
        .toEqual({});
    });
  });

  it('entrega de handoff de helper não é pedido novo: nem Jev nem contexto', async () => {
    __resetLeanRemindersForTests();
    const advise = vi.fn(async () => ({ ...delegation(5, 0), writesCode: 0.9 }));
    const design = vi.fn(() => 'Regra de design do projeto (teste)');
    const delivery = '[handoff sem missão] de pane-7 (Grok): Inventário concluído. Top 5: recall, cartas, fechamento, design, isolatedWriter.';
    const out = await handleHookDelegateRequest(
      { ...operator, scope: { rootRealPath: '/repo' } as never }, { prompt: delivery }, { advise, design },
    );
    expect(out.payload).toEqual({});
    expect(advise).not.toHaveBeenCalled();
    expect(design).not.toHaveBeenCalled();
  });

  describe('prompt que não é pedido do operador (F-200)', () => {
    it.each([
      '<task-notification> <task-id>bzthj2b8r</task-id> <tool-use-id>t1</tool-use-id> resumo</task-notification>',
      '[nexus handoff delivery_metadata] from=pane-w1 handoff_id=h-7 summary: Inventário pronto',
      '<pasted_content id="p9">[nexus handoff delivery_metadata] from=pane-w1 handoff_id=h-7 summary: Inventário pronto</pasted_content>',
      'Stop hook feedback: o trabalho continua; siga com a próxima etapa',
      'Base directory for this skill: /x/skills/ponytail — leia as regras completas',
      '[Nexus] Você agora orquestra a missão Missão · Checkout',
      '[Nexus · Jev] Esta tarefa se divide em ~3 partes — delegue',
      '  <pasted_content id="p2"><task-notification>done</task-notification></pasted_content>',
      `contexto do crash\n\n${FAILOVER_HANDOFF_HEADER}\nrecupere a missão anterior`,
    ])('cai fora sem chamar o Jev: %.36s…', async (prompt) => {
      __resetLeanRemindersForTests();
      const advise = vi.fn(async () => ({ delegation: { parts: 5, writers: 2, confidence: 0.95, model: 'j' }, writesCode: 0.9 }));
      const design = vi.fn(() => 'Regra de design (teste)');
      const out = await handleHookDelegateRequest(
        { ...operator, scope: { rootRealPath: '/repo' } as never, providerId: 'codex' },
        { prompt },
        { advise, design },
      );
      expect(out.payload, prompt).toEqual({});
      expect(advise).not.toHaveBeenCalled();
      expect(design).not.toHaveBeenCalled();
    });
  });

  describe('auto-orquestração no Autopilot (F-200)', () => {
    const FIELD_PROMPT =
      '/Users/cleofasrocha/saasbarbearia/.nexus/attachments/mission-context/' +
      'mumvufy7-3926d22fdca6c5ab-WhatsApp_Ptt_2026-09-29_at_13.20.08.ogg  ' +
      'olha  oque ele pediu e  ja faz sime  coloca nativo e no  pwa e web';
    const strong = {
      delegation: { parts: 3, writers: 2, confidence: 0.84, model: 'j' },
      writesCode: 0.1,
    };
    const context = (out: { payload: Record<string, unknown> }) =>
      (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;

    it('pedido divisível com confiança ≥ 0,7 torna o pane orquestrador e troca a dica pela diretiva', async () => {
      __resetLeanRemindersForTests();
      const adoptMission = vi.fn((_ctx: unknown, _summary: string | null) => ({
        missionId: 'm-auto',
        discardIfUnused: vi.fn(),
      }));
      const out = await handleHookDelegateRequest(
        operator,
        { prompt: FIELD_PROMPT },
        {
          advise: vi.fn(async () => strong),
          autopilot: () => true,
          adoptMission,
        },
      );
      const text = context(out);
      expect(adoptMission).toHaveBeenCalledTimes(1);
      expect(adoptMission.mock.calls[0]![1]).toBe(
        'olha oque ele pediu e ja faz sime coloca nativo e no pwa e web',
      );
      expect(text).toContain('O Nexus tornou este pane orquestrador de uma missão');
      expect(text).toContain('isolatedWriter: true');
      expect(text).not.toContain('Delegue com nexus_pane_spawn');
      expect(text.length).toBeLessThanOrEqual(500);
      expect(vi.mocked(trace)).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'auto-orchestrate',
          sessionId: 's1',
          missionId: 'm-auto',
          parts: 3,
          writers: 2,
        }),
      );
    });

    it('confiança abaixo de 0,7 fica só na dica (não adoça nada)', async () => {
      __resetLeanRemindersForTests();
      const adoptMission = vi.fn();
      const out = await handleHookDelegateRequest(
        operator,
        { prompt: FIELD_PROMPT },
        {
          advise: vi.fn(async () => ({
            delegation: { parts: 3, writers: 2, confidence: 0.65, model: 'j' },
            writesCode: 0.1,
          })),
          autopilot: () => true,
          adoptMission,
        },
      );
      expect(adoptMission).not.toHaveBeenCalled();
      expect(context(out)).toContain('Delegue com nexus_pane_spawn');
    });

    it('Hardened com a mesma confiança fica só na dica', async () => {
      __resetLeanRemindersForTests();
      const adoptMission = vi.fn();
      const out = await handleHookDelegateRequest(
        operator,
        { prompt: FIELD_PROMPT },
        { advise: vi.fn(async () => strong), autopilot: () => false, adoptMission },
      );
      expect(adoptMission).not.toHaveBeenCalled();
      expect(context(out)).toContain('Delegue com nexus_pane_spawn');
    });

    it('helper do operador e pane com missão nunca são adotados', async () => {
      __resetLeanRemindersForTests();
      const adoptMission = vi.fn();
      const deps = {
        advise: vi.fn(async () => strong),
        autopilot: () => true,
        adoptMission,
      };
      const helper = await handleHookDelegateRequest(
        { ...operator, operatorParentSessionId: 'parent-1' },
        { prompt: FIELD_PROMPT },
        deps,
      );
      expect(context(helper)).toContain('Delegue com nexus_pane_spawn');
      const inMission = await handleHookDelegateRequest(
        { ...operator, missionId: 'm-1' },
        { prompt: FIELD_PROMPT },
        deps,
      );
      expect(inMission.payload).toEqual({});
      expect(adoptMission).not.toHaveBeenCalled();
    });

    it.each([null, undefined])(
      'adoção devolvendo %s mantém a dica normal',
      async (adopted) => {
        __resetLeanRemindersForTests();
        const adoptMission = vi.fn(() => adopted ?? null);
        const out = await handleHookDelegateRequest(
          operator,
          { prompt: FIELD_PROMPT },
          { advise: vi.fn(async () => strong), autopilot: () => true, adoptMission },
        );
        expect(context(out)).toContain('Delegue com nexus_pane_spawn');
      },
    );

    it('adoção que lança mantém a dica normal', async () => {
      __resetLeanRemindersForTests();
      const adoptMission = vi.fn(() => {
        throw new Error('pane sumiu');
      });
      const out = await handleHookDelegateRequest(
        operator,
        { prompt: FIELD_PROMPT },
        { advise: vi.fn(async () => strong), autopilot: () => true, adoptMission },
      );
      expect(context(out)).toContain('Delegue com nexus_pane_spawn');
    });

    it('prompt que é só o anexo adota com summary null (o provider dá o título)', async () => {
      __resetLeanRemindersForTests();
      const onlyAttachment =
        '/Users/cleofasrocha/saasbarbearia/.nexus/attachments/mission-context/' +
        'mumvufy7-3926d22fdca6c5ab-WhatsApp_Ptt_2026-09-29_at_13.20.08.ogg';
      const adoptMission = vi.fn(() => ({ missionId: 'm-2', discardIfUnused: vi.fn() }));
      await handleHookDelegateRequest(
        operator,
        { prompt: onlyAttachment },
        { advise: vi.fn(async () => strong), autopilot: () => true, adoptMission },
      );
      expect(adoptMission).toHaveBeenCalledWith(expect.anything(), null);
    });
  });

  it('pedido de código de helper que já nasceu com as regras da ponytail não recebe o lembrete', async () => {
    __resetLeanRemindersForTests();
    const advise = vi.fn(async () => ({ delegation: null, writesCode: 0.9 }));
    const brief = `${LONG}\n\n# Ponytail, lazy senior dev mode\n...`;
    expect((await handleHookDelegateRequest(operator, { prompt: brief }, { advise })).payload).toEqual({});
  });

  it('formatDelegationContext conta leitura e escrita', () => {
    expect(formatDelegationContext({ parts: 4, writers: 1, confidence: 0.9, model: 'j' })).toContain(
      '3 de leitura em paralelo, 1 de escrita',
    );
  });

  describe('HTTP', () => {
    const servers: http.Server[] = [];
    afterEach(() => {
      for (const server of servers.splice(0)) server.close();
    });

    // http.request (não fetch): o servidor responde 400 ANTES de ler o corpo
    // inteiro e fecha a conexão; o cliente do node entrega a resposta mesmo
    // assim, enquanto o fetch pode ver só o reset.
    async function post(ctx: unknown, body: string): Promise<number> {
      const server = http.createServer((req, res) => {
        void handleHookDelegateHttp(req, res, ctx as never);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/hook/delegate', method: 'POST' },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    }

    it('401 sem bearer; 400 para corpo acima de 64 KB (Jev nem é chamado)', async () => {
      expect(await post(null, '{}')).toBe(401);
      expect(
        await post({ role: 'user', sessionId: 's' }, JSON.stringify({ prompt: 'x'.repeat(70_000) })),
      ).toBe(400);
    });
  });
});

describe('preferência do operador (fatia 3 da memória)', () => {
  const scope = {
    version: 1,
    installationId: 'i',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath: '/tmp/p',
    identitySource: 'manifest',
  } as never;
  const noDistill = () =>
    vi.fn<typeof distillOperatorPreferenceMemory>(async () => ({
      retained: false,
      reason: 'no-marker',
    }));

  it('chama a destilação de preferência com o scope do workspace', async () => {
    const distillPreference = noDistill();
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 's1', scope },
      { prompt: 'Sempre use pnpm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference },
    );
    expect(distillPreference).toHaveBeenCalledWith(scope, 'Sempre use pnpm neste projeto.');
  });

  it('não destila sem scope, em pane de missão nem em entrega de handoff', async () => {
    const distillPreference = noDistill();
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 's1' },
      { prompt: 'Sempre use pnpm.' },
      { advise: vi.fn(async () => null), distillPreference },
    );
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 's1', missionId: 'm', scope },
      { prompt: 'Sempre use pnpm.' },
      { advise: vi.fn(async () => null), distillPreference },
    );
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 's1', scope },
      { prompt: '[handoff sem missão] ignore' },
      { advise: vi.fn(async () => null), distillPreference },
    );
    expect(distillPreference).not.toHaveBeenCalled();
  });

  it('brief de helper (pane aberto por agente) e pack de failover nunca viram preferência', async () => {
    const distillPreference = noDistill();
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 'helper-1', scope, operatorParentSessionId: 'operator-pane' },
      { prompt: 'Sempre use npm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference },
    );
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 's1', scope },
      { prompt: '[NEXUS FAILOVER HANDOFF]\nSempre use npm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference },
    );
    expect(distillPreference).not.toHaveBeenCalled();
  });
});

describe('bloco <workspace-memory> no primeiro prompt do Codex (fatia 4)', () => {
  const scope = {
    version: 1,
    installationId: 'i',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath: '/tmp/p',
    identitySource: 'manifest',
  } as never;

  const block = vi.fn<typeof operatorWorkspaceMemoryContext>(
    () => '<workspace-memory phase="execution">x</workspace-memory>',
  );

  it('entrega o bloco uma única vez por sessão', async () => {
    __resetLeanRemindersForTests();
    const first = await handleHookDelegateRequest(
      { role: 'user', sessionId: 'mem-1', scope, providerId: 'codex' },
      { prompt: 'Implemente o fluxo de login.' },
      { advise: vi.fn(async () => null), memoryBlock: block },
    );
    const firstText = (first.payload.hookSpecificOutput as { additionalContext: string })
      .additionalContext;
    expect(firstText).toContain('<workspace-memory');

    const second = await handleHookDelegateRequest(
      { role: 'user', sessionId: 'mem-1', scope, providerId: 'codex' },
      { prompt: 'Agora os testes do fluxo.' },
      { advise: vi.fn(async () => null), memoryBlock: block },
    );
    expect(second.payload).toEqual({});
  });

  it('mudança de assunto recebe memórias novas na mesma sessão, sem esperar 30 minutos', async () => {
    __resetLeanRemindersForTests();
    const ctx = { role: 'user' as const, sessionId: 'mem-topics', scope, providerId: 'codex' };
    const memoryBlock = vi.fn<typeof operatorWorkspaceMemoryContext>((_ctx, _channel, prompt) =>
      `<workspace-memory>${prompt?.includes('pagamento') ? 'Pagamento exige idempotência' : 'Login usa o helper existente'}</workspace-memory>`,
    );
    const deps = { advise: vi.fn(async () => null), memoryBlock, now: () => 1000 };
    await handleHookDelegateRequest(ctx, { prompt: 'Corrija o login' }, deps);
    const next = await handleHookDelegateRequest(ctx, { prompt: 'Agora corrija o pagamento' }, deps);
    expect(JSON.stringify(next.payload)).toContain('Pagamento exige idempotência');
    expect(JSON.stringify(next.payload)).not.toContain('Login usa');
    expect((await handleHookDelegateRequest(ctx, { prompt: 'Mais um ajuste no pagamento' }, deps)).payload).toEqual({});
  });

  it('memória atualizada na mesma tarefa chega imediatamente; consulta falha não impede o prompt', async () => {
    __resetLeanRemindersForTests();
    const ctx = { role: 'user' as const, sessionId: 'mem-updated', scope, providerId: 'codex' };
    const memoryBlock = vi.fn<typeof operatorWorkspaceMemoryContext>()
      .mockReturnValueOnce('<workspace-memory>V1</workspace-memory>')
      .mockReturnValueOnce('<workspace-memory>V2 corrigida</workspace-memory>')
      .mockImplementationOnce(() => { throw new Error('banco indisponível'); });
    const deps = { advise: vi.fn(async () => null), memoryBlock, now: () => 1000 };
    await handleHookDelegateRequest(ctx, { prompt: LONG }, deps);
    expect(JSON.stringify((await handleHookDelegateRequest(ctx, { prompt: LONG }, deps)).payload)).toContain('V2 corrigida');
    expect((await handleHookDelegateRequest(ctx, { prompt: LONG }, deps)).payload).toEqual({});
  });

  it('banco vazio (bloco null) não marca a sessão: entrega depois quando houver', async () => {
    __resetLeanRemindersForTests();
    const empty = vi.fn<typeof operatorWorkspaceMemoryContext>(() => null);
    const filled = vi.fn<typeof operatorWorkspaceMemoryContext>(
      () => '<workspace-memory phase="execution">y</workspace-memory>',
    );
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 'mem-2', scope, providerId: 'codex' },
      { prompt: 'Implemente o fluxo.' },
      { advise: vi.fn(async () => null), memoryBlock: empty },
    );
    const later = await handleHookDelegateRequest(
      { role: 'user', sessionId: 'mem-2', scope, providerId: 'codex' },
      { prompt: 'Implemente o fluxo.' },
      { advise: vi.fn(async () => null), memoryBlock: filled },
    );
    expect(
      (later.payload.hookSpecificOutput as { additionalContext: string }).additionalContext,
    ).toContain('<workspace-memory');
  });

  it('pede o bloco pelo canal do hook com o prompt da mensagem', async () => {
    __resetLeanRemindersForTests();
    const memoryBlock = vi.fn<typeof operatorWorkspaceMemoryContext>(() => null);
    const ctx = { role: 'user' as const, sessionId: 'mem-3', providerId: 'codex' };
    await handleHookDelegateRequest(
      ctx,
      { prompt: 'Implemente o fluxo.' },
      { advise: vi.fn(async () => null), memoryBlock },
    );
    expect(memoryBlock).toHaveBeenCalledWith(ctx, 'hook', 'Implemente o fluxo.');
  });
});

describe('<business-model> por tarefa no hook do operador', () => {
  const scope = { rootRealPath: '/repo', projectId: 'p1', checkoutId: 'c1' } as never;
  // Claude tem o delegate hook sem a doutrina por-turno do Codex — isola o teste.
  const codex = { ...operator, providerId: 'claude', scope };
  const text = (out: { payload: Record<string, unknown> }) =>
    (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;

  it('o bloco selecionado entra no additionalContext; idêntico em 30 min é suprimido, diferente passa', async () => {
    __resetLeanRemindersForTests();
    let now = 4_000_000;
    const businessContext = vi.fn(async () => '<business-model>selecionado</business-model>');
    const deps = { advise: vi.fn(async () => null), businessContext, now: () => now };
    expect(text(await handleHookDelegateRequest(codex, { prompt: LONG }, deps)))
      .toContain('<business-model>selecionado');
    // Mesmo conteúdo na mesma sessão dentro do intervalo: suprimido.
    expect((await handleHookDelegateRequest(codex, { prompt: 'mesma tarefa' }, deps)).payload)
      .toEqual({});
    // Seleção nova (outra tarefa/outro fluxo) sempre passa — dedup é por hash.
    businessContext.mockResolvedValue('<business-model>nova seleção</business-model>');
    expect(text(await handleHookDelegateRequest(codex, { prompt: 'outra tarefa' }, deps)))
      .toContain('nova seleção');
    // Depois do intervalo, até o idêntico volta a entrar.
    now += 31 * 60_000;
    expect(text(await handleHookDelegateRequest(codex, { prompt: 'de novo' }, deps)))
      .toContain('nova seleção');
  });

  it('bloco null não gera contexto e exceção é fail-open', async () => {
    __resetLeanRemindersForTests();
    // design: null isola o teste — o prompt LONG cita "tela" e acionaria a regra.
    const none = {
      advise: vi.fn(async () => null),
      businessContext: vi.fn(async () => null),
      design: () => null,
    };
    expect((await handleHookDelegateRequest(codex, { prompt: LONG }, none)).payload).toEqual({});
    const boom = {
      advise: vi.fn(async () => null),
      design: () => null,
      businessContext: vi.fn(async () => {
        throw new Error('seleção explodiu');
      }),
    };
    expect(
      (await handleHookDelegateRequest({ ...codex, sessionId: 's-boom' }, { prompt: LONG }, boom))
        .payload,
    ).toEqual({});
  });

  it('sem sessionId o bloco por tarefa não é chamado', async () => {
    __resetLeanRemindersForTests();
    const businessContext = vi.fn(async () => 'X');
    await handleHookDelegateRequest(
      { role: 'user', scope, providerId: 'claude' } as never,
      { prompt: LONG },
      { advise: vi.fn(async () => null), businessContext },
    );
    expect(businessContext).not.toHaveBeenCalled();
  });

  it('dispara o ensure do modelo do HEAD uma vez por sessão a cada 30 min', async () => {
    __resetLeanRemindersForTests();
    vi.mocked(ensureBusinessModel).mockClear();
    let now = 7_000_000;
    const deps = {
      advise: vi.fn(async () => null),
      businessContext: vi.fn(async () => null),
      now: () => now,
    };
    await handleHookDelegateRequest(codex, { prompt: LONG }, deps);
    await handleHookDelegateRequest(codex, { prompt: 'outro' }, deps);
    expect(ensureBusinessModel).toHaveBeenCalledTimes(1);
    expect(ensureBusinessModel).toHaveBeenCalledWith(scope, { wait: false });
    now += 31 * 60_000;
    await handleHookDelegateRequest(codex, { prompt: LONG }, deps);
    expect(ensureBusinessModel).toHaveBeenCalledTimes(2);
  });
});

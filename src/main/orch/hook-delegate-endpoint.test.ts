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
// F-784: o teto seguro real depende da RAM e dos panes desta máquina; os
// testes antigos rodam sem teto e os novos injetam o orçamento.
vi.mock('./parallel-helper-budget', () => ({
  currentParallelHelperBudget: vi.fn(() => null),
}));

import { trace } from '../observability/main-trace';
import { currentParallelHelperBudget } from './parallel-helper-budget';
import { ensureBusinessModel } from '../context/business-model/business-model-ensure';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { DELEGATE_TIMEOUT_MS } from '../jev/jev-delegation';
import { OPERATOR_DELEGATION_DOCTRINE } from './operator-delegation-doctrine';
import {
  AUXILIARY_CONTEXT_HEADER,
  MAESTRO_TURN_REMINDER,
  additionalContextText,
  __resetLeanRemindersForTests,
  formatDelegationContext,
  handleHookDelegateHttp,
  handleHookDelegateRequest,
  parseUserPrompt,
} from './hook-delegate-endpoint';
import type { distillOperatorPreferenceMemory } from '../memory/operator-preference-memory';
import type { operatorWorkspaceMemoryContext } from './operator-workspace-memory';
import type { ParallelHelperBudget } from './pane-admission';
import { recordSessionInputReceipt, forgetSessionInputReceipt } from './operator-input-receipts';

const operator = { role: 'user' as const, sessionId: 's1' };
const LONG = 'Implemente a tela de login, escreva os testes e revise a segurança do fluxo.';
/** Pedido que não é de código: não aciona o lembrete da ponytail (pré-filtro por verbo). */
const NOT_CODE = 'Como está o andamento da missão e o que o time decidiu ontem?';

describe('hook /hook/delegate', () => {
  it('parseUserPrompt lê o prompt do payload UserPromptSubmit', () => {
    expect(parseUserPrompt({ hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe('x');
    expect(parseUserPrompt({ prompt: '' })).toBeNull();
    expect(parseUserPrompt('lixo')).toBeNull();
  });

  it('parseUserPrompt lê as partes de texto do Kimi (F-802) e ignora o que não é texto', () => {
    expect(parseUserPrompt({ prompt: [{ type: 'text', text: 'revise o login' }, { type: 'text', text: 'e o logout' }] }))
      .toBe('revise o login\ne o logout');
    expect(parseUserPrompt({ prompt: [{ type: 'image_url', url: 'x' }, { type: 'text', text: '  ' }] })).toBeNull();
    expect(parseUserPrompt({ prompt: [] })).toBeNull();
    expect(parseUserPrompt({ prompt: 42 })).toBeNull();
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

  it('F-753: a skill do projeto que o Jev escolhe chega ao pane do operador, uma vez por sessão', async () => {
    __resetLeanRemindersForTests();
    const suggestSkill = vi.fn(async () => ({
      name: 'bmad-create-prd',
      pkg: 'project',
      confidence: 0.84,
      path: '.claude/skills/bmad-create-prd/SKILL.md',
    }));
    const scoped = {
      ...operator,
      sessionId: 'skill-1',
      scope: { rootRealPath: '/w/hipergo' } as never,
    };
    const first = await handleHookDelegateRequest(
      scoped,
      { prompt: 'escreva o PRD do checkout' },
      { advise: vi.fn(async () => null), suggestSkill },
    );
    expect((first.payload.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      '[Nexus · Jev] Skill útil para este pedido: bmad-create-prd — leia `.claude/skills/bmad-create-prd/SKILL.md` antes de começar.',
    );
    expect(suggestSkill).toHaveBeenCalledWith('escreva o PRD do checkout', {
      allowedSkills: null,
      projectRoot: '/w/hipergo',
      sessionId: 'skill-1',
      timeoutMs: DELEGATE_TIMEOUT_MS,
      signal: expect.any(AbortSignal),
    });
    const again = await handleHookDelegateRequest(
      scoped,
      { prompt: 'agora ajuste o PRD' },
      { advise: vi.fn(async () => null), suggestSkill },
    );
    expect(again.payload).toEqual({});
  });

  it('F-753: consulta de skill sem resposta não segura o pedido além do teto da delegação', async () => {
    // O hook do Claude corta em 5 s e levaria junto o conselho de delegação.
    __resetLeanRemindersForTests();
    const hanging = vi.fn(
      (_prompt: string, opts: { signal?: AbortSignal }) =>
        new Promise<null>((resolve) => opts.signal?.addEventListener('abort', () => resolve(null))),
    );
    const startedAt = Date.now();
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'skill-slow' },
      { prompt: LONG },
      { advise: vi.fn(async () => delegation(3, 1)), suggestSkill: hanging as never },
    );
    expect(Date.now() - startedAt).toBeLessThan(DELEGATE_TIMEOUT_MS + 1_500);
    expect(JSON.stringify(out.payload)).toContain('nexus_pane_spawn');
  }, 10_000);

  it('F-753: skill sem confiança suficiente não entra no pedido', async () => {
    __resetLeanRemindersForTests();
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'skill-2' },
      { prompt: 'escreva o PRD do checkout' },
      {
        advise: vi.fn(async () => null),
        suggestSkill: vi.fn(async () => ({ name: 'bmad-create-prd', pkg: 'project', confidence: 0.65 })),
      },
    );
    // PRD é escrita, não código: nem skill fraca nem o lembrete da ponytail.
    expect(out.payload).toEqual({});
  });

  it('F-1309: sem sugestão e com sinal de degradação, o aviso aparece uma vez por sessão', async () => {
    __resetLeanRemindersForTests();
    const degraded = '[Nexus] Sugestão de skill indisponível: sem credencial do Jev.';
    const scoped = { ...operator, sessionId: 'deg-1' };
    const first = await handleHookDelegateRequest(
      scoped,
      { prompt: 'escreva o PRD do checkout' },
      {
        advise: vi.fn(async () => null),
        suggestSkill: vi.fn(async () => null),
        skillDegradation: () => degraded,
      },
    );
    expect((first.payload.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      'Sugestão de skill indisponível',
    );
    // Uma vez por sessão: o segundo pedido do mesmo pane não repete o aviso.
    const again = await handleHookDelegateRequest(
      scoped,
      { prompt: 'agora ajuste o PRD' },
      {
        advise: vi.fn(async () => null),
        suggestSkill: vi.fn(async () => null),
        skillDegradation: () => degraded,
      },
    );
    expect(again.payload).toEqual({});
  });

  it('a mão promovida pelo Main continua recebendo conselho de delegação', async () => {
    __resetLeanRemindersForTests();
    const ctx = { role: 'orchestrator' as const, missionId: 'm', sessionId: 'promoted', promotedFromUserSession: true as const };
    const out = await handleHookDelegateRequest(ctx, { prompt: LONG }, { advise: async () => delegation(3, 1) });
    expect(JSON.stringify(out.payload)).toContain('nexus_pane_spawn');
    expect((await handleHookDelegateRequest({ ...ctx, promotedFromUserSession: undefined }, { prompt: LONG }, { advise: async () => delegation(3, 1) })).payload).toEqual({});
  });

  it('silêncio: sem conselho, sessão de missão, worker, payload inválido, exceção', async () => {
    expect((await handleHookDelegateRequest(operator, { prompt: NOT_CODE }, { advise: vi.fn(async () => null) })).payload).toEqual({});
    const advise = vi.fn(async () => delegation(3, 0));
    expect((await handleHookDelegateRequest({ ...operator, missionId: 'm' }, { prompt: LONG }, { advise })).payload).toEqual({});
    expect((await handleHookDelegateRequest({ role: 'worker', sessionId: 's' }, { prompt: LONG }, { advise })).payload).toEqual({});
    expect((await handleHookDelegateRequest(operator, { nope: 1 }, { advise })).payload).toEqual({});
    expect(advise).not.toHaveBeenCalled();
    const boom = vi.fn(async () => { throw new Error('x'); });
    expect((await handleHookDelegateRequest(operator, { prompt: NOT_CODE }, { advise: boom })).payload).toEqual({});
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
      const out = await handleHookDelegateRequest(operator, { prompt: NOT_CODE }, { advise });
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

    it('sem conselho do Jev, o pré-filtro por verbo decide: pedido de código recebe', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(operator, { prompt: LONG }, { advise: vi.fn(async () => null) });
      const text = (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(text).toContain('ponytail');
    });

    it('sem conselho do Jev, pedido que não é de código segue em silêncio', async () => {
      __resetLeanRemindersForTests();
      expect((await handleHookDelegateRequest(operator, { prompt: NOT_CODE }, { advise: vi.fn(async () => null) })).payload)
        .toEqual({});
    });

    // Revisão do PR #164: "escreva", "crie" e "ajuste" também são escrita de
    // texto. Sem conselho do Jev, o verbo só conta com contexto de código; em
    // inglês, "add/create/delete/remove" entram junto do português.
    it.each([
      'escreva o PRD do checkout',
      'crie um resumo da reunião de ontem',
      'ajuste o texto do e-mail para o cliente',
      'remove the duplicate paragraph from the announcement',
      'mude o título do e-mail de boas-vindas',
    ])('sem conselho do Jev, escrita que não é código não recebe o lembrete: %s', async (prompt) => {
      __resetLeanRemindersForTests();
      expect(JSON.stringify((await handleHookDelegateRequest(operator, { prompt }, { advise: vi.fn(async () => null) })).payload))
        .not.toContain('ponytail');
    });

    it.each([
      'add validation to the signup form',
      'create a component for the pricing table',
      'delete this handler from `routes.ts`',
      'corrija o bug do login',
      'adicione um endpoint de exportação na API',
      'refatore o checkout',
      'edit this component',
      'change the endpoint',
      'modify the validation function',
      'edite o componente de login',
      'altere a função de cálculo do frete',
      'update package.json',
    ])('sem conselho do Jev, pedido de código recebe o lembrete: %s', async (prompt) => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(operator, { prompt }, { advise: vi.fn(async () => null) });
      expect(JSON.stringify(out.payload)).toContain('ponytail');
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
        expect(JSON.stringify((await handleHookDelegateRequest(withScope, { prompt: brief }, { advise: noAdvice, design })).payload))
          .not.toContain(designText);
      }
      expect(design).not.toHaveBeenCalled();
    });

    it('sem escopo de workspace ou sem sessão, fica em silêncio', async () => {
      __resetLeanRemindersForTests();
      const design = vi.fn(() => designText);
      expect(JSON.stringify((await handleHookDelegateRequest(operator, { prompt: UI }, { advise: noAdvice, design })).payload))
        .not.toContain(designText);
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

  it('Kimi (F-802): o contexto se apresenta como auxiliar e a doutrina chega pelo hook, uma vez por janela', async () => {
    __resetLeanRemindersForTests();
    let now = 7_000_000;
    const advise = vi.fn(async () => delegation(3, 1));
    const deps = { advise, now: () => now };
    const kimi = { ...operator, sessionId: 's-kimi', providerId: 'kimi' };
    const text = (out: { payload: Record<string, unknown> }) =>
      (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
    const first = text(await handleHookDelegateRequest(kimi, { prompt: [{ type: 'text', text: LONG }] }, deps));
    expect(first.startsWith(AUXILIARY_CONTEXT_HEADER)).toBe(true);
    expect(first).toContain(OPERATOR_DELEGATION_DOCTRINE);
    expect(first).toContain('~3 partes');
    // Segundo pedido: a doutrina já está no contexto — só o conselho do pedido.
    const second = text(await handleHookDelegateRequest(kimi, { prompt: LONG }, deps));
    expect(second).not.toContain(OPERATOR_DELEGATION_DOCTRINE);
    expect(second).toContain('~3 partes');
    now += 31 * 60_000;
    expect(text(await handleHookDelegateRequest(kimi, { prompt: LONG }, deps))).toContain(OPERATOR_DELEGATION_DOCTRINE);
  });

  it('additionalContextText: o texto do contexto, ou vazio quando não há nada a dizer', () => {
    expect(additionalContextText({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'oi' } })).toBe('oi');
    expect(additionalContextText({})).toBe('');
    expect(additionalContextText(null)).toBe('');
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
      // O lembrete também carrega o dever de verificar (handoff é alegação, não prova).
      expect(MAESTRO_TURN_REMINDER).toMatch(/alegação.*diff.*teste/);
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

    // Bug7 (A): a mão promovida nasceu `user` — o initialize do MCP entregou
    // a doutrina do operador e nunca a do Maestro, em nenhuma CLI. O hook
    // entrega a doutrina INTEIRA (como já fazia só para Codex/Kimi), não o
    // lembrete que pressupõe o canal MCP.
    it('Bug7: a mão promovida recebe a doutrina inteira (não o lembrete) junto com o conselho do Jev', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(
        { ...maestro, providerId: 'claude', promotedFromUserSession: true as const },
        { prompt: LONG },
        { advise: async () => delegation(3, 1), maestroDoctrine: () => 'DOUTRINA DO MAESTRO', suggestSkill: vi.fn(async () => null) },
      );
      expect(text(out)).toContain('DOUTRINA DO MAESTRO');
      expect(text(out)).not.toContain(MAESTRO_TURN_REMINDER);
      expect(text(out)).toContain('~3 partes');
    });

    it('Bug7: promovido no Codex não recebe de novo a doutrina do operador ("faça você mesmo")', async () => {
      __resetLeanRemindersForTests();
      const out = await handleHookDelegateRequest(
        { ...maestro, providerId: 'codex', promotedFromUserSession: true as const },
        { prompt: LONG },
        { advise: vi.fn(async () => null), maestroDoctrine: () => 'DOUTRINA DO MAESTRO', suggestSkill: vi.fn(async () => null) },
      );
      expect(text(out)).toContain('DOUTRINA DO MAESTRO');
      expect(text(out)).not.toContain(OPERATOR_DELEGATION_DOCTRINE);
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
      // F-784: o empurrão de continuidade que o Nexus digita (28/09 foi ao Jev).
      'Continue the current mission from exactly where you stopped as the orchestrator. ' +
        'Preserve existing context and execute the next pending step now.',
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
      // F-784: helper faz a parte dele — nem dica de delegar (cascata).
      expect(helper.payload).toEqual({});
      expect(deps.advise).not.toHaveBeenCalled();
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

  it('F-1317: writers incerto não declara "0 de escrita" como fato', () => {
    const text = formatDelegationContext(
      { parts: 5, writers: 0, confidence: 0.79, model: 'j', partsAtLeast: true, writersUncertain: true },
    );
    expect(text).not.toContain('0 de escrita');
    expect(text).toContain('isolatedWriter: true');
  });

  it('F-1317: "5+" vira "pelo menos 5 partes", não "~5"', () => {
    const text = formatDelegationContext(
      { parts: 5, writers: 2, confidence: 0.9, model: 'j', partsAtLeast: true },
    );
    expect(text).toContain('pelo menos 5 partes');
    expect(text).not.toContain('~5 partes');
  });

  it('formatDelegationContext conta leitura e escrita, e as escritas também vão em paralelo (F-784)', () => {
    const text = formatDelegationContext({ parts: 4, writers: 1, confidence: 0.9, model: 'j' });
    expect(text).toContain('(3 de leitura, 1 de escrita)');
    expect(text).toContain('4 em paralelo agora');
    expect(text).toContain('isolatedWriter: true nas de escrita');
    // Antes: "1 de escrita, uma por vez" — o pane enfileirava os writers.
    expect(text).not.toContain('uma por vez');
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

  it('the production default uses the physical human receipt and revokes it after a system write', async () => {
    const sessionId = 'physical-preference-proof';
    const prompt = 'Sempre use pnpm neste projeto.';
    const distillPreference = noDistill();
    try {
      recordSessionInputReceipt(sessionId, `${prompt}\r`, 'human');
      await handleHookDelegateRequest({ role: 'user', sessionId, scope }, { prompt },
        { advise: vi.fn(async () => null), distillPreference });
      expect(distillPreference).toHaveBeenCalledTimes(1);
      recordSessionInputReceipt(sessionId, `${prompt}\r`, 'system', 'supervisor');
      await handleHookDelegateRequest({ role: 'user', sessionId, scope }, { prompt },
        { advise: vi.fn(async () => null), distillPreference });
      expect(distillPreference).toHaveBeenCalledTimes(1);
    } finally { forgetSessionInputReceipt(sessionId); }
  });

  it('chama a destilação de preferência com o scope do workspace', async () => {
    const distillPreference = noDistill();
    await handleHookDelegateRequest(
      { role: 'user', sessionId: 's1', scope },
      { prompt: 'Sempre use pnpm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference, proveOperatorPrompt: () => true },
    );
    expect(distillPreference).toHaveBeenCalledWith(scope, 'Sempre use pnpm neste projeto.');
  });

  it('role and preference regex alone cannot grant operator provenance', async () => {
    const distillPreference = noDistill();
    await handleHookDelegateRequest({ ...operator, scope }, { prompt: 'Sempre use pnpm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference });
    expect(distillPreference).not.toHaveBeenCalled();
  });

  it('passes exact session and prompt to non-consuming Main proof and refuses a mismatch', async () => {
    const distillPreference = noDistill();
    const proof = vi.fn((sessionId: string, prompt: string) => sessionId === operator.sessionId && prompt === 'Sempre use pnpm neste projeto.');
    await handleHookDelegateRequest({ ...operator, scope }, { prompt: 'Sempre use pnpm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference, proveOperatorPrompt: proof });
    expect(proof).toHaveBeenCalledWith(operator.sessionId, 'Sempre use pnpm neste projeto.');
    expect(distillPreference).toHaveBeenCalledTimes(1);
    await handleHookDelegateRequest({ ...operator, scope }, { prompt: 'Sempre use npm neste projeto.' },
      { advise: vi.fn(async () => null), distillPreference, proveOperatorPrompt: proof });
    expect(distillPreference).toHaveBeenCalledTimes(1);
  });

  it('a genuine human message in the Maestro can retain a preference when Main proves it', async () => {
    const distillPreference = noDistill();
    const prompt = 'Sempre use pnpm neste projeto.';
    await handleHookDelegateRequest({ role: 'orchestrator', missionId: 'm', sessionId: 'maestro-human', scope },
      { prompt }, { advise: vi.fn(async () => null), maestroDoctrine: () => null,
        distillPreference, proveOperatorPrompt: (sessionId, text) => sessionId === 'maestro-human' && text === prompt });
    expect(distillPreference).toHaveBeenCalledWith(scope, prompt);
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
    expect(memoryBlock).toHaveBeenCalledWith(ctx, 'hook', 'Implemente o fluxo.', expect.any(Function));
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
    // design: null e NOT_CODE isolam o teste: LONG cita "tela" (regra de
    // design) e é pedido de código (lembrete da ponytail).
    const none = {
      advise: vi.fn(async () => null),
      businessContext: vi.fn(async () => null),
      design: () => null,
    };
    expect((await handleHookDelegateRequest(codex, { prompt: NOT_CODE }, none)).payload).toEqual({});
    const boom = {
      advise: vi.fn(async () => null),
      design: () => null,
      businessContext: vi.fn(async () => {
        throw new Error('seleção explodiu');
      }),
    };
    expect(
      (await handleHookDelegateRequest({ ...codex, sessionId: 's-boom' }, { prompt: NOT_CODE }, boom))
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

describe('F-784: leque da delegação amarrado ao teto seguro da máquina', () => {
  const budget = (
    slots: number,
    overrides: Partial<ParallelHelperBudget> = {},
  ): ParallelHelperBudget => ({
    slots,
    limitedBy: 'cap',
    liveAgentPanes: 12 - slots,
    maxAgentPanes: 12,
    freeMB: null,
    ...overrides,
  });
  const advice = (parts: number, writers: number, confidence = 0.8, heavyRead?: true) => ({
    delegation: { parts, writers, confidence, model: 'j', ...(heavyRead ? { heavyRead } : {}) },
    writesCode: 0.1,
  });
  const text = (out: { payload: Record<string, unknown> }) =>
    (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
  const maestro = { role: 'orchestrator' as const, missionId: 'm', sessionId: 'maestro-784' };

  it('3 partes independentes com folga: as 3 em paralelo, escritas em worktree própria', async () => {
    __resetLeanRemindersForTests();
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'f784-a' },
      { prompt: LONG },
      { advise: vi.fn(async () => advice(3, 2, 0.65)), parallelBudget: () => budget(8) },
    );
    expect(text(out)).toContain('~3 partes (1 de leitura, 2 de escrita)');
    expect(text(out)).toContain('3 em paralelo agora;');
    expect(text(out)).toContain('isolatedWriter: true nas de escrita');
    expect(text(out)).not.toContain('uma por vez');
    expect(text(out).length).toBeLessThanOrEqual(400);
  });

  it('5 partes e 2 vagas: abre 2 agora, diz o teto e deixa o resto para depois', async () => {
    __resetLeanRemindersForTests();
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'f784-b' },
      { prompt: LONG },
      { advise: vi.fn(async () => advice(5, 2, 0.65)), parallelBudget: () => budget(2) },
    );
    expect(text(out)).toContain(
      '2 em paralelo agora (teto seguro: 10 de 12 panes de agente vivos), o resto quando esses entregarem',
    );
    expect(text(out).length).toBeLessThanOrEqual(400);
    const lowMemory = formatDelegationContext(
      { parts: 4, writers: 1, confidence: 0.9, model: 'j' },
      budget(1, { limitedBy: 'memory', freeMB: 4_700 }),
    );
    expect(lowMemory).toContain('1 em paralelo agora (teto seguro: 4,6 GB de memória livre)');
    // Plano de teste (6 agentes): o corte é da licença, não dos panes da máquina.
    const trial = formatDelegationContext(
      { parts: 6, writers: 3, confidence: 0.9, model: 'j' },
      budget(4, { limitedBy: 'license' }),
    );
    expect(trial).toContain(
      '4 em paralelo agora (teto seguro: limite de agentes do plano menos 2 vagas para Maestro e revisor)',
    );
    expect(trial).not.toContain('panes de agente vivos');
    expect(trial).toContain('Encerre o turno');
    expect(trial.length).toBeLessThanOrEqual(400);
  });

  it('máquina no teto (03/10: 15 CLIs vivas): não abre helper nem promove o pane', async () => {
    __resetLeanRemindersForTests();
    const adoptMission = vi.fn();
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'f784-c' },
      { prompt: LONG },
      {
        advise: vi.fn(async () => advice(5, 2, 0.84)),
        autopilot: () => true,
        adoptMission,
        parallelBudget: () => budget(0, { liveAgentPanes: 15 }),
      },
    );
    expect(text(out)).toContain('mas a máquina está no teto seguro agora (15 de 12 panes de agente vivos)');
    expect(text(out)).toContain('não abra helpers');
    expect(text(out)).not.toContain('Delegue com nexus_pane_spawn');
    expect(adoptMission).not.toHaveBeenCalled();
  });

  it('com vaga, a adoção do Autopilot também abre só o que cabe', async () => {
    __resetLeanRemindersForTests();
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'f784-d' },
      { prompt: LONG },
      {
        advise: vi.fn(async () => advice(4, 2, 0.84)),
        autopilot: () => true,
        adoptMission: () => ({ missionId: 'm-784', discardIfUnused: vi.fn() }),
        parallelBudget: () => budget(3),
      },
    );
    expect(text(out)).toContain('O Nexus tornou este pane orquestrador');
    expect(text(out)).toContain('3 em paralelo agora (teto seguro: 9 de 12 panes de agente vivos)');
  });

  it('Maestro: a diretiva abre o que cabe, e o lembrete avisa quando a máquina está no teto', async () => {
    __resetLeanRemindersForTests();
    const directive = await handleHookDelegateRequest(
      maestro,
      { prompt: LONG },
      {
        advise: vi.fn(async () => advice(5, 2)),
        maestroDoctrine: () => 'DOUTRINA',
        parallelBudget: () => budget(2),
      },
    );
    expect(text(directive)).toContain('~5 partes (3 de leitura, 2 de escrita)');
    expect(text(directive)).toContain('2 em paralelo agora (teto seguro: 10 de 12 panes de agente vivos)');
    expect(text(directive)).toContain('Não faça as partes você mesmo');

    const delivery = '[nexus handoff delivery_metadata] from=pane-w1 handoff_id=h-9 summary: pronto';
    const reminder = await handleHookDelegateRequest(
      { ...maestro, sessionId: 'maestro-784-b' },
      { prompt: delivery },
      {
        advise: vi.fn(async () => null),
        maestroDoctrine: () => 'DOUTRINA',
        parallelBudget: () => budget(0, { liveAgentPanes: 15 }),
      },
    );
    expect(text(reminder)).toContain(MAESTRO_TURN_REMINDER);
    expect(text(reminder)).toContain(
      'Teto seguro desta máquina atingido agora (15 de 12 panes de agente vivos)',
    );
  });

  it('Maestro: o empurrão de continuidade do Nexus não vai ao Jev', async () => {
    __resetLeanRemindersForTests();
    const advise = vi.fn(async () => advice(5, 2));
    const out = await handleHookDelegateRequest(
      { ...maestro, sessionId: 'maestro-784-c' },
      {
        prompt:
          'Continue the current mission from exactly where you stopped as the orchestrator. ' +
          'Preserve existing context and execute the next pending step now.',
      },
      { advise, maestroDoctrine: () => 'DOUTRINA', parallelBudget: () => budget(8) },
    );
    expect(advise).not.toHaveBeenCalled();
    expect(text(out)).toBe(MAESTRO_TURN_REMINDER);
  });

  it('leitura pesada: um helper readOnly no pane do operador e no Maestro, sem adoção', async () => {
    __resetLeanRemindersForTests();
    const adoptMission = vi.fn();
    const hand = await handleHookDelegateRequest(
      { ...operator, sessionId: 'f784-e' },
      { prompt: LONG },
      {
        advise: vi.fn(async () => advice(1, 0, 0.86, true)),
        autopilot: () => true,
        adoptMission,
        parallelBudget: () => budget(8),
      },
    );
    expect(text(hand)).toContain('Leitura pesada');
    expect(text(hand)).toContain('nexus_pane_spawn({ task, prompt, readOnly: true })');
    expect(adoptMission).not.toHaveBeenCalled();

    const conductor = await handleHookDelegateRequest(
      { ...maestro, sessionId: 'maestro-784-d' },
      { prompt: LONG },
      {
        advise: vi.fn(async () => advice(1, 0, 0.86, true)),
        maestroDoctrine: () => 'DOUTRINA',
        parallelBudget: () => budget(8),
      },
    );
    expect(text(conductor)).toContain('leitura pesada');
    expect(text(conductor)).toContain('readOnly: true');
    expect(text(conductor)).not.toContain(MAESTRO_TURN_REMINDER);
  });

  it('sem orçamento injetado, o hook lê o teto vivo da máquina', async () => {
    __resetLeanRemindersForTests();
    vi.mocked(currentParallelHelperBudget).mockReturnValueOnce(budget(0, { liveAgentPanes: 12 }));
    const out = await handleHookDelegateRequest(
      { ...operator, sessionId: 'f784-live' },
      { prompt: LONG },
      { advise: vi.fn(async () => advice(3, 1)) },
    );
    expect(text(out)).toContain('não abra helpers');
    expect(currentParallelHelperBudget).toHaveBeenCalled();
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_DELEGATION_DOCTRINE } from './operator-delegation-doctrine';
import {
  AUXILIARY_CONTEXT_HEADER,
  __resetLeanRemindersForTests,
  formatDelegationContext,
  handleHookDelegateHttp,
  handleHookDelegateRequest,
  parseUserPrompt,
} from './hook-delegate-endpoint';

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
      ).toContain('nexus_browser_*');

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

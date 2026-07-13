import { describe, expect, it, vi } from 'vitest';
import {
  buildJarvisPersonaInstruction,
  emptyReplyReason,
  jarvisThink,
  parseReply,
  recoverSpokenText,
  repairMissingAction,
  type BrainDeps,
} from './jarvis-brain';
import type { JarvisContext } from '../../shared/voice-ipc';

const CTX: JarvisContext = {
  workspace: 'nexus-ide',
  recents: [],
  squads: ['Code Review'],
  panes: ['Terminal [shell]'],
  focusedPane: 'Terminal [shell]',
  orchestrator: null,
  missions: [],
};

describe('emptyReplyReason', () => {
  const base = {
    say: '',
    transcriptIsNoise: false,
    budgetFired: false,
    providerFailures: 0,
  };
  it('returns null when the reply actually has speech', () => {
    expect(emptyReplyReason({ ...base, say: 'Feito, patrão.' })).toBe(null);
  });
  it('classifies intentional silence on a noise transcript', () => {
    expect(emptyReplyReason({ ...base, transcriptIsNoise: true })).toBe('noise-transcript');
  });
  it('classifies a provider-chain deadline (fallback won the race)', () => {
    expect(emptyReplyReason({ ...base, budgetFired: true })).toBe('provider-chain-deadline');
  });
  it('classifies all-providers-failed', () => {
    expect(emptyReplyReason({ ...base, providerFailures: 2 })).toBe('all-providers-failed');
  });
  it('classifies a provider that returned an empty say', () => {
    expect(emptyReplyReason(base)).toBe('provider-returned-empty');
  });
});

describe('parseReply — DEFECT 3: a brace must never reach TTS', () => {
  const hasBrace = (s: string): boolean => /[{}[\]]/.test(s);

  it('parses the strict {say,action} shape', () => {
    const r = parseReply('{"say":"Olá, patrão.","action":{"type":"none"}}');
    expect(r.say).toBe('Olá, patrão.');
    expect(r.action.type).toBe('none');
  });

  it('recovers spoken text from a structured message envelope (no brace leak)', () => {
    const raw = '{"type":"message","content":[{"type":"text","text":"Bom dia, patrão."}]}';
    const r = parseReply(raw);
    expect(r.say).toBe('Bom dia, patrão.');
    expect(hasBrace(r.say)).toBe(false);
  });

  it('recovers from an OpenAI-compat choices envelope', () => {
    const raw = '{"choices":[{"message":{"content":"Certo, patrão."}}]}';
    expect(parseReply(raw).say).toBe('Certo, patrão.');
  });

  it('never speaks a raw brace from truncated/unparseable JSON', () => {
    const raw = '{\n  "type": "message",\n  "content": [ { "type": "text", "tex';
    const r = parseReply(raw);
    expect(hasBrace(r.say)).toBe(false);
  });

  it('never speaks a brace for a pure-JSON reply with no natural text', () => {
    const say = parseReply('{"foo":123,"bar":true}').say;
    expect(hasBrace(say)).toBe(false);
  });

  it('passes plain non-JSON prose straight through', () => {
    expect(parseReply('Certo, patrão.').say).toBe('Certo, patrão.');
  });

  it('parses an agentic mission action with an optional objective', () => {
    expect(
      parseReply(
        '{"say":"Abrindo o modo agêntico.","action":{"type":"new_agentic_mission","intent":"corrigir os testes"}}',
      ).action,
    ).toEqual({ type: 'new_agentic_mission', intent: 'corrigir os testes' });
    expect(
      parseReply(
        '{"say":"Abrindo o modo agêntico.","action":{"type":"new_agentic_mission"}}',
      ).action,
    ).toEqual({ type: 'new_agentic_mission' });
  });

  it('parses saved-squad selection without turning it into squad creation', () => {
    expect(
      parseReply(
        '{"say":"Abrindo seus squads salvos.","action":{"type":"open_squad_picker"}}',
      ).action,
    ).toEqual({ type: 'open_squad_picker' });
  });

  it('parses a current-view read action from brain JSON', () => {
    expect(
      parseReply(
        '{"say":"Vou ler a tela.","action":{"type":"read_current_view"}}',
      ).action,
    ).toEqual({ type: 'read_current_view' });
  });

  it('recoverSpokenText silences a bare truncated brace', () => {
    expect(recoverSpokenText('{')).toBe('');
    expect(recoverSpokenText('{ "type": "message",')).toBe('');
  });
});

function jsonResponse(status: number, content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status },
  );
}

function deps(
  getKey: BrainDeps['getKey'],
  fetchImpl: typeof fetch,
): BrainDeps {
  return { getKey, fetchImpl };
}

describe('jarvisThink brain providers', () => {
  it('reads and writes only the memory explicitly injected for this project', async () => {
    const memory = {
      remember: vi.fn(),
      forget: vi.fn(() => false),
      list: vi.fn(() => []),
      factsBlock: vi.fn(() => '- deploy: use project A'),
    };
    const fetchImpl = vi.fn(async (_url, init) => {
      const messages = JSON.parse(String(init?.body)).messages as Array<{
        content: string;
      }>;
      expect(messages.some((item) => item.content.includes('use project A'))).toBe(
        true,
      );
      expect(
        messages.some((item) =>
          item.content.includes('current checkout only'),
        ),
      ).toBe(true);
      return jsonResponse(
        200,
        '{"say":"Anotado.","action":{"type":"none"},"remember":{"key":"stack","fact":"TypeScript"}}',
      );
    }) as unknown as typeof fetch;

    await jarvisThink('lembre disso', CTX, [], {
      ...deps(() => 'key', fetchImpl),
      memory,
    });
    expect(memory.remember).toHaveBeenCalledWith('stack', 'TypeScript');
  });

  it('builds a hard persona instruction with the configured user name', () => {
    const prompt = buildJarvisPersonaInstruction({
      assistantName: 'Jarvis',
      userName: 'patrão',
      customInstructions: 'seja cordial e breve',
    });

    expect(prompt).toContain('VOICE IDENTITY');
    expect(prompt).toContain('the user is named "patrão"');
    expect(prompt).toContain('say exactly "patrão"');
    expect(prompt).toContain('seja cordial e breve');
  });

  it('uses Gemini first when GEMINI_API_KEY is available', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        200,
        '{"say":"Estou no Gemini.","expectReply":false,"action":{"type":"none"}}',
      ),
    ) as unknown as typeof fetch;

    const reply = await jarvisThink(
      'vamos revisar o projeto',
      CTX,
      [],
      deps((envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined), fetchImpl),
    );

    expect(reply.say).toBe('Estou no Gemini.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('generativelanguage.googleapis.com');
    expect(JSON.parse(String(init.body)).model).toBe('gemini-3.5-flash');
    expect(JSON.parse(String(init.body)).response_format).toBeUndefined();
    const messages = JSON.parse(String(init.body)).messages as Array<{ content: string }>;
    expect(messages.some((m) => m.content.includes('VOICE IDENTITY'))).toBe(true);
    expect(messages.some((m) => m.content.includes('never pass raw Portuguese'))).toBe(true);
  });

  it('falls back to OpenAI when Gemini fails', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('generativelanguage')) {
        return new Response('rate limit', { status: 429 });
      }
      return jsonResponse(
        200,
        '{"say":"Caí para OpenAI.","expectReply":false,"action":{"type":"none"}}',
      );
    }) as unknown as typeof fetch;

    const reply = await jarvisThink(
      'analisa o estado do squad',
      CTX,
      [],
      deps(
        (envVar) =>
          envVar === 'GEMINI_API_KEY' || envVar === 'OPENAI_API_KEY'
            ? 'key'
            : undefined,
        fetchImpl,
      ),
    );

    expect(reply.say).toBe('Caí para OpenAI.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(JSON.parse(String(secondInit.body)).response_format).toEqual({
      type: 'json_object',
    });
  });

  it('does not call a provider when no model keys are available', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const reply = await jarvisThink(
      'preciso conversar',
      CTX,
      [],
      deps(() => undefined, fetchImpl),
    );

    expect(reply.say).toContain('continuo operando localmente');
    expect(reply.say).not.toContain('GEMINI_API_KEY');
    expect(reply.expectReply).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps continuity when spoken text asks a question despite contradictory model metadata', () => {
    const reply = parseReply(
      '{"say":"Como deseja prosseguir? Posso iniciar ou detalhar o plano.","expectReply":false,"action":{"type":"none"}}',
    );

    expect(reply.expectReply).toBe(true);
  });

  it('keeps likely noise silent when the local brain fallback is active', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const reply = await jarvisThink('ai ai', CTX, [], deps(() => undefined, fetchImpl));

    expect(reply).toEqual({
      say: '',
      expectReply: false,
      action: { type: 'none' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not silence a deliberate short greeting in local fallback', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const reply = await jarvisThink('oi', CTX, [], deps(() => undefined, fetchImpl));
    const casualReply = await jarvisThink(
      'e aí',
      CTX,
      [],
      deps(() => undefined, fetchImpl),
    );

    expect(reply.say).toContain('continuo operando localmente');
    expect(casualReply.say).toContain('continuo operando localmente');
    expect(reply.expectReply).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to an operational local reply when all providers fail', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('rate limit', { status: 429 }),
    ) as unknown as typeof fetch;

    const reply = await jarvisThink(
      'o que você acha desse projeto?',
      CTX,
      [],
      deps((envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined), fetchImpl),
    );

    expect(reply.say).toContain('tive uma falha rápida');
    expect(reply.say).toContain('continuo operando');
    expect(reply.say).not.toContain('429');
    expect(reply.expectReply).toBe(true);
    expect(reply.action).toEqual({ type: 'none' });
  });

  it('parseia as ações close_pane e open_board do JSON do cérebro', async () => {
    const replies = [
      '{"say":"Fechando.","expectReply":false,"action":{"type":"close_pane"}}',
      '{"say":"Abrindo o quadro.","expectReply":false,"action":{"type":"open_board"}}',
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, replies[call++]),
    ) as unknown as typeof fetch;
    const d = deps(
      (envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined),
      fetchImpl,
    );

    const closeReply = await jarvisThink('fecha esse terminal', CTX, [], d);
    expect(closeReply.action).toEqual({ type: 'close_pane' });

    const boardReply = await jarvisThink('mostra o quadro de missões', CTX, [], d);
    expect(boardReply.action).toEqual({ type: 'open_board' });
  });

  it('parseia ações nativas de UI do JSON do cérebro', async () => {
    const replies = [
      '{"say":"Abrindo o canvas.","expectReply":false,"action":{"type":"open_canvas"}}',
      '{"say":"Abrindo voz.","expectReply":false,"action":{"type":"open_voice_settings"}}',
      '{"say":"Abrindo site.","expectReply":false,"action":{"type":"open_browser","url":"https://example.com"}}',
      '{"say":"Recarregando.","expectReply":false,"action":{"type":"browser_reload"}}',
      '{"say":"Próximo pane.","expectReply":false,"action":{"type":"focus_next_pane"}}',
      '{"say":"Pane anterior.","expectReply":false,"action":{"type":"focus_previous_pane"}}',
      '{"say":"Focando terminal.","expectReply":false,"action":{"type":"focus_pane","paneName":"terminal"}}',
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, replies[call++]),
    ) as unknown as typeof fetch;
    const d = deps(
      (envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined),
      fetchImpl,
    );

    const canvasReply = await jarvisThink('preciso reorganizar a tela livre', CTX, [], d);
    const voiceReply = await jarvisThink('preciso ajustar a voz da assistente', CTX, [], d);
    const browserReply = await jarvisThink('abre example.com', CTX, [], d);
    const reloadReply = await jarvisThink('recarrega a página', CTX, [], d);
    const focusReply = await jarvisThink('próximo pane', CTX, [], d);
    const previousReply = await jarvisThink('pane anterior', CTX, [], d);
    const focusTerminalReply = await jarvisThink('foca terminal', CTX, [], d);

    expect(canvasReply.action).toEqual({ type: 'open_canvas' });
    expect(voiceReply.action).toEqual({ type: 'open_voice_settings' });
    expect(browserReply.action).toEqual({
      type: 'open_browser',
      url: 'https://example.com',
    });
    expect(reloadReply.action).toEqual({ type: 'browser_reload' });
    expect(focusReply.action).toEqual({ type: 'focus_next_pane' });
    expect(previousReply.action).toEqual({ type: 'focus_previous_pane' });
    expect(focusTerminalReply.action).toEqual({ type: 'focus_pane', paneName: 'terminal' });
  });

  it('keeps an intentional empty say silent instead of turning it into filler', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        200,
        '{"say":"","expectReply":false,"action":{"type":"none"}}',
      ),
    ) as unknown as typeof fetch;

    const reply = await jarvisThink(
      'obrigado por assistir',
      CTX,
      [],
      deps((envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined), fetchImpl),
    );

    expect(reply.say).toBe('');
    expect(reply.expectReply).toBe(false);
  });

  it('parses mcp_tool actions from brain JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        200,
        '{"say":"Lendo o package.json.","expectReply":false,"action":{"type":"mcp_tool","tool":"nexus_file_read","args":{"path":"package.json"}}}',
      ),
    ) as unknown as typeof fetch;

    const reply = await jarvisThink(
      'le o package json',
      CTX,
      [],
      deps((envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined), fetchImpl),
    );

    expect(reply.action).toEqual({
      type: 'mcp_tool',
      tool: 'nexus_file_read',
      args: { path: 'package.json' },
    });
  });

  it('corrige LLM que diz terminal aberto sem action', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        200,
        '{"say":"Terminal aberto, patrão.","expectReply":false,"action":{"type":"none"}}',
      ),
    ) as unknown as typeof fetch;

    const reply = await jarvisThink(
      'preciso do console agora',
      CTX,
      [],
      deps((envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined), fetchImpl),
    );

    expect(reply.action).toEqual({ type: 'open_terminal' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('repairMissingAction', () => {
  it('injeta open_terminal quando a fala confirma abertura sem action', () => {
    const fixed = repairMissingAction(
      'ok',
      { say: 'Pronto, terminal aberto.', expectReply: false, action: { type: 'none' } },
      CTX,
    );
    expect(fixed.action).toEqual({ type: 'open_terminal' });
  });
});

describe('jarvisThink chain deadline (Gap 8)', () => {
  it('devolve o fallback gracioso antes do deadline quando os providers penduram', async () => {
    // fetch que nunca resolve (rejeita só no abort) — simula provider pendurado.
    const hangingFetch = vi.fn(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const started = Date.now();
    const reply = await jarvisThink(
      'me conta uma novidade sobre o projeto',
      CTX,
      [],
      deps((envVar) => (envVar === 'GEMINI_API_KEY' ? 'gemini-key' : undefined), hangingFetch),
      40, // chainDeadlineMs curto: o fallback deve vencer a corrida
    );

    // Resolveu pelo budget bem antes do BRAIN_TIMEOUT_MS (15s) do provider.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(reply.action).toEqual({ type: 'none' });
    expect(reply.expectReply).toBe(true);
    expect(reply.say.toLowerCase()).toContain('operando');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from '../../shared/voice-config';
import type { TranscribeRequest } from '../../shared/voice-ipc';
import type { ProviderProbes } from './provider-select';
import { transcribe, describeHttpFailure, resolveEndpoint, type SttDeps } from './stt-service';

const REQ: TranscribeRequest = {
  audioBase64: Buffer.from('fake-wav').toString('base64'),
  mime: 'audio/wav',
  sampleRate: 16_000,
};

const PROBES: ProviderProbes = { hasEnv: () => true, hasBin: () => true, platform: 'darwin' };

/** Build a config with the Groq → OpenAI → local-whisper chain. */
function config(): VoiceConfig {
  return DEFAULT_VOICE_CONFIG;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Base deps with everything stubbed; override per test.
 *
 * `GEMINI_API_KEY` fica SEM chave por padrão. O head da cadeia de STT hoje é o
 * Gemini, e os testes deste arquivo exercitam o fallback Whisper (Groq →
 * OpenAI → local-whisper). Com chave para tudo, o Gemini assumiria a cabeça e
 * todo teste da cadeia Whisper passaria a bater no Google primeiro. Os testes
 * do Gemini ligam a chave explicitamente via `getEnv` próprio.
 */
function deps(over: Partial<SttDeps>): SttDeps {
  return {
    fetchImpl: vi.fn(async () => jsonResponse(500, {})) as unknown as typeof fetch,
    runLocal: vi.fn(),
    readText: vi.fn(() => ''),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    fileExists: vi.fn(() => false),
    findBin: vi.fn(() => null),
    getEnv: vi.fn((name: string) => (name === 'GEMINI_API_KEY' ? undefined : 'test-key')),
    ...over,
  };
}

describe('describeHttpFailure', () => {
  it('classifies rate-limit / quota / auth / server errors', () => {
    expect(describeHttpFailure(429).reason).toContain('429');
    expect(describeHttpFailure(402).reason).toContain('402');
    expect(describeHttpFailure(403).reason).toContain('403');
    expect(describeHttpFailure(401).needsKey).toBe(true);
    expect(describeHttpFailure(503).reason).toContain('503');
  });
});

describe('resolveEndpoint', () => {
  it('swaps to /audio/translations when translating', () => {
    expect(
      resolveEndpoint(
        { type: 'stt', provider: 'groq', endpoint: 'https://x/openai/v1/audio/transcriptions' },
        true,
      ),
    ).toBe('https://x/openai/v1/audio/translations');
  });

  it('keeps /audio/transcriptions when not translating', () => {
    expect(
      resolveEndpoint(
        { type: 'stt', provider: 'groq', endpoint: 'https://x/openai/v1/audio/transcriptions' },
        false,
      ),
    ).toBe('https://x/openai/v1/audio/transcriptions');
  });
});

describe('transcribe — quota/rate-limit fallback (free-tier Groq)', () => {
  it('falls through from a 429 Groq to a working OpenAI', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('groq.com')) return jsonResponse(429, { error: 'rate limit' });
      return jsonResponse(200, { text: 'hello from openai' });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('openai');
      expect(result.text).toBe('hello from openai');
      expect(result.fallbackNote).toContain('groq');
      expect(result.fallbackNote).toContain('429');
    }
  });

  it('skips a keyless Groq and uses OpenAI without a network call to Groq', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'via openai' })) as unknown as typeof fetch;
    const getEnv = vi.fn((n: string) => (n === 'OPENAI_API_KEY' ? 'key' : undefined));

    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl, getEnv }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('openai');
    // Only OpenAI was called; Groq was skipped for the missing key.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('falls all the way to keyless local whisper.cpp when both clouds fail', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('groq.com')) return jsonResponse(429, {});
      return jsonResponse(402, {}); // openai quota exhausted
    }) as unknown as typeof fetch;

    const result = await transcribe(
      REQ,
      config(),
      PROBES,
      deps({
        fetchImpl,
        findBin: vi.fn(() => 'whisper-cli'),
        fileExists: vi.fn(() => true),
        readText: vi.fn(() => '  transcribed locally  '),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('local-whisper');
      expect(result.text).toBe('transcribed locally');
    }
  });

  // A quick provider failure must not silence machines without local whisper.
  // The total budget still bounds a genuinely hung provider.
  it('wake budget: after one fast cloud failure, tries the 2nd cloud inside the remaining budget', async () => {
    const calledHosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calledHosts.push(String(url));
      if (String(url).includes('groq.com')) return jsonResponse(429, {});
      return jsonResponse(200, { text: 'openai recovered the wake' });
    }) as unknown as typeof fetch;

    const result = await transcribe(
      { ...REQ, budgetMs: 8_000 },
      config(),
      PROBES,
      deps({
        fetchImpl,
        findBin: vi.fn(() => null),
        fileExists: vi.fn(() => false),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('openai');
      expect(result.text).toBe('openai recovered the wake');
    }
    expect(calledHosts.filter((h) => h.includes('groq.com'))).toHaveLength(1);
    expect(calledHosts.filter((h) => h.includes('openai.com'))).toHaveLength(1);
  });

  it('wake budget: skips ALL cloud when the budget is already spent (injected clock)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'should-not-run' })) as unknown as typeof fetch;
    // Clock jumps 9s after the first read → budget (8s) is spent before any cloud call.
    let t = 0;
    const now = () => {
      const v = t;
      t += 9_000;
      return v;
    };

    const result = await transcribe(
      { ...REQ, budgetMs: 8_000 },
      config(),
      PROBES,
      deps({
        fetchImpl,
        now,
        findBin: vi.fn(() => 'whisper-cli'),
        fileExists: vi.fn(() => true),
        readText: vi.fn(() => '  local only  '),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('local-whisper');
      expect(result.stalled).toBe(true);
    }
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('probes Homebrew whisper-cli paths for GUI-launched macOS apps', async () => {
    let candidates: string[] = [];
    const findBin = vi.fn((items: string[]) => {
      candidates = items;
      return items.includes('/opt/homebrew/bin/whisper-cli')
        ? '/opt/homebrew/bin/whisper-cli'
        : null;
    });

    const result = await transcribe(
      REQ,
      config(),
      PROBES,
      deps({
        findBin,
        fileExists: vi.fn(() => true),
        getEnv: vi.fn(() => undefined),
        readText: vi.fn(() => '  local without shell path  '),
      }),
    );

    expect(candidates).toContain('/opt/homebrew/bin/whisper-cli');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('local-whisper');
      expect(result.text).toBe('local without shell path');
    }
  });

  it('honors the turn request language when local whisper is the fallback', async () => {
    const runLocal = vi.fn();

    const result = await transcribe(
      { ...REQ, translate: false, language: 'pt' },
      config(),
      PROBES,
      deps({
        findBin: vi.fn(() => '/opt/homebrew/bin/whisper-cli'),
        fileExists: vi.fn(() => true),
        getEnv: vi.fn(() => undefined),
        readText: vi.fn(() => '  abrir terminal  '),
        runLocal,
      }),
    );

    expect(result.ok).toBe(true);
    const args = runLocal.mock.calls[0]?.[1] ?? [];
    expect(args).toContain('-l');
    expect(args[args.indexOf('-l') + 1]).toBe('pt');
    expect(args).not.toContain('-tr');
  });

  it('reports a clear, actionable error when everything fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {})) as unknown as typeof fetch;
    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('whisper.cpp');
      expect(result.error).toMatch(/GROQ_API_KEY|OPENAI_API_KEY/);
      // O Gemini lidera a cadeia: sem chave ele entra na lista como tentativa
      // frustrada (mesmo tratamento dos outros), então aparece primeiro.
      expect(result.attempts.map((a) => a.provider)).toEqual([
        'gemini',
        'groq',
        'openai',
        'local-whisper',
      ]);
    }
  });

  it('does not call the network for a provider whose key is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'x' })) as unknown as typeof fetch;
    const getEnv = vi.fn(() => undefined); // no keys anywhere
    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl, getEnv }));
    // Both clouds skipped (no key), local unavailable → failure, zero fetches.
    expect(result.ok).toBe(false);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    if (!result.ok) expect(result.needsKey).toBe(true);
  });
});

describe('transcribe — priming de ditado (modo code)', () => {
  it('anexa req.prompt ao form — vocabulário técnico bias na tradução', async () => {
    let prompt: FormDataEntryValue | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      prompt = (init?.body as FormData).get('prompt');
      return jsonResponse(200, { text: 'commit and push to the worktree' });
    }) as unknown as typeof fetch;

    const result = await transcribe(
      { ...REQ, translate: true, prompt: 'Software engineering dictation. commit, worktree.' },
      config(),
      PROBES,
      deps({ fetchImpl }),
    );

    expect(result.ok).toBe(true);
    expect(prompt).toBe('Software engineering dictation. commit, worktree.');
  });

  it('sem req.prompt o form não ganha prompt (transcrição normal intocada)', async () => {
    let hasPrompt = true;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      hasPrompt = (init?.body as FormData).has('prompt');
      return jsonResponse(200, { text: 'oi' });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl }));

    expect(result.ok).toBe(true);
    expect(hasPrompt).toBe(false);
  });
});

describe('transcribe — passive wake', () => {
  it('biases the short transcription toward the configured Jarvis wake word', async () => {
    let prompt: FormDataEntryValue | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      prompt = (init?.body as FormData).get('prompt');
      return jsonResponse(200, { text: 'jarvis' });
    }) as unknown as typeof fetch;

    const result = await transcribe(
      { ...REQ, purpose: 'passive-wake', budgetMs: 3_500 },
      config(),
      PROBES,
      deps({ fetchImpl }),
    );

    expect(result.ok).toBe(true);
    expect(prompt).toBeTypeOf('string');
    expect(prompt).toContain('Jarvis');
  });

  it('promotes Groq for a short textual wake instead of waiting on an OpenAI head', async () => {
    const openaiHead: VoiceConfig = {
      ...config(),
      stt: {
        type: 'stt',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
        fallback: config().stt,
      },
    };
    const calledHosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const host = String(url);
      calledHosts.push(host);
      return jsonResponse(200, { text: 'ei jarvis' });
    }) as unknown as typeof fetch;
    const runLocal = vi.fn();

    const result = await transcribe(
      { ...REQ, purpose: 'passive-wake', budgetMs: 3_500 },
      openaiHead,
      PROBES,
      deps({ fetchImpl, runLocal }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('groq');
    expect(calledHosts).toHaveLength(1);
    expect(calledHosts[0]).toContain('groq.com');
    expect(runLocal).not.toHaveBeenCalled();
  });

  it('never lets a local Whisper fallback delay a passive wake', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {})) as unknown as typeof fetch;
    const runLocal = vi.fn();

    const result = await transcribe(
      { ...REQ, purpose: 'passive-wake', budgetMs: 3_500 },
      config(),
      PROBES,
      deps({
        fetchImpl,
        runLocal,
        findBin: vi.fn(() => 'whisper-cli'),
        fileExists: vi.fn(() => true),
      }),
    );

    expect(result.ok).toBe(false);
    expect(runLocal).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.attempts.map((attempt) => attempt.provider)).toContain('local-whisper');
      expect(result.attempts.map((attempt) => attempt.reason).join(' ')).toContain('passive wake');
    }
  });
});

describe('transcribe — Gemini 3.5 Transcribe (Interactions API)', () => {
  /** deps com chave do Gemini presente — é ela que põe o Gemini na cabeça. */
  function geminiDeps(over: Partial<SttDeps> = {}): SttDeps {
    return deps({ getEnv: vi.fn(() => 'test-key'), ...over });
  }

  it('monta o request do Interactions API: áudio inline, x-goog-api-key, verbatim', async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (u: string | URL | Request, i?: RequestInit) => {
      url = String(u);
      init = i;
      return jsonResponse(200, { output_text: 'comita e sobe pro worktree' });
    }) as unknown as typeof fetch;

    // `prompt` é o sinal do modo CODE — é ele que liga o viés de vocabulário.
    const result = await transcribe(
      { ...REQ, prompt: 'code priming' },
      config(),
      PROBES,
      geminiDeps({ fetchImpl }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('gemini');
      expect(result.text).toBe('comita e sobe pro worktree');
    }
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');

    const headers = init?.headers as Record<string, string>;
    // Gemini usa x-goog-api-key — NÃO o Bearer do dialeto OpenAI/Whisper.
    expect(headers['x-goog-api-key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: Array<{ type: string; data?: string; mime_type?: string }>;
      generation_config: {
        transcription_config: {
          mode?: unknown;
          custom_vocabulary?: string[];
          language_codes?: unknown;
        };
      };
    };
    expect(body.model).toBe('gemini-3.5-transcribe');
    expect(body.input[0]?.type).toBe('audio');
    expect(body.input[0]?.data).toBe(REQ.audioBase64);
    expect(body.input[0]?.mime_type).toBe('audio/wav');

    const tc = body.generation_config.transcription_config;
    // verbatim: o modo `smart` remove muletas de fala — exatamente o sintoma
    // de "palavra que eu falei não entrou no texto".
    expect(tc.mode).toEqual({ type: 'verbatim' });
    expect(tc.custom_vocabulary).toContain('worktree');
    // Sem language_codes: omitir habilita auto-detecção/code-switching, que é
    // a força do modelo para PT com jargão técnico em inglês.
    expect(tc.language_codes).toBeUndefined();
  });

  it('NÃO enviesa vocabulário fora do modo code (CHAT não tem priming)', async () => {
    // Array em vez de variável solta: o TS estreita uma `let` atribuída dentro
    // do callback para `never` no ponto da asserção.
    const bodies: Array<{
      generation_config: { transcription_config: Record<string, unknown> };
    }> = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, i?: RequestInit) => {
      bodies.push(JSON.parse(String(i?.body)));
      return jsonResponse(200, { output_text: 'texto do chat' });
    }) as unknown as typeof fetch;

    // Sem `prompt` = CHAT. O caminho Whisper de propósito não enviesa aqui, e
    // os engines não podem discordar sobre o que o modo significa.
    await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));

    const transcription = bodies[0]?.generation_config.transcription_config;
    expect(transcription?.custom_vocabulary).toBeUndefined();
    expect(transcription?.mode).toEqual({ type: 'verbatim' });
  });

  it('interação que FALHOU não vira transcrição, mesmo com texto parcial', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        status: 'failed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'texto parcial' }] }],
      }),
    ) as unknown as typeof fetch;

    // Devolver isso como sucesso injetaria lixo no pane como se fosse fala.
    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(false);
  });

  it('lê a transcrição de steps[].content[].text quando não há output_text', async () => {
    // A página do produto documenta `output_text`; a referência da API não
    // define esse campo e mostra o texto dentro de steps. Aceitar as duas
    // formas é o que impede o preview de quebrar o ditado em silêncio.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        id: 'interactions/abc',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: 'texto vindo dos steps' }],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('texto vindo dos steps');
  });

  it('resposta sem texto nenhum conta como falha, não como transcrição vazia', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { steps: [] })) as unknown as typeof fetch;
    const result = await transcribe(
      REQ,
      config(),
      PROBES,
      geminiDeps({ fetchImpl, runLocal: vi.fn(), findBin: vi.fn(() => null) }),
    );
    expect(result.ok).toBe(false);
  });

  it('429 no Gemini cai para o Groq em vez de derrubar o turno', async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      if (String(u).includes('generativelanguage')) return jsonResponse(429, {});
      return jsonResponse(200, { text: 'veio do groq' });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('groq');
      expect(result.text).toBe('veio do groq');
    }
  });

  it('401 no Gemini marca needsKey e segue para o próximo provedor', async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      if (String(u).includes('generativelanguage')) return jsonResponse(401, {});
      return jsonResponse(200, { text: 'groq atendeu' });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('groq');
  });

  it('sem chave do Gemini a cadeia começa no Groq (escolha por presença de chave)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'groq' })) as unknown as typeof fetch;
    const result = await transcribe(REQ, config(), PROBES, deps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('groq');
  });

  // ── F-524: modo english + resiliência do preview ─────────────────────────

  it('ditado CODE (translate) usa a rota generativa e entrega inglês', async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request, i?: RequestInit) => {
      urls.push(String(u));
      bodies.push(JSON.parse(String(i?.body)));
      return jsonResponse(200, {
        candidates: [
          { content: { parts: [{ text: 'git push origin main' }] } },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await transcribe(
      { ...REQ, translate: true, language: 'pt', prompt: 'code priming' },
      config(),
      PROBES,
      geminiDeps({ fetchImpl }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('gemini');
      expect(result.text).toBe('git push origin main');
    }
    // NEM passou pelo Interactions: transcription-only não traduz.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    );
    const body = bodies[0] as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0]?.parts[0]?.inline_data).toMatchObject({
      mime_type: 'audio/wav',
      data: REQ.audioBase64,
    });
    const instruction = String(body.contents[0]?.parts[1]?.text);
    expect(instruction).toContain('TRANSLATE it to English');
    expect(instruction).toContain('code priming');
  });

  it('chave SEM acesso ao preview (404 no Interactions) transcreve via generateContent', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      calls.push(url);
      if (url.endsWith('/interactions')) {
        return jsonResponse(404, {
          error: { message: 'model gemini-3.5-transcribe not found for API version' },
        });
      }
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'texto via generateContent' }] } }],
      });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('texto via generateContent');
    expect(calls).toHaveLength(2);
  });

  it('401 (chave inválida) NÃO queima a segunda chamada — segue a cadeia', async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      if (String(u).includes('generativelanguage')) return jsonResponse(401, {});
      return jsonResponse(200, { text: 'groq assumiu' });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe('groq');
    // Interactions UMA vez; o fallback generativo não roda com credencial ruim.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('timeout no Interactions não tenta a rota generativa (rede lenta vale para as duas)', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof fetch;

    // Só o Gemini tem chave: sem Groq/OpenAI/whisper atrás, o timeout dele é
    // a única chamada de rede do turno.
    const geminiOnly = {
      ...deps({ fetchImpl }),
      getEnv: vi.fn((name: string) =>
        name === 'GEMINI_API_KEY' ? 'test-key' : undefined,
      ),
    };
    const result = await transcribe(REQ, config(), PROBES, geminiOnly);
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const geminiAttempt = result.attempts.find((a) => a.provider === 'gemini');
    expect(geminiAttempt?.reason).toContain('timeout');
  });

  it('interação status=failed recupera pela rota generativa literal', async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      if (String(u).endsWith('/interactions')) {
        return jsonResponse(200, { status: 'failed' });
      }
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'recuperado literal' }] } }],
      });
    }) as unknown as typeof fetch;

    const result = await transcribe(REQ, config(), PROBES, geminiDeps({ fetchImpl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('recuperado literal');
  });
});

describe('extractGeminiGenerateContentTranscript', () => {
  it('concatena parts de múltiplos candidates', async () => {
    const { extractGeminiGenerateContentTranscript } = await import('./stt-service');
    expect(
      extractGeminiGenerateContentTranscript({
        candidates: [
          { content: { parts: [{ text: 'primeira ' }, { text: 'parte' }] } },
          { content: { parts: [{ text: ' · segunda' }] } },
        ],
      }),
    ).toBe('primeira parte · segunda');
  });

  it('promptFeedback com blockReason é falha, não transcrição', async () => {
    const { extractGeminiGenerateContentTranscript } = await import('./stt-service');
    expect(
      extractGeminiGenerateContentTranscript({
        promptFeedback: { blockReason: 'SAFETY' },
        candidates: [{ content: { parts: [{ text: 'bloqueado' }] } }],
      }),
    ).toBe('');
  });

  it('resposta sem candidates devolve vazio', async () => {
    const { extractGeminiGenerateContentTranscript } = await import('./stt-service');
    expect(extractGeminiGenerateContentTranscript({})).toBe('');
    expect(extractGeminiGenerateContentTranscript(null)).toBe('');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { jarvisThink, type BrainDeps } from './jarvis-brain';
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

    expect(reply.say).toContain('GEMINI_API_KEY');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

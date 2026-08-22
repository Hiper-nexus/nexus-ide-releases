import { describe, expect, it } from 'vitest';
import {
  answerDirectQuestion,
  extractQuestion,
  looksLikePureQuestion,
  parseRouteJson,
  routeIntent,
  routeWithDeepSeek,
} from './intent-router';

describe('Tier 0 — heurística determinística', () => {
  it('pergunta pura curta nem vira missão', () => {
    expect(looksLikePureQuestion('quanto é 1+1?')).toBe(true);
    expect(looksLikePureQuestion('qual a capital do Brasil')).toBe(true);
  });

  it('verbo de criação ou texto longo é missão', () => {
    expect(looksLikePureQuestion('crie uma landing page')).toBe(false);
    expect(looksLikePureQuestion(`${'a'.repeat(200)}?`)).toBe(false);
    expect(looksLikePureQuestion('')).toBe(false);
  });

  it('extrai a pergunta limpa do wrapper meta-de-pane', () => {
    expect(
      extractQuestion(
        'Pergunte a cada pane worker quanto é 1+1, aguarde o handoff de cada um e consolide as respostas no resultado final da missão. Responda com o número.',
      ),
    ).toBe('quanto é 1+1');
    expect(extractQuestion('crie um app')).toBeNull();
  });
});

describe('parseRouteJson — não confia em nada da LLM', () => {
  it('aceita as três rotas válidas', () => {
    expect(parseRouteJson('{"kind":"direct-answer","question":"2?"}')).toEqual({
      kind: 'direct-answer',
      question: '2?',
    });
    expect(
      parseRouteJson(
        '{"kind":"mission-question","question":"x","readOnlyWorkers":true}',
      ),
    ).toMatchObject({ kind: 'mission-question', readOnlyWorkers: true });
    expect(
      parseRouteJson('{"kind":"mission-work","skills":["oc-design-dna"]'),
    ).toBeNull();
    expect(
      parseRouteJson('{"kind":"mission-work","skills":["oc-design-dna"]}'),
    ).toEqual({ kind: 'mission-work', skills: ['oc-design-dna'] });
  });

  it('rejeita lixo, skill malformado e kind desconhecido', () => {
    expect(parseRouteJson('não sou json')).toBeNull();
    expect(parseRouteJson('{"kind":"deploy-prod"}')).toBeNull();
    expect(parseRouteJson('{"kind":"mission-work","skills":["DROP TABLE"]}')).toEqual(
      { kind: 'mission-work', skills: [] },
    );
    expect(parseRouteJson('{"kind":"direct-answer"}')).toBeNull();
  });
});

describe('routeWithDeepSeek / routeIntent — fail-open', () => {
  it('sem key devolve null sem chamar rede', async () => {
    let called = false;
    const route = await routeWithDeepSeek('x', {
      apiKey: null,
      fetchImpl: async () => {
        called = true;
        throw new Error('nunca');
      },
    });
    expect(route).toBeNull();
    expect(called).toBe(false);
  });

  it('HTTP erro ou timeout ⇒ null, nunca exceção', async () => {
    expect(
      await routeWithDeepSeek('x', {
        apiKey: 'k',
        fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(
      await routeWithDeepSeek('x', {
        apiKey: 'k',
        timeoutMs: 1,
        fetchImpl: ((_url: any, init: any) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () =>
              reject(new Error('abort')),
            ),
          )) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it('rota feliz parseia o conteúdo', async () => {
    expect(
      await routeWithDeepSeek('quanto é 2+2?', {
        apiKey: 'k',
        fetchImpl: (async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"kind":"direct-answer","question":"quanto é 2+2?"}' } }],
          }),
        })) as unknown as typeof fetch,
      }),
    ).toEqual({ kind: 'direct-answer', question: 'quanto é 2+2?' });
  });

  it('routeIntent: Tier 0 ganha antes de qualquer rede', async () => {
    expect(await routeIntent('quanto é 1+1?', { hasKeyFor: () => true })).toEqual({
      kind: 'direct-answer',
      question: 'quanto é 1+1?',
    });
  });

  it('routeIntent: sem nenhuma key e fora do Tier 0 ⇒ null (fluxo atual segue)', async () => {
    expect(
      await routeIntent('crie uma landing page', { hasKeyFor: () => false }),
    ).toBeNull();
  });

  it('routeIntent: nunca usa key do ambiente em teste — fetch injetado que falha ⇒ null', async () => {
    expect(
      await routeIntent('crie uma landing page', {
        hasKeyFor: () => true,
        loadKeyFor: () => 'test-key',
        fetchImpl: (async () => {
          throw new Error('rede proibida em teste');
        }) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it('routeIntent: Tier 1 classifica via anthropic (glm) extraindo JSON de prosa', async () => {
    const seen: string[] = [];
    const route = await routeIntent('me explique o que é um deadlock', {
      hasKeyFor: (id) => id === 'glm',
      loadKeyFor: () => 'k',
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return {
          ok: true,
          json: async () => ({
            content: [
              {
                type: 'text',
                text: 'Claro! {"kind":"direct-answer","question":"me explique o que é um deadlock"} aqui está.',
              },
            ],
          }),
        };
      }) as unknown as typeof fetch,
    });
    expect(route).toEqual({
      kind: 'direct-answer',
      question: 'me explique o que é um deadlock',
    });
    expect(seen).toEqual(['https://api.z.ai/api/anthropic/v1/messages']);
  });

  it('routeIntent: primeiro provedor fora do ar cai para o próximo da cadeia', async () => {
    let calls = 0;
    const route = await routeIntent('crie uma landing page', {
      hasKeyFor: () => true,
      loadKeyFor: () => 'k',
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return { ok: false, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({
            content: [
              { type: 'text', text: '{"kind":"mission-work","skills":[]}' },
            ],
          }),
        };
      }) as unknown as typeof fetch,
    });
    // deepseek fora (HTTP erro) → glm responde mission-work.
    expect(route).toEqual({ kind: 'mission-work', skills: [] });
    expect(calls).toBe(2);
  });
});

describe('answerDirectQuestion — responde sem missão, fail-open total', () => {
  it('sem nenhuma key configurada ⇒ null sem chamar rede', async () => {
    let called = false;
    const answer = await answerDirectQuestion('quanto é 1+1?', {
      hasKeyFor: () => false,
      fetchImpl: (async () => {
        called = true;
        throw new Error('nunca');
      }) as unknown as typeof fetch,
    });
    expect(answer).toBeNull();
    expect(called).toBe(false);
  });

  it('primeiro provedor com key que responde ganha (deepseek, estilo OpenAI)', async () => {
    const seen: string[] = [];
    const answer = await answerDirectQuestion('quanto é 1+1?', {
      hasKeyFor: (id) => id === 'deepseek',
      loadKeyFor: () => 'k',
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '2' } }],
          }),
        };
      }) as unknown as typeof fetch,
    });
    expect(answer).toBe('2');
    expect(seen).toEqual(['https://api.deepseek.com/chat/completions']);
  });

  it('cai para o próximo provedor quando o primeiro falha (glm, estilo Anthropic)', async () => {
    const seen: string[] = [];
    const answer = await answerDirectQuestion('quanto é 1+1?', {
      hasKeyFor: () => true,
      loadKeyFor: () => 'k',
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        if (seen.length === 1) return { ok: false, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: '2' }] }),
        };
      }) as unknown as typeof fetch,
    });
    expect(answer).toBe('2');
    expect(seen).toHaveLength(2);
  });

  it('resposta "unanswerable" ou vazia não é resposta — segue o fluxo normal', async () => {
    expect(
      await answerDirectQuestion('apaga minha pasta', {
        hasKeyFor: () => true,
        loadKeyFor: () => 'k',
        fetchImpl: (async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"unanswerable":true}' } }],
          }),
        })) as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(await answerDirectQuestion('   ')).toBeNull();
  });
});

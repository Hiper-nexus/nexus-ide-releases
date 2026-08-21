import { describe, expect, it } from 'vitest';
import {
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
    expect(await routeIntent('quanto é 1+1?', { hasKey: true })).toEqual({
      kind: 'direct-answer',
      question: 'quanto é 1+1?',
    });
  });

  it('routeIntent: sem key e fora do Tier 0 ⇒ null (fluxo atual segue)', async () => {
    expect(await routeIntent('crie uma landing page', { hasKey: false })).toBeNull();
  });

  it('routeIntent: nunca usa key do ambiente em teste — fetch injetado que falha ⇒ null', async () => {
    expect(
      await routeIntent('crie uma landing page', {
        hasKey: true,
        apiKey: 'test-key',
        fetchImpl: (async () => {
          throw new Error('rede proibida em teste');
        }) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });
});

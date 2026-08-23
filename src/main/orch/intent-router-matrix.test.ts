import { describe, expect, it } from 'vitest';
import {
  answerDirectQuestion,
  parseRouteJson,
  routeIntent,
} from './intent-router';

/**
 * Matriz de comportamento REAL do router com missões que o operador leigo
 * dita no dia a dia — sem rede (Tier 0 determinístico; Tier 1 exige key
 * barata configurada e é testado nos casos próprios).
 */
describe('MATRIZ: router com missões reais de operador', () => {
  const cases: Array<{
    objective: string;
    esperado: 'direct-answer' | null;
    porQue: string;
  }> = [
    // ── Perguntas puras que DEVEM virar resposta direta ──────────────────
    { objective: 'quanto é 1+1?', esperado: 'direct-answer', porQue: 'pergunta canônica' },
    { objective: 'qual a capital do Brasil?', esperado: 'direct-answer', porQue: 'qual + ?' },
    { objective: 'quem escreveu Dom Casmurro?', esperado: 'direct-answer', porQue: 'quem + ?' },
    { objective: 'quando começou a Segunda Guerra?', esperado: 'direct-answer', porQue: 'quando + ?' },
    { objective: 'quantos dias tem fevereiro?', esperado: 'direct-answer', porQue: 'quantos + ?' },

    // ── Perguntas SEM '?' e SEM começo interrogativo (o buraco do Tier 0) ─
    { objective: 'me explique o que é git', esperado: 'direct-answer', porQue: 'pedido de explicação, não de trabalho' },
    { objective: 'explique diferença entre HTTP e HTTPS', esperado: 'direct-answer', porQue: 'explicação conceitual' },
    { objective: 'como faço para trocar um pneu', esperado: 'direct-answer', porQue: 'como + verbo fraco' },
    { objective: 'o que é uma API?', esperado: 'direct-answer', porQue: 'o que é + ?' },
    { objective: 'isto vai funcionar', esperado: null, porQue: 'ambíguo — sem marcador de pergunta (ok virar missão)' },

    // ── Trabalho real: NUNCA pode ser resposta direta ────────────────────
    { objective: 'crie uma landing page para minha empresa', esperado: null, porQue: 'verbo de criação' },
    { objective: 'construa um ecommerce com carrinho', esperado: null, porQue: 'verbo de criação' },
    { objective: 'corrija o bug do login', esperado: null, porQue: 'verbo de correção' },
    { objective: 'implemente autenticação OAuth', esperado: null, porQue: 'verbo de implementação + sinal security' },
    { objective: 'quanto é 1+1? Depois crie um site sobre matemática', esperado: null, porQue: 'híbrido: tem trabalho depois da pergunta' },

    // ── Aberturas de leigo que o Tier 0 não reconhecia (sonda 23/08: 8 de
    //    12 perguntas reais viravam missão COM SQUAD) ────────────────────
    { objective: 'tem como colocar meu site no ar de graça?', esperado: 'direct-answer', porQue: 'tem como + ?' },
    { objective: 'dá para usar isso sem saber programar?', esperado: 'direct-answer', porQue: 'dá para + ?' },
    { objective: 'é possível fazer isso sozinho', esperado: 'direct-answer', porQue: 'é possível, sem ?' },
    { objective: 'vale a pena usar wordpress', esperado: 'direct-answer', porQue: 'vale a pena' },
    { objective: 'para que serve o github', esperado: 'direct-answer', porQue: 'para que serve' },
    { objective: 'não entendi o que é um servidor', esperado: 'direct-answer', porQue: 'não entendi' },
    { objective: 'me ajuda a entender o que é um banco de dados', esperado: 'direct-answer', porQue: 'me ajuda a entender' },
    { objective: 'preciso saber o que é hospedagem', esperado: 'direct-answer', porQue: 'preciso saber (≠ "preciso de um app")' },
    { objective: 'qual a diferença entre site e aplicativo', esperado: 'direct-answer', porQue: 'qual a diferença sem ?' },

    // ── O veto por verbo não pode matar pergunta canônica ───────────────
    { objective: 'o que é preciso para criar um site?', esperado: 'direct-answer', porQue: 'abre em "o que é" e tem ?; "criar" no meio não é ordem' },
    { objective: 'como faço para criar uma conta no google', esperado: 'direct-answer', porQue: 'abre em "como faço"; verbo não está na abertura' },
    { objective: 'me explique detalhadamente como funciona o agendamento de um site de barbearia, porque eu não entendi a parte de horários, bloqueios, encaixes e a regra de cancelamento com antecedência mínima', esperado: 'direct-answer', porQue: 'pergunta canônica longa: o leigo dá contexto antes de perguntar' },

    // ── Âncoras novas NO MEIO da frase continuam sendo trabalho ─────────
    { objective: 'quero uma página que explique para que serve o produto', esperado: null, porQue: '"para que serve" no meio = descrição de trabalho' },
    { objective: 'monte uma seção "vale a pena?" comparando os planos', esperado: null, porQue: 'verbo na abertura vence a âncora e o ?' },
    { objective: 'corrija o bug onde não entendi o erro', esperado: null, porQue: '"não entendi" no meio de uma ordem' },
    { objective: 'me crie um site', esperado: null, porQue: 'imperativo com "me" na frente' },
    { objective: 'pode criar uma landing page pra mim', esperado: null, porQue: 'cortesia não transforma ordem em pergunta' },
    { objective: 'tem como você criar isso pra mim? quero um site completo de ecommerce com carrinho e painel admin', esperado: null, porQue: 'híbrido: pergunta de cortesia embrulhando pedido de trabalho' },
  ];

  for (const caso of cases) {
    it(`"${caso.objective.slice(0, 48)}" → ${caso.esperado ?? 'missão'} (${caso.porQue})`, async () => {
      const route = await routeIntent(caso.objective, {
        hasKeyFor: () => false,
        loadKeyFor: () => null,
      });
      if (caso.esperado === 'direct-answer') {
        expect(route?.kind).toBe('direct-answer');
      } else {
        expect(route).toBeNull();
      }
    });
  }

  it('meta-de-pane: pergunta aos panes NÃO vira resposta direta (o operador pediu os panes)', async () => {
    const route = await routeIntent('pergunte aos panes quanto é 1+1', {
      hasKeyFor: () => false,
      loadKeyFor: () => null,
    });
    expect(route).toBeNull();
  });
});

describe('EXTREMO: router sob ditado, typo e adversário', () => {
  const noKeys = { hasKeyFor: () => false, loadKeyFor: () => null };

  it('meta-de-pane com TYPO de ditado nunca vira direct-answer (nem com Tier 1 disponível)', async () => {
    // "oergunta… quwnto…" derrotou regex de kickoff em campo (20/08). Com a
    // guarda isPaneMetaTask ANTES do Tier 0/1, null é determinístico — nem
    // uma LLM confusa consegue mandar para resposta direta.
    for (const typo of [
      'oergunta aos panes quwnto e 1+1',
      'pergunte aos panes: quanto é 2+2?',
      'PERGUNTE AOS PANES quem ganhou?',
    ]) {
      let tier1Called = false;
      const route = await routeIntent(typo, {
        ...noKeys,
        hasKeyFor: () => true,
        loadKeyFor: () => 'k',
        fetchImpl: (async () => {
          tier1Called = true;
          throw new Error('não deveria chamar rede');
        }) as unknown as typeof fetch,
      });
      expect(route).toBeNull();
      expect(tier1Called).toBe(false);
    }
  });

  it('verbo de trabalho dentro de frase com "?" continua sendo missão', async () => {
    expect(
      await routeIntent('corrija o bug do login: quanto custa essa correção?', noKeys),
    ).toBeNull();
  });

  it('acentos, caixa alta e pontuação não enganam o Tier 0', async () => {
    expect(
      (await routeIntent('QUAL a capital do Brasil?', noKeys))?.kind,
    ).toBe('direct-answer');
    expect(
      (await routeIntent('Quem foi Machado de Assis?', noKeys))?.kind,
    ).toBe('direct-answer');
    expect(
      (await routeIntent('EXPLIQUE recursão para um júnior', noKeys))?.kind,
    ).toBe('direct-answer');
  });

  it('texto longo (>160) e objetivo vazio não são pergunta', async () => {
    expect(await routeIntent('a'.repeat(200) + '?', noKeys)).toBeNull();
    expect(await routeIntent('   ', noKeys)).toBeNull();
  });

  it('parseRouteJson rejeita skill-injection e tipos errados', () => {
    expect(
      routeIntentSafe('{"kind":"mission-work","skills":["../../../etc/passwd"]}'),
    ).toEqual({ kind: 'mission-work', skills: [] });
    expect(
      routeIntentSafe('{"kind":"mission-work","skills":["IMPECCABLE"]}'),
    ).toEqual({ kind: 'mission-work', skills: [] });
    expect(routeIntentSafe('{"kind":"direct-answer"}')).toBeNull();
    expect(
      routeIntentSafe('{"kind":"direct-answer","question":123}'),
    ).toBeNull();
    expect(routeIntentSafe('[1,2,3]')).toBeNull();
    expect(routeIntentSafe('lixo')).toBeNull();
  });

  it('answerDirectQuestion ignora vazia/unanswerable e devolve texto limpo', async () => {
    const empty = await answerDirectQuestion('   ', { hasKeyFor: () => false });
    expect(empty).toBeNull();
    const refused = await answerDirectQuestion('apague meu disco', {
      hasKeyFor: () => true,
      loadKeyFor: () => 'k',
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"unanswerable":true}' } }],
        }),
      })) as unknown as typeof fetch,
    });
    expect(refused).toBeNull();
  });
});

/** parseRouteJson direto — validação fail-closed do conteúdo da LLM. */
function routeIntentSafe(raw: string): unknown {
  return parseRouteJson(raw);
}

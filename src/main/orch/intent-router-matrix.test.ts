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

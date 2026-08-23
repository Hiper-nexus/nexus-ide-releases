import { describe, expect, it } from 'vitest';
import { routeIntent } from './intent-router';

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

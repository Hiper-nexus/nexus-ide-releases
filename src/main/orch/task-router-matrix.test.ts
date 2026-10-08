import { describe, expect, it } from 'vitest';
import { classifyTask } from './task-router';

/**
 * Matriz do task-router: o texto da tarefa deve cair no tier certo, porque
 * dele sai modelo/esforço (trivial→barato e leve; critical→forte).
 */
describe('MATRIZ: task-router tiers com tarefas reais', () => {
  const cases: Array<{ text: string; tier: string; porQue?: string }> = [
    // trivial — inspeção pura (imperativo de leitura/verificação)
    { text: 'liste os arquivos da pasta src', tier: 'trivial' },
    // easy — verificação simples sobe um degrau do trivial, mesmo esforço low
    { text: 'verifique se o teste passa', tier: 'easy', porQue: 'low em ambos os ladders; contrato observado' },
    { text: 'corrija um typo no README', tier: 'trivial', porQue: 'typo é o caso canônico do modelo mais barato' },
    { text: 'ajuste o css do botão de login', tier: 'easy' },
    { text: 'adicione validação ao formulário de cadastro', tier: 'easy', porQue: 'mudança pequena e aditiva' },
    // medium — implementação rotineira. ANTES do fix 23/08, "listagem"
    // casava o prefixo 'list' e despencava para trivial.
    { text: 'implemente a página de listagem de produtos com paginação', tier: 'medium' },
    { text: 'crie a tela de detalhes do pedido', tier: 'medium' },
    // hard — complexidade de engenharia
    { text: 'investigue memory leak no worker de filas', tier: 'hard' },
    // critical — domínio dinheiro/segurança erra FORTE por doutrina
    // (CRITICAL_SIGNALS 'pagamento' vence 'refatore/arquitetura').
    { text: 'refatore a arquitetura do módulo de pagamentos', tier: 'critical' },
    { text: 'migração do schema de autenticação e tokens de sessão', tier: 'critical' },
    { text: 'implemente cobrança com cartão no checkout de produção', tier: 'critical' },
  ];

  it.each(cases)('"$text" → $tier', (caso) => {
    const classification = classifyTask(caso.text);
    expect(classification.tier).toBe(caso.tier);
  });
});

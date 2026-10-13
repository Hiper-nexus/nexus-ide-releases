import { describe, expect, it } from 'vitest';
import { classifyTask, explicitTaskTier } from './task-router';
import { routingOverridesFrom } from './jev-task-routing';

// F-1427 (13/10): duas tarefas que começavam com "Correção hard no …" foram
// classificadas trivial (esforço low, Muse Spark / DeepSeek Flash) porque o
// texto também dizia "contar" e "leitura".
const SUPERVISOR_FIX =
  'Correção hard no supervisor do F-1414: contar o erro de provedor do pane parado ' +
  'como falha e reabrir a tarefa noutra CLI; leitura do rodapé da própria CLI.';
const GATE_FIX =
  'Correção hard no portão do route_task: o exclude do Maestro tem que contar o pane ' +
  'fechado sem entrega; leitura de "sem morte nesta missão".';

describe('F-1427: tier explícito escrito na tarefa domina sinais lexicais fracos', () => {
  it.each([
    ['supervisor', SUPERVISOR_FIX],
    ['portão', GATE_FIX],
  ])('"Correção hard no %s…" é hard, não trivial', (_label, task) => {
    const result = classifyTask(task);
    expect(result.tier).toBe('hard');
    expect(result.signals).toContain('tier explícito: hard');
  });

  it.each([
    ['tier: critical — rotação do token', 'critical'],
    ['Tarefa crítica: ler o log e contar as falhas', 'critical'],
    ['Crítico: corrigir a perda de handoff', 'critical'],
    ['[easy] contar as linhas do README', 'easy'],
    ['Complexidade: média. Listar os panes e contar os workers', 'medium'],
    ['Correção difícil no parser de limites', 'hard'],
    ['Bugfix trivial: renomear a variável', 'trivial'],
  ] as const)('%s → %s', (task, tier) => {
    expect(explicitTaskTier(task)).toBe(tier);
    expect(classifyTask(task).tier).toBe(tier);
  });

  it.each([
    'Revise o caminho crítico do render e liste os gargalos',
    'Implemente o modo hard do jogo de cartas',
    'Corrigir o texto "nível médio" no seletor de dificuldade',
    'Media query responsiva para o cabeçalho',
    'Hard reset do estado do formulário ao sair',
  ])('palavra de tier fora da posição de rótulo não é tier explícito: %s', (task) => {
    expect(explicitTaskTier(task)).toBeNull();
  });

  it('o tier explícito vence o tier confiante do Jev (o do caller continua mandando)', () => {
    const jevTrivial = {
      tier: 'trivial' as const,
      tierConfidence: 0.9,
      specialty: 'general' as const,
      specialtyConfidence: 0.9,
      escalate: 0,
      model: 'jev',
    };
    expect(routingOverridesFrom(jevTrivial, undefined, SUPERVISOR_FIX).tierOverride).toBe('hard');
    expect(routingOverridesFrom(jevTrivial, 'medium', SUPERVISOR_FIX).tierOverride).toBe('medium');
    expect(routingOverridesFrom(null, undefined, SUPERVISOR_FIX).tierOverride).toBe('hard');
  });
});

describe('F-1427: "contar"/"leitura" numa correção não rebaixam para trivial', () => {
  it('correção sem tier explícito e só sinais de leitura fica no padrão (medium)', () => {
    const task =
      'Corrigir o supervisor para contar a leitura do rodapé de erro como sinal do pane parado';
    expect(classifyTask(task).tier).not.toBe('trivial');
  });

  it('inspeção pura continua trivial', () => {
    expect(classifyTask('Contar quantos panes estão abertos na missão agora').tier).toBe('trivial');
    expect(classifyTask('Leitura do arquivo de status e listar os workers vivos').tier).toBe('trivial');
  });
});

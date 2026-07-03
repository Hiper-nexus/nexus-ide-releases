import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  classifyTask,
  routeTask,
  type AdapterAvailability,
} from './task-router';

function adapters(...installed: string[]): AdapterAvailability[] {
  const all = ['claude', 'codex', 'gemini', 'grok', 'kimi', 'agy', 'glm'];
  return all.map((id) => ({ id, installed: installed.includes(id) }));
}

describe('classifyTask', () => {
  it('flags security/payment/migration work as critical', () => {
    expect(classifyTask('implementar autenticação com refresh token').tier).toBe(
      'critical',
    );
    expect(classifyTask('fix the payment webhook retries').tier).toBe('critical');
    expect(classifyTask('rodar a migração do schema multi-tenant').tier).toBe(
      'critical',
    );
  });

  it('critical keywords keep their floor even in short asks', () => {
    expect(classifyTask('corrigir auth').tier).toBe('critical');
  });

  it('flags architecture/refactor/performance work as hard', () => {
    expect(
      classifyTask(
        'refatorar o motor de layout para melhorar a performance do canvas',
      ).tier,
    ).toBe('hard');
  });

  it('flags cosmetic work as easy', () => {
    expect(
      classifyTask('corrigir typo no README e ajustar o comentário da função').tier,
    ).toBe('easy');
  });

  it('flags read-only checks as trivial', () => {
    expect(classifyTask('listar os arquivos do diretório e verificar o status').tier).toBe(
      'trivial',
    );
  });

  it('defaults unmatched medium-size tasks to medium', () => {
    const { tier, signals } = classifyTask(
      'adicionar um endpoint que retorna o resumo diário dos usuários ativos',
    );
    expect(tier).toBe('medium');
    expect(signals).toEqual([]);
  });

  it('nudges a one-liner without signals down a tier', () => {
    expect(classifyTask('adicionar botão novo').tier).toBe('easy');
  });

  it('nudges a very long multi-part brief up a tier', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `passo ${i} do fluxo com detalhes e requisitos`,
    ).join(' ');
    expect(classifyTask(long).tier).toBe('hard');
  });
});

describe('routeTask', () => {
  it('routes easy work to the cheapest installed candidate', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('grok', 'claude', 'codex'),
    );
    expect(decision).not.toBeNull();
    expect(decision!.tier).toBe('easy');
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.model).toBe('grok-4-fast');
    expect(decision!.effort).toBe('low');
  });

  it('routes critical work to the strong tier with high effort', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação e dos pagamentos',
      adapters('claude', 'grok'),
    );
    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-fable-5');
    expect(decision!.effort).toBe('xhigh');
  });

  it('falls through to the next candidate when the first is not installed', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('claude'),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-sonnet-4-6');
  });

  it('borrows from another tier when the target tier has nothing installed', () => {
    // Only glm installed: glm isn't a trivial/easy candidate, so an easy task
    // borrows it from the medium tier (where GLM 5.2 leads).
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('glm'),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).toContain('melhor opção instalada');
  });

  it('leads the medium tier with GLM 5.2 (cheap + strong)', () => {
    const decision = routeTask(
      'tarefa de complexidade média',
      adapters('claude', 'glm', 'codex'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.model).toBe('glm-5.2');
  });

  it('respects an explicit tier override', () => {
    const decision = routeTask(
      'tarefa qualquer sem sinais',
      adapters('claude', 'grok'),
      DEFAULT_ROUTING_TABLE,
      'critical',
    );
    expect(decision!.tier).toBe('critical');
    expect(decision!.model).toBe('claude-fable-5');
  });

  it('returns null when no adapter is installed', () => {
    expect(routeTask('qualquer tarefa', adapters())).toBeNull();
  });

  it('lists the remaining tier candidates as alternatives', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação',
      adapters('claude', 'codex'),
    );
    expect(decision!.alternatives.length).toBeGreaterThan(0);
    expect(decision!.alternatives[0].adapterId).toBe('claude');
  });
});

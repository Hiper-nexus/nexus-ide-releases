import { describe, expect, it } from 'vitest';
import { parseGuidedTaskKind, GUIDED_TASK_DOMAINS } from './guided-task-kind';

/**
 * LÁPIDE DA CLASSE INTEIRA DE MORTES DE 06/08.
 *
 * O usuário perdeu o dia contra quatro rostos do MESMO defeito: o guard de
 * worktree que impedia a missão de começar, o revisor read_only recusado por
 * não ter worktree, a missão estacionada em `handoff_ready`, e o
 * `same_checkout` rejeitado na entrega. Todos vinham de uma suposição:
 * "sem worktree isolada ⇒ inválido".
 *
 * Este arquivo fixa o contrato do caminho SIMPLES por padrão. Se a suposição
 * voltar por qualquer porta, ele morre antes do usuário.
 */
describe('caminho simples é o padrão — taxonomia', () => {
  it('a entrega comum é um simple-implementation em same_checkout', () => {
    const kind = parseGuidedTaskKind({
      agentCategory: 'executor',
      executionMode: 'same_checkout',
      domains: [GUIDED_TASK_DOMAINS.simpleImplementation],
      label: 'entrega',
    });

    expect(kind).toBe('simple-implementation');
  });

  it('o fan-out largo continua isolado, sem mudança de comportamento', () => {
    const kind = parseGuidedTaskKind({
      agentCategory: 'executor',
      executionMode: 'isolated_worktree',
      domains: [GUIDED_TASK_DOMAINS.implementation],
      label: 'entrega-isolada',
    });

    expect(kind).toBe('implementation');
  });

  it('um plano MISTO é legítimo: os dois kinds coexistem', () => {
    // Interop: uma missão não é obrigada a ter uma forma só.
    const simples = parseGuidedTaskKind({
      agentCategory: 'executor',
      executionMode: 'same_checkout',
      domains: [GUIDED_TASK_DOMAINS.simpleImplementation],
    });
    const isolada = parseGuidedTaskKind({
      agentCategory: 'executor',
      executionMode: 'isolated_worktree',
      domains: [GUIDED_TASK_DOMAINS.implementation],
    });

    expect(new Set([simples, isolada]).size).toBe(2);
  });

  it('recusa same_checkout carimbado no kind isolado (fail-closed intacto)', () => {
    expect(() =>
      parseGuidedTaskKind({
        agentCategory: 'executor',
        executionMode: 'same_checkout',
        domains: [GUIDED_TASK_DOMAINS.implementation],
        label: 'incoerente',
      }),
    ).toThrow(/isolated_worktree/i);
  });

  it('recusa um revisor tentando escrever no checkout compartilhado', () => {
    expect(() =>
      parseGuidedTaskKind({
        agentCategory: 'reviewer',
        executionMode: 'same_checkout',
        domains: [GUIDED_TASK_DOMAINS.simpleImplementation],
        label: 'revisor-escritor',
      }),
    ).toThrow(/executor/i);
  });
});

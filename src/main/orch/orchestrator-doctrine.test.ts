import { describe, expect, it } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import { buildOrchestratorDoctrine } from './orchestrator-doctrine';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

function squad(overrides: Partial<Squad> = {}): Squad {
  return {
    id: 'squad-1',
    name: 'Equipe',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '',
    agents: [],
    ...overrides,
  } as Squad;
}

describe('orchestrator doctrine', () => {
  it('ensina a espera dirigida por handoff e o anti-polling (idle-delivery)', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toMatch(/idle/i);
    // anti-polling: proíbe vigiar worker vivo em loop de read/wait
    expect(text).toMatch(/nexus_pane_read|pane_wait/);
    expect(text).toMatch(/delegar e encerrar o turno/i);
    expect(text).toMatch(/olhar o que o pane/i);
  });

  it('ensina delegação de 1 chamada e relay fiel do pedido humano', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toContain('nexus_pane_spawn');
    expect(text).toMatch(/nasce executando/);
    expect(text).toMatch(/relay/i);
  });

  it('carrega a política de workspace same_checkout sem stash/reset/checkout/clean', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toContain('same_checkout');
    expect(text).toMatch(/stash/);
    expect(text).toMatch(/reset/);
    expect(text).toMatch(/checkout/);
    expect(text).toMatch(/clean/);
  });

  it('carrega a nota de voz PT/tradução respondendo em PT-BR', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toMatch(/ditar em PT|ditado traduzido/i);
    expect(text).toMatch(/PT-BR/);
  });

  it('anexa orchestratorInstructions do squad VERBATIM quando existir', () => {
    const playbook =
      '# Playbook do operador\nRode os gates verdes antes de fechar a missão.';
    const text = buildOrchestratorDoctrine(
      squad({ orchestratorInstructions: playbook }),
      mission(),
    );
    expect(text).toContain(playbook);
  });

  it('não quebra sem squad e não injeta seção de playbook quando vazio', () => {
    expect(() => buildOrchestratorDoctrine(null, mission())).not.toThrow();
    const empty = buildOrchestratorDoctrine(
      squad({ orchestratorInstructions: '   ' }),
      mission(),
    );
    expect(empty).not.toMatch(/PLAYBOOK DO SQUAD/i);
    // a doutrina base continua presente
    expect(empty).toMatch(/idle/i);
  });

  it('a doutrina base (sem playbook do operador) fica curta (<2KB)', () => {
    const text = buildOrchestratorDoctrine(null, mission());
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(2048);
  });
});

import { describe, expect, it } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import {
  buildMaestroKickoffBrief,
  buildOrchestratorDoctrine,
} from './orchestrator-doctrine';

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


// Campo (14/08): orquestrador respondeu SOZINHO tarefa trivial e a missão
// parou até o SLA do supervisor. A doutrina agora fecha a brecha.
describe('buildMaestroKickoffBrief', () => {
  it('exporta o kickoff com tools de coordenação e a equipe', () => {
    const text = buildMaestroKickoffBrief({
      title: 'Prova',
      objective: 'Leia brief.txt',
      orchestratorName: 'Coordenar e revisar',
      teamNames: ['Coordenar e revisar', 'Implementar motor'],
    });
    expect(text).toContain('ORQUESTRAÇÃO');
    expect(text).toContain('nexus_pane_spawn');
    expect(text).toContain('nexus_handoff_list');
    expect(text).toContain('nexus_mission_set_status');
    expect(text).toContain('Implementar motor');
  });

  it('cita first-wave quando há plano selado', () => {
    const text = buildMaestroKickoffBrief({
      title: 'Prova',
      objective: '### Plano selado\nO board já rastreia 20 tasks do objetivo.',
      orchestratorName: 'Maestro',
      teamNames: ['Maestro'],
      sealedPlanTitles: Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`),
    });
    expect(text).toContain('task selada pendente');
    expect(text).toContain('first-wave');
  });
});

describe('doutrina exige delegação total (nem o trivial é respondido no pane)', () => {
  it('diz que TODO pedido do objetivo vira dispatch de worker', () => {
    const doctrine = buildOrchestratorDoctrine(null, {} as never);
    expect(doctrine).toContain('EXECUÇÃO');
    expect(doctrine).toContain('inclusive uma pergunta trivial');
    expect(doctrine).toContain('dispatch de worker');
  });
});

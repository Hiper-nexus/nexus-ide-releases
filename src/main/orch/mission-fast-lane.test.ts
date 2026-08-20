import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import {
  agentPrompt,
  decideExternalHeadChangeAction,
  decideFastLaneEmptyPaneAction,
  decideFastLaneResumeAction,
  missionDesignContext,
  missionFastLaneEnabled,
  isPaneMetaTask,
} from './mission-fast-lane';

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
    ...overrides,
  } as Mission;
}

function agent(overrides: Partial<SquadAgent> = {}): SquadAgent {
  return {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'codex',
    ...overrides,
  } as SquadAgent;
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

describe('mission fast lane', () => {
  it('é o caminho único: o motor cerimonial e o env de opt-out morreram', () => {
    process.env.NEXUS_CEREMONIAL_MISSIONS = '1';
    try {
      expect(missionFastLaneEnabled()).toBe(true);
    } finally {
      delete process.env.NEXUS_CEREMONIAL_MISSIONS;
    }
  });

  it('prompt do worker é curto, com objetivo e instruções Overlock', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
    );
    expect(prompt).toContain('Implementar motor');
    expect(prompt).toContain('Leia brief.txt');
    expect(prompt).toContain('trabalhador');
    // C-194.1: as regras de entrega vivem no contrato anexado no spawn —
    // o corpo do prompt aponta para o contrato em vez de citar a tool.
    expect(prompt).toMatch(/regras de entrega.*contrato/i);
    expect(prompt.length).toBeLessThan(2000);
  });

  it('prompt do orquestrador contém instruções Overlock de coordenação', () => {
    const prompt = agentPrompt(
      agent({ id: 'coord', agentName: 'Coordenar e revisar', category: 'orchestrator' }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
    );
    expect(prompt).toContain('ORQUESTRAÇÃO');
    expect(prompt).toContain('nexus_pane_spawn');
    expect(prompt).toContain('nexus_handoff_list');
    expect(prompt).toContain('nexus_mission_set_status');
    expect(prompt).toContain('NUNCA');
    expect(prompt).toContain('Implementar motor');
  });

  it('plano selado de 20 stories entra no kickoff e proíbe colapso em papéis', () => {
    const titles = Array.from(
      { length: 20 },
      (_, index) => `Story ${index + 1} da waitlist`,
    );
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad(),
      titles,
    );
    expect(prompt).toContain('Plano selado');
    expect(prompt).toContain('São 20 entregas');
    expect(prompt).toContain('NÃO reduza a lista aos papéis do squad');
    expect(prompt).toContain('Story 20 da waitlist');
    expect(prompt).toContain('task selada pendente');
  });

  it('retomada avisa que foi religado', () => {
    const prompt = agentPrompt(agent(), mission(), [], true);
    expect(prompt).toContain('religado');
  });

  it('missão de UI aponta DESIGN.md do projeto e o catálogo ~/.design-references sem atrito', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'fastlane-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'fastlane-home-'));
    writeFileSync(join(workspace, 'DESIGN.md'), '# tokens');
    mkdirSync(join(home, '.design-references'));
    writeFileSync(join(home, '.design-references', 'README.md'), '# índice');

    const context = missionDesignContext(workspace, home);
    expect(context).toContain('DESIGN.md');
    expect(context).toContain('.design-references');

    const uiMission = mission({
      description:
        'Redesenhe a tela de login com um layout novo de interface e css.',
    });
    const prompt = agentPrompt(agent(), uiMission, [], false, context);
    expect(prompt).toContain('DESIGN.md');
    expect(prompt).toContain('.design-references');

    // Sem nada no disco: contexto vazio e prompt continua limpo.
    const emptyHome = mkdtempSync(join(tmpdir(), 'fastlane-vazio-'));
    expect(missionDesignContext(emptyHome, emptyHome)).toBe('');
  });

  it('missão sem cara de UI não carrega o catálogo de design', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      [],
      false,
      'Catálogo: ~/.design-references',
    );
    expect(prompt).not.toContain('design-references');
  });

  it('kickoff do orquestrador injeta a doutrina + o playbook do squad', () => {
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad({
        orchestratorInstructions: 'Rode os gates verdes antes de fechar a missão.',
      }),
    );
    // doutrina de orquestração: instruções MCP
    expect(prompt).toContain('nexus_pane_spawn');
    expect(prompt).toContain('nexus_handoff_list');
    // playbook do squad, verbatim
    expect(prompt).toContain('Rode os gates verdes antes de fechar a missão.');
    // sem 'same_checkout' no novo formato (o orquestrador não precisa saber)
  });

  it('kickoff de worker NÃO recebe o bloco de delegação/doutrina', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad({ orchestratorInstructions: 'Rode os gates verdes.' }),
    );
    expect(prompt).not.toContain('nexus_pane_spawn');
    expect(prompt).not.toContain('nexus_handoff_list');
    expect(prompt).not.toContain('Rode os gates verdes.');
  });

  it('kickoff do Maestro cita o plano selado de 20 stories', () => {
    const titles = Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`);
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission({ description: '20 stories listadas no objetivo' }),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad(),
      titles,
    );
    expect(prompt).toContain('Plano selado');
    expect(prompt).toContain('São 20 entregas');
    expect(prompt).toContain('Story 1');
    expect(prompt).toContain('Story 20');
    expect(prompt).toContain('first-wave');
  });

  it('orquestrador sem orchestratorInstructions (ou sem squad) não quebra', () => {
    expect(() =>
      agentPrompt(
        agent({ id: 'coord', agentName: 'Coord', category: 'orchestrator' }),
        mission(),
        [],
        false,
        '',
        squad({ orchestratorInstructions: '' }),
      ),
    ).not.toThrow();
    const prompt = agentPrompt(
      agent({ id: 'coord', agentName: 'Coord', category: 'orchestrator' }),
      mission(),
      [],
      false,
    );
    // sem squad (default null), o orquestrador ainda recebe instruções Overlock
    expect(prompt).toContain('ORQUESTRAÇÃO');
    expect(prompt).toContain('nexus_pane_spawn');
  });
});

describe('decideFastLaneEmptyPaneAction (doutrina: missão nunca morre sozinha)', () => {
  it('com orçamento de respawn → respawna o orquestrador', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 0,
        respawnBudgetLeft: 3,
      }),
    ).toBe('respawn-orchestrator');
  });

  it('com handoffs pendentes → respawna para consumir as entregas', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 2,
        respawnBudgetLeft: 1,
      }),
    ).toBe('respawn-orchestrator');
  });

  it('sem orçamento → mantém running e observando (NUNCA bloqueia nem completa sozinho)', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 0,
        respawnBudgetLeft: 0,
      }),
    ).toBe('keep-running-watching');
  });
});

describe('decideFastLaneResumeAction (retry-kickoff faz algo de verdade)', () => {
  it('running + orquestrador vivo → só religa o watcher', () => {
    expect(
      decideFastLaneResumeAction({
        status: 'running',
        liveOrchestratorSession: true,
      }),
    ).toBe('watch');
  });

  it('running + orquestrador morto → respawna (antes: retorno silencioso = botão morto)', () => {
    expect(
      decideFastLaneResumeAction({
        status: 'running',
        liveOrchestratorSession: false,
      }),
    ).toBe('respawn');
  });

  it('não-running → bootstrap normal', () => {
    expect(
      decideFastLaneResumeAction({
        status: 'pending',
        liveOrchestratorSession: false,
      }),
    ).toBe('bootstrap');
  });
});

describe('decideExternalHeadChangeAction (sentinela de HEAD — achado #14)', () => {
  it('HEAD igual → ignora', () => {
    expect(
      decideExternalHeadChangeAction({ baseline: 'a1', current: 'a1' }),
    ).toEqual({ action: 'ignore' });
  });

  it('HEAD mudou por fora → notifica com from/to', () => {
    const decision = decideExternalHeadChangeAction({
      baseline: 'a1',
      current: 'b2',
    });
    expect(decision).toEqual({ action: 'notify', from: 'a1', to: 'b2' });
  });

  it('sem HEAD legível (não é repo) → ignora', () => {
    expect(
      decideExternalHeadChangeAction({ baseline: null, current: 'b2' }),
    ).toEqual({ action: 'ignore' });
    expect(
      decideExternalHeadChangeAction({ baseline: 'a1', current: null }),
    ).toEqual({ action: 'ignore' });
  });

  it('HEAD que bate na escada de SHAs das entregas da própria missão é interno (A6)', () => {
    // Worker do same_checkout commitou e entregou handoff com headSha — o
    // commit É da missão. Avisar gasta um turno do Maestro para "revalidar"
    // o próprio trabalho dele (8× falsos positivos na missão real).
    const ladder = new Set(['h-work1', 'h-work2', 'b-work1']);
    expect(
      decideExternalHeadChangeAction({
        baseline: 'old',
        current: 'h-work2',
        missionShaLadder: ladder,
      }),
    ).toEqual({ action: 'internal', from: 'old', to: 'h-work2' });
    // baseSha de handoff posterior (worker B construiu sobre o trabalho de A).
    expect(
      decideExternalHeadChangeAction({
        baseline: 'old',
        current: 'b-work1',
        missionShaLadder: ladder,
      }),
    ).toEqual({ action: 'internal', from: 'old', to: 'b-work1' });
    // SHA fora da escada segue sendo aviso — a sentinela não pode cegar.
    expect(
      decideExternalHeadChangeAction({
        baseline: 'old',
        current: 'c-estranho',
        missionShaLadder: ladder,
      }),
    ).toEqual({ action: 'notify', from: 'old', to: 'c-estranho' });
  });
});

describe('isPaneMetaTask — meta-de-pane fica com o Maestro', () => {
  it('reconhece as formas reais ditadas pelo operador em 20/08', () => {
    expect(isPaneMetaTask('pergunte ao panes quanto e 1+1')).toBe(true);
    expect(isPaneMetaTask('abre os panes. e pergunta csadad um dles quanto e 1+1')).toBe(true);
    expect(isPaneMetaTask('chame o pane kimi e pergunte quanto é 1+1')).toBe(true);
    expect(isPaneMetaTask('cada pane responda quanto é 1+1 e reporte')).toBe(true);
  });

  it('task de CÓDIGO que menciona pane continua indo para worker', () => {
    expect(isPaneMetaTask('corrigir o pane-close-guard do renderer')).toBe(false);
    expect(isPaneMetaTask('refatorar PaneToolbar para o novo layout')).toBe(false);
    expect(isPaneMetaTask('implementar dashboard de vendas')).toBe(false);
  });
});

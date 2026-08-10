import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import {
  agentPrompt,
  missionDesignContext,
  missionFastLaneEnabled,
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

  it('prompt do executor é curto, com objetivo, equipe e marcadores de fim', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
    );
    expect(prompt).toContain('Implementar motor');
    expect(prompt).toContain('Leia brief.txt');
    expect(prompt).toContain('Coordenar e revisar');
    expect(prompt).toContain('PRONTO:');
    expect(prompt).toContain('BLOQUEADO:');
    // A alma da correção de lentidão: nada de parede de protocolo.
    expect(prompt.length).toBeLessThan(1200);
    expect(prompt).not.toContain('NEXUS_ACTION');
    expect(prompt).not.toContain('receipt');
  });

  it('prompt da coordenação pede verificação real e autoriza corrigir', () => {
    const prompt = agentPrompt(
      agent({ id: 'coord', agentName: 'Coordenar e revisar', category: 'orchestrator' }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
    );
    expect(prompt).toContain('coordenação');
    expect(prompt).toMatch(/verifique/i);
    expect(prompt).toMatch(/corrija você mesmo/i);
  });

  it('retomada avisa para conferir o que já existe antes de refazer', () => {
    const prompt = agentPrompt(agent(), mission(), [], true);
    expect(prompt).toMatch(/RETOMADA/i);
    expect(prompt).toMatch(/antes de refazer/i);
  });

  it('instruções específicas do papel entram no prompt', () => {
    const prompt = agentPrompt(
      agent({ instructions: 'Use apenas comandos POSIX.' }),
      mission(),
      [],
      false,
    );
    expect(prompt).toContain('Use apenas comandos POSIX.');
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
    // doutrina de orquestração
    expect(prompt).toMatch(/idle/i);
    expect(prompt).toContain('nexus_pane_spawn');
    expect(prompt).toContain('same_checkout');
    // playbook do squad, verbatim
    expect(prompt).toContain('Rode os gates verdes antes de fechar a missão.');
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
    expect(prompt).not.toContain('same_checkout');
    expect(prompt).not.toContain('Rode os gates verdes.');
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
    // sem squad (default null) a doutrina base continua presente
    expect(prompt).toMatch(/idle/i);
  });
});

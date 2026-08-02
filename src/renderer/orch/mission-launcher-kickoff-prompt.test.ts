import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import { buildMissionKickoffPrompt } from './mission-launcher-kickoff-prompt';

const squad = {
  id: 'squad-a',
  name: 'Execução + QA',
  orchestratorInstructions: 'Coordene execução e QA.',
  agents: [
    {
      id: 'agent-orch',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
      model: 'claude-sonnet-5',
      tools: [],
    },
    {
      id: 'agent-exec',
      agentName: 'Executor principal',
      category: 'executor',
      cli: 'grok',
      model: 'grok-4.5',
      tools: [],
    },
  ],
} as unknown as Squad;

function prompt(): string {
  return buildMissionKickoffPrompt(squad, 'mission-launcher');
}

describe('escada de fontes de design no playbook do lançador', () => {
  it('ensina as quatro fontes em ordem, com as duas sem chave nomeadas', () => {
    const text = prompt();

    expect(text).toMatch(/\(1\)[\s\S]{0,200}?DESIGN\.md/i);
    expect(text).toMatch(/\(2\)[\s\S]{0,200}?nexus_design_system_local_list/);
    expect(text).toMatch(/\(2\)[\s\S]{0,200}?source=local-catalog/i);
    expect(text).toMatch(/\(3\)[\s\S]{0,200}?source=getdesign/i);
    expect(text).toMatch(/\(4\)[\s\S]{0,200}?designmd\.ai/);
    expect(text).toContain('external:designmd-api-key');
    expect(text).toContain('nexus_design_system_local_import');
  });

  it('mantém extract como tentativa única e o publish sob pedido explícito', () => {
    const text = prompt();

    expect(text).toMatch(/nexus_design_system_extract[\s\S]{0,80}?uma vez/i);
    expect(text).toMatch(/NETWORK_GUARD_UNAVAILABLE/);
    expect(text).toMatch(/nexus_design_system_publish[\s\S]{0,120}?explícit/i);
    expect(text).toMatch(/impeccable/i);
    expect(text).toMatch(/look de IA/i);
  });

  it('não sobrevive no perfil pet-studio, que é uma missão visual dedicada', () => {
    const text = buildMissionKickoffPrompt(squad, 'mission-pet', null, 'pet-studio');

    expect(text).toContain('nexus-pet-studio');
    expect(text).not.toContain('nexus_design_system_local_list');
  });
});

import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import { buildMissionKickoffPrompt } from './mission-launcher';

const squad: Squad = {
  id: 'squad-test',
  name: 'Test Squad',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: '',
  agents: [{
    id: 'orchestrator',
    agentName: 'orchestrator',
    category: 'orchestrator',
    cli: 'claude',
  }],
};

describe('mission kickoff context/PREVC contract', () => {
  it('orders context, frozen contract and one sealed plan owned by the main dispatcher', () => {
    const prompt = buildMissionKickoffPrompt(squad, 'mission-a');
    const orderedTools = [
      'nexus_context_doctor',
      'nexus_mission_freeze_contract',
      'nexus_task plan',
      'nexus_handoff_list',
    ];
    let previous = -1;
    for (const tool of orderedTools) {
      const index = prompt.indexOf(tool, previous + 1);
      expect(index, `${tool} missing from kickoff`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(prompt).toContain('Nunca invente regra de negócio');
    expect(prompt).toContain('receipts imutáveis');
    expect(prompt).toMatch(/Nunca declare done manualmente sem PREVC|declare a missão done manualmente/i);
    expect(prompt).toContain('PILOTO AUTOMÁTICO');
    expect(prompt).toContain('blast radius');
    expect(prompt).toContain('plano inteiro em UMA chamada');
    expect(prompt).toContain('DESIGN.md');
    expect(prompt).toContain('nexus_design_system_search/get/import');
    expect(prompt).toContain('Orientação estrutural do repositório');
    expect(prompt).toContain('nexus_context_doctor');
    expect(prompt).toContain('quorumAvailable');
    expect(prompt).toContain('review→apply→commit');
    expect(prompt).toContain('chame nexus_context_doctor novamente');
    expect(prompt).toContain('não abra draft_review_run em paralelo');
    expect(prompt).not.toContain('Só chame draft_review_run manual se quorumAvailable=false');
    expect(prompt).not.toContain('Só claude/glm/longcat');
    expect(prompt).not.toContain('gpt-5.4-mini');
    expect(prompt).not.toContain('gpt-5.5');
    expect(prompt).toContain('NUNCA peça stash/reset/limpeza');
    expect(prompt).toContain('dispatcher durável do main');
    expect(prompt).toContain('NÃO crie worktree');
    expect(prompt).toContain('NÃO spawne worker');
    expect(prompt).toContain('agentRef');
    expect(prompt).toContain('executionMode');
    expect(prompt).not.toContain('nexus_task create');
  });

  it('forbids done without PREVC while the mission is already running', () => {
    const prompt = buildMissionKickoffPrompt(squad, 'mission-a');

    expect(prompt).toContain('já está em `running`');
    // Explicit anti-pattern: tool may be named only to forbid premature done.
    expect(prompt).toMatch(/NUNCA use nexus_mission_set_status done|nunca declare done/i);
    expect(prompt).toMatch(/status=blocked|marque `blocked`/i);
    expect(prompt.indexOf('nexus_context_doctor')).toBeLessThan(
      prompt.indexOf('nexus_mission_freeze_contract'),
    );
  });

  it('injects provided orientation markdown as auto-pilot L1 block', () => {
    const prompt = buildMissionKickoffPrompt(
      squad,
      'mission-a',
      '# Project orientation\n- Languages: ts (3)\n',
    );
    expect(prompt).toContain('# Project orientation');
    expect(prompt).toContain('Languages: ts (3)');
    expect(prompt).toContain('piloto automático');
    expect(prompt).toContain('blast radius');
  });

  it('keeps Pet Studio in one Codex session without repository pipeline', () => {
    const petSquad: Squad = {
      ...squad,
      id: 'nexus-pet-studio',
      name: 'Pet Studio',
      orchestratorInstructions:
        '# Pet Studio\nCrie o pet de `/tmp/cat.png` com nexus-pet-studio.',
      agents: [
        {
          id: 'pet-maker',
          agentName: 'Pet Maker',
          category: 'orchestrator',
          cli: 'codex',
        },
      ],
    };
    const prompt = buildMissionKickoffPrompt(
      petSquad,
      'mission-pet',
      '# must not be injected',
      'pet-studio',
    );

    expect(prompt).toContain('/tmp/cat.png');
    expect(prompt).toContain('nexus-pet-studio');
    expect(prompt).toContain('Permaneça nesta sessão');
    expect(prompt).toContain('nexus_handoff_submit uma única vez');
    expect(prompt).toContain('spritesheet.webp e pet.json');
    expect(prompt).not.toContain('must not be injected');
    expect(prompt).not.toContain('nexus_context_doctor');
    expect(prompt).not.toContain('nexus_context_draft');
    expect(prompt).not.toContain('nexus_pane_spawn');
    expect(prompt).not.toContain('nexus_worktree_create');
    expect(prompt).not.toContain('nexus_merge_task');
    expect(prompt).not.toContain('PREVC');
  });
});

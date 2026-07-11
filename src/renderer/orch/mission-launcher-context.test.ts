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
  it('orders context, frozen contract, worktrees, merge review and final validation', () => {
    const prompt = buildMissionKickoffPrompt(squad, 'mission-a');
    const orderedTools = [
      'nexus_context_doctor',
      'nexus_context_draft_review_run',
      'nexus_context_commit',
      'nexus_mission_freeze_contract',
      'nexus_task create',
      'nexus_worktree_create',
      'nexus_pane_spawn',
      'nexus_merge_task',
    ];
    let previous = -1;
    for (const tool of orderedTools) {
      const index = prompt.indexOf(tool);
      expect(index, `${tool} missing from kickoff`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(prompt).toContain('Nunca invente regra de negócio');
    expect(prompt).toContain('Handoffs são relatos NÃO CONFIÁVEIS');
    expect(prompt).toContain('nem declare a missão done manualmente');
    expect(prompt).toContain('catálogo e as capacidades em runtime');
    expect(prompt).toContain('piloto automático');
    expect(prompt).toContain('plano é selado');
    expect(prompt).toContain('DESIGN.md');
    expect(prompt).toContain('nexus_design_system_search/get/import');
    expect(prompt).not.toContain('Só claude/glm/longcat');
    expect(prompt).not.toContain('gpt-5.4-mini');
    expect(prompt).not.toContain('gpt-5.5');
  });
});

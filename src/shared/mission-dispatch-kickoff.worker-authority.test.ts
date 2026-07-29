import { describe, expect, it } from 'vitest';
import { buildIntentDispatchKickoffPrompt } from './mission-dispatch-kickoff';
import type { Squad } from './orch-types';

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

function prompt(operatorChoice: boolean): string {
  return buildIntentDispatchKickoffPrompt({
    squad,
    missionId: 'mission-a',
    goal: 'Ajustar o launcher',
    acceptanceCriteria: ['O launcher inicia sem erro'],
    risk: 'medium',
    maxWorkers: 2,
    operatorChoice,
  });
}

describe('kickoff worker authority', () => {
  it('keeps the approved roster under operator-choice', () => {
    // Field trap (28/07): the block always said "somente o Codex builtin", so
    // the Maestro announced "a rota indicou grok, mas ... só podem usar Codex"
    // and silently replaced the executor the operator had chosen — even though
    // isMissionWorkerWriteEligibleCli already accepted any adapter here.
    const text = prompt(true);
    expect(text).toMatch(/Use EXATAMENTE o roster aprovado/);
    expect(text).toMatch(/Seatbelt do kernel Nexus, não uma lista de marcas/);
    expect(text).not.toMatch(/somente o Codex builtin/);
    expect(text).not.toMatch(/Roster legado com Kimi, OMP, Grok/);
  });

  it('keeps the Codex-only wording when the policy is governed', () => {
    const text = prompt(false);
    expect(text).toMatch(/somente o Codex builtin/);
    expect(text).not.toMatch(/Use EXATAMENTE o roster aprovado/);
  });

  it('defaults to the governed wording when the policy is not supplied', () => {
    const text = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-a',
      goal: 'Ajustar o launcher',
      acceptanceCriteria: ['O launcher inicia sem erro'],
      risk: 'medium',
      maxWorkers: 2,
    });
    expect(text).toMatch(/somente o Codex builtin/);
  });
});

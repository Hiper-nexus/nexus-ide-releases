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
  it('conducts a roster roundtable as one parallel read-only wave', () => {
    const text = buildIntentDispatchKickoffPrompt({
      squad: {
        ...squad,
        agents: [
          ...squad.agents,
          {
            id: 'agent-review',
            agentName: 'Revisor',
            category: 'reviewer',
            cli: 'kimi',
            model: 'kimi-code',
            tools: [],
          },
        ],
      } as Squad,
      missionId: 'mission-roundtable',
      goal: 'Teste de todos panes, cada um me fala o que faz na missão',
      acceptanceCriteria: [],
      risk: 'low',
      maxWorkers: 2,
      standardTopology: 'team-read-only-fanout',
      operatorChoice: true,
    });

    expect(text).toMatch(/rodada da equipe/i);
    expect(text).toMatch(/todos os especialistas.*em paralelo/i);
    expect(text).toMatch(/O Main despacha todos/i);
    expect(text).toMatch(/Maestro acompanha e reconhece os handoffs/i);
    expect(text).toMatch(/seção “Maestro”.*própria perspectiva/i);
    expect(text).toMatch(/depois de TODOS os ACKs[\s\S]*## Maestro/i);
    expect(text).toMatch(
      /nexus_mission_set_status[\s\S]*status:"done"[\s\S]*receipt durável/i,
    );
    expect(text).toMatch(/somente leitura/i);
    expect(text).toMatch(/handoff.*cada especialista/i);
    expect(text).not.toMatch(/implementar|worktree|PREVC/i);
    expect(text).not.toMatch(/nexus_task list/i);
  });

  it('preserves sealed attachments, memory and squad guidance in a roundtable', () => {
    const text = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-roundtable-context',
      goal: 'Peça para todos os agentes analisarem o anexo e responderem',
      acceptanceCriteria: ['Cada agente cita o anexo'],
      risk: 'medium',
      maxWorkers: 4,
      attachmentPaths: ['/safe/brief.pdf'],
      compactMemoryMarkdown: '## Memória relevante\nDecisão arquitetural A.',
      standardTopology: 'team-read-only-fanout',
    });

    expect(text).toContain('/safe/brief.pdf');
    expect(text).toContain('Decisão arquitetural A.');
    expect(text).toContain('Coordene execução e QA.');
    expect(text).toContain('risco=medium · maxWorkers=4');
  });

  it('keeps a mutating team request on the delivery path', () => {
    const text = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-delivery',
      goal: 'Cada agente deve corrigir um bug diferente no projeto',
      acceptanceCriteria: [],
      risk: 'medium',
      maxWorkers: 2,
      operatorChoice: true,
    });

    expect(text).toMatch(/Missão autorizada/i);
    expect(text).toMatch(/worktree isolado/i);
    expect(text).not.toMatch(/rodada da equipe/i);
  });

  it('keeps the approved roster under operator-choice', () => {
    // Field trap (28/07): the block always said "somente o Codex builtin", so
    // the Maestro announced "a rota indicou grok, mas ... só podem usar Codex"
    // and silently replaced the executor the operator had chosen — even though
    // isMissionWorkerWriteEligibleCli already accepted any adapter here.
    const text = prompt(true);
    expect(text).toMatch(/Use EXATAMENTE o roster aprovado/);
    expect(text).toMatch(/worktree isolado.*acesso de rede/i);
    expect(text).toMatch(/busca\/fetch nativos/i);
    expect(text).toMatch(/browser Nexus/i);
    expect(text).toMatch(/blocked somente para autenticação, decisão humana/i);
    expect(text).not.toMatch(/somente o Codex builtin/);
    expect(text).not.toMatch(/Roster legado com Kimi, Grok/);
  });

  it('keeps the Codex-only wording when the policy is governed', () => {
    const text = prompt(false);
    expect(text).toMatch(/somente o Codex builtin/);
    expect(text).not.toMatch(/Use EXATAMENTE o roster aprovado/);
  });

  it('defaults to Autopilot roster wording when the policy is not supplied', () => {
    const text = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-a',
      goal: 'Ajustar o launcher',
      acceptanceCriteria: ['O launcher inicia sem erro'],
      risk: 'medium',
      maxWorkers: 2,
    });
    expect(text).toMatch(/Use EXATAMENTE o roster aprovado/);
    expect(text).not.toMatch(/somente o Codex builtin/);
  });

  it('starts guided workers while Main prepares PREVC for final promotion', () => {
    const text = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-guided',
      goal: 'Entregar a correção guiada',
      acceptanceCriteria: ['Candidate validado antes do merge'],
      risk: 'medium',
      maxWorkers: 2,
      guidedPrevcRequired: true,
      guidedPrevcFrozen: false,
      operatorChoice: true,
      uiMissionObjective: true,
    });

    expect(text).toMatch(/PREVC paralelo/i);
    expect(text).toMatch(/Comece a execução/i);
    expect(text).toMatch(/não bloqueia worker/i);
    expect(text).toMatch(/nexus_design_system_extract/);
    expect(text).not.toMatch(
      /nexus_context_doctor|nexus_mission_freeze_contract|nexus_workflow_prepare_execution/i,
    );
  });
});

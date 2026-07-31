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

function guidedPrompt(
  extra: Partial<Parameters<typeof buildIntentDispatchKickoffPrompt>[0]> = {},
): string {
  return buildIntentDispatchKickoffPrompt({
    squad,
    missionId: 'mission-guided',
    goal: 'Entregar a correção guiada',
    acceptanceCriteria: ['Candidate validado antes do merge'],
    risk: 'medium',
    maxWorkers: 2,
    guidedPrevcRequired: true,
    ...extra,
  });
}

describe('guided Main-owned PREVC kickoff', () => {
  it('drops the manual ACK step and the set_status=done close', () => {
    const prompt = guidedPrompt();

    expect(prompt).not.toContain('nexus_handoff_ack');
    expect(prompt).not.toContain('status=done');
    expect(prompt).toMatch(/Main já é dono do PREVC desta missão/i);
    expect(prompt).toMatch(/ACK manual não é exigido \(no_manual_ack_required\)/i);
    expect(prompt).toMatch(/done é rejeitado nesta topologia/i);
    expect(prompt).toMatch(/não faça polling esperando uma chamada proibida/i);
  });

  it('keeps the Maestro on watch/escalation duty instead of the ceremony', () => {
    const prompt = guidedPrompt();

    expect(prompt).toMatch(/Vigie handoffs e trate bloqueios e escalonamentos/i);
    expect(prompt).toMatch(/status=blocked exige a causa/i);
    expect(prompt).toMatch(/status=failed quando a execução começou/i);
    expect(prompt).toMatch(/Volte ao operador só para decisão de produto ambígua/i);
  });

  it('bars freeze/Doctor/prepare_execution once the contract is Main-frozen', () => {
    const prompt = guidedPrompt({ guidedPrevcFrozen: true });

    expect(prompt).toMatch(
      /NÃO chame freeze, refreeze, Doctor ou prepare_execution — o contrato já foi congelado pelo Main/i,
    );
  });

  it('keeps the ceremony lines for standard missions without guided PREVC', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-legacy',
      goal: 'Entregar a correção legada',
      acceptanceCriteria: ['Candidate validado'],
      risk: 'medium',
      maxWorkers: 2,
    });

    expect(prompt).toMatch(
      /A cada entrega: processe e chame nexus_handoff_ack com o handoffId exato/i,
    );
    expect(prompt).toMatch(/Feche com status=done somente após/i);
  });

  it('keeps ACKs and the ## Maestro consolidation mandatory for fan-out', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-fanout',
      goal: 'Teste de todos panes, cada um me fala o que faz na missão',
      acceptanceCriteria: [],
      risk: 'low',
      maxWorkers: 2,
      standardTopology: 'team-read-only-fanout',
    });

    expect(prompt).toContain('nexus_handoff_ack');
    expect(prompt).toMatch(/depois de TODOS os ACKs[\s\S]*## Maestro/i);
    expect(prompt).toMatch(/nexus_mission_set_status[\s\S]*status:"done"/i);
  });
});

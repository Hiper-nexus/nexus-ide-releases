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

  it('teaches Main-owned fast path for delivery without Guided PREVC', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-fast',
      goal: 'Entregar a feature vibe',
      acceptanceCriteria: ['Feature validada'],
      risk: 'normal',
      maxWorkers: 4,
      standardTopology: 'delivery',
      guidedPrevcRequired: false,
    });

    expect(prompt).toMatch(/Fast path: PREVC Guided não aplica/i);
    expect(prompt).not.toContain('nexus_handoff_ack');
    expect(prompt).not.toMatch(/Feche com status=done/i);
    expect(prompt).toMatch(/motor Nexus marca done sozinho/i);
    expect(prompt).toMatch(/ACK manual não é exigido \(no_manual_ack_required\)/i);
  });

  it('keeps Pack kickoff free of PREVC ceremony and serial story doctrine', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-pack',
      goal: 'Executar o plano promovido em ondas',
      acceptanceCriteria: ['Stories entregues'],
      risk: 'normal',
      maxWorkers: 6,
      standardTopology: 'wave-pack',
      guidedPrevcRequired: false,
    });

    expect(prompt).toMatch(/Wave Pack: PREVC Guided não aplica/i);
    expect(prompt).toMatch(/uma task por story/i);
    expect(prompt).not.toContain('nexus_handoff_ack');
    expect(prompt).not.toMatch(/Feche com status=done/i);
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

describe('escada de fontes de design no kickoff', () => {
  it('ensina as quatro fontes em ordem, com as duas sem chave nomeadas', () => {
    const prompt = guidedPrompt({ uiMissionObjective: true });

    expect(prompt).toMatch(
      /\(1\)[^\n]*DESIGN\.md[^\n]*\.context\/docs\/design-system\.md/i,
    );
    expect(prompt).toMatch(/\(2\)[^\n]*nexus_design_system_local_list/);
    expect(prompt).toMatch(/\(2\)[^\n]*source=local-catalog[^\n]*sem chave/i);
    expect(prompt).toMatch(/\(3\)[^\n]*source=getdesign[^\n]*sem chave/i);
    expect(prompt).toMatch(/\(4\)[^\n]*designmd\.ai[^\n]*external:designmd-api-key/);
  });

  it('mantém extract como tentativa única e não deixa o modelo cair no default', () => {
    const prompt = guidedPrompt({ uiMissionObjective: true });

    expect(prompt).toContain('nexus_design_system_local_import');
    expect(prompt).toMatch(/nexus_design_system_extract[^\n]*uma vez/i);
    expect(prompt).toMatch(/NETWORK_GUARD_UNAVAILABLE[^\n]*não/i);
    expect(prompt).toMatch(/nunca comece[^\n]*sem contrato|default do modelo/i);
    expect(prompt).toMatch(/impeccable/i);
  });

  it('não carrega a escada de design em objetivo que não toca UI', () => {
    const prompt = guidedPrompt();

    expect(prompt).not.toContain('nexus_design_system_local_list');
    expect(prompt).not.toContain('designmd.ai');
  });
});

describe('teto do kickoff standard', () => {
  it('fica abaixo de 2,4KB sem promoted plan e sem objetivo de UI', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-lean',
      goal: 'Corrigir o pipeline de cobrança',
      acceptanceCriteria: ['Cobrança fecha sem erro'],
      risk: 'medium',
      maxWorkers: 2,
    });

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(2_400);
  });

  it('substitui o JSON ilimitado de artifacts por um digest nomeado', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-promoted',
      goal: 'Executar o plano promovido',
      acceptanceCriteria: ['Plano executado'],
      risk: 'medium',
      maxWorkers: 2,
      promotedPlan: {
        handoffId: 'handoff-1',
        digest: 'd'.repeat(64),
        summary: '# PRD aprovado',
        summarySha256: 'a'.repeat(64),
        artifactsSha256: 'b'.repeat(64),
        artifacts: [
          { path: 'docs/stories/um.md' },
          { path: 'docs/stories/dois.md' },
        ],
      } as any,
    });

    expect(prompt).toContain('### Artifacts (2)');
    expect(prompt).toContain('docs/stories/um.md');
    expect(prompt).not.toContain('"docs/stories/um.md"');
  });

  it('mantém a base operacional do squad dentro de 2.048 caracteres', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad: {
        ...squad,
        orchestratorInstructions: 'x'.repeat(5_000),
      },
      missionId: 'mission-base',
      goal: 'Corrigir o pipeline de cobrança',
      acceptanceCriteria: ['Cobrança fecha sem erro'],
      risk: 'medium',
      maxWorkers: 2,
    });

    expect(prompt).toContain('(base operacional truncada em 2048 caracteres)');
    expect(prompt).not.toContain('x'.repeat(2_049));
  });
});

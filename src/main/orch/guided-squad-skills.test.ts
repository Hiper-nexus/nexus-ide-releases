import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import {
  applyGuidedSquadSkillPolicy,
  defaultGuidedSkillsForAgent,
  isGuidedUiMissionObjective,
  NEXUS_GUIDED_SKILL_ORDER,
  withGuidedSkillDefaults,
} from './guided-squad-skills';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { isToolAllowed } from './gate';

function policySquad(): Squad {
  return {
    id: 'guided-policy',
    name: 'Entrega de produto',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '# Entregar com evidências',
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        allowedSkills: ['model-injected-skill'],
        allowedTools: ['nexus_image_generate'],
      },
      {
        id: 'frontend',
        agentName: 'Executor Frontend',
        category: 'executor',
        cli: 'codex',
        allowedSkills: ['model-injected-skill'],
        allowedTools: ['nexus_git_push'],
      },
      {
        id: 'qa',
        agentName: 'QA de execução',
        category: 'reviewer',
        cli: 'codex',
      },
      {
        id: 'security-review',
        agentName: 'Revisor de segurança',
        category: 'reviewer',
        cli: 'kimi',
      },
      {
        id: 'architecture',
        agentName: 'Arquiteto',
        category: 'architect',
        cli: 'codex',
      },
      {
        id: 'research',
        agentName: 'Scout',
        category: 'scout',
        cli: 'kimi',
      },
    ],
  };
}

describe('guided squad deterministic skill policy', () => {
  it('derives exact role allowlists and discards model/renderer skill bytes', () => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective:
        'Implementar interface React com autenticação, dados de usuário e QA.',
      availableSkillNames: [
        ...NEXUS_GUIDED_SKILL_ORDER,
        'model-injected-skill',
        'unknown-installed-skill',
      ],
    });

    expect(squad.agents.map((agent) => [agent.id, agent.allowedSkills])).toEqual(
      [
        ['orch', ['ponytail', 'check-work', 'bridgesecurity', 'dembrandt']],
        [
          'frontend',
          ['ponytail', 'bridgesecurity', 'impeccable'],
        ],
        ['qa', ['check-work', 'bridgesecurity', 'impeccable']],
        [
          'security-review',
          ['check-work', 'bridgesecurity', 'impeccable'],
        ],
        [
          'architecture',
          [
            'ponytail',
            'check-work',
            'bridgesecurity',
            'archify',
            'bmad-templates',
          ],
        ],
        ['research', ['bridgesecurity', 'bridgeward']],
      ],
    );
    expect(
      squad.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toContain('model-injected-skill');
    expect(squad.agents.map((agent) => agent.allowedTools)).toEqual([
      null,
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('filters known policy grants against the installed/bundled inventory', () => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective: 'Implementar uma interface web',
      availableSkillNames: ['impeccable', 'dembrandt', 'not-a-nexus-skill'],
    });

    expect(squad.agents.find((agent) => agent.id === 'frontend')?.allowedSkills)
      .toEqual(['impeccable']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['impeccable']);
    expect(squad.agents.find((agent) => agent.id === 'orch')?.allowedSkills)
      .toEqual(['dembrandt']);
    expect(
      squad.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toContain('not-a-nexus-skill');
  });

  it('grants dembrandt only to the orchestrator on landing/reference missions', () => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective: 'Criar landing page inspirada em https://stripe.com',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(squad.agents.find((agent) => agent.id === 'orch')?.allowedSkills)
      .toEqual(['ponytail', 'check-work', 'dembrandt']);
    expect(squad.agents.find((agent) => agent.id === 'frontend')?.allowedSkills)
      .toEqual(['ponytail', 'impeccable']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['check-work', 'impeccable']);
  });

  it('does not treat bare desktop/electron/react goals as UI missions for dembrandt', () => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective: 'Rebuild electron packaging and fix mobile clients deploy',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });
    expect(
      squad.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toContain('dembrandt');
  });

  it('grants visual generation only to the requested handoff-capable visual owner, independent of CLI brand', () => {
    const source = policySquad();
    source.agents = [
      source.agents[0]!,
      {
        id: 'visual',
        agentName: 'Executor visual do pet',
        category: 'executor',
        cli: 'kimi',
      },
      {
        id: 'backend',
        agentName: 'Executor backend',
        category: 'executor',
        cli: 'codex',
      },
      {
        id: 'visual-grok',
        agentName: 'Fallback visual',
        category: 'executor',
        cli: 'grok',
      },
      {
        id: 'qa',
        agentName: 'QA de execução',
        category: 'reviewer',
        cli: 'codex',
      },
    ];

    const squad = applyGuidedSquadSkillPolicy(source, {
      objective:
        'Criar desktop pet v2, avatar e spritesheet animada com QA visual.',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(squad.agents.find((agent) => agent.id === 'visual')?.allowedSkills)
      .toEqual(['ponytail', 'impeccable', 'nexus-visual-media']);
    expect(squad.agents.find((agent) => agent.id === 'visual')?.allowedTools)
      .toEqual(['nexus_media_providers', 'nexus_image_generate']);
    expect(
      isToolAllowed(
        squad.agents.find((agent) => agent.id === 'visual')?.allowedTools ?? [],
        'nexus_image_generate',
      ),
    ).toBe(true);
    expect(squad.agents.find((agent) => agent.id === 'backend')?.allowedSkills)
      .toEqual(['ponytail']);
    expect(
      squad.agents.find((agent) => agent.id === 'visual-grok')?.allowedSkills,
    ).toEqual(['ponytail', 'impeccable']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['check-work']);
    expect(
      squad.agents.find((agent) => agent.id === 'orch')?.allowedSkills,
    ).not.toContain('dembrandt');
    expect(
      squad.agents
        .filter((agent) => !['orch', 'visual'].includes(agent.id))
        .every((agent) => agent.allowedTools?.length === 0),
    ).toBe(true);
    expect(
      isToolAllowed(
        squad.agents.find((agent) => agent.id === 'qa')?.allowedTools ?? null,
        'nexus_image_generate',
      ),
    ).toBe(false);
  });

  it('captures the exact roster grants in the immutable authority snapshot', () => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective:
        'Implementar interface React e gerar um avatar em spritesheet',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });
    const snapshot = snapshotSquadAuthority(squad);
    const changed = {
      ...squad,
      agents: squad.agents.map((agent) =>
        agent.id === 'frontend'
          ? { ...agent, allowedTools: ['nexus_media_providers'] }
          : agent,
      ),
    };

    expect(snapshot.agents.map((agent) => agent.allowedSkills)).toEqual(
      squad.agents.map((agent) => agent.allowedSkills),
    );
    expect(snapshot.agents.map((agent) => agent.allowedTools)).toEqual(
      squad.agents.map((agent) => agent.allowedTools),
    );
    expect(
      snapshot.agents.find((agent) => agent.id === 'frontend')?.allowedTools,
    ).toEqual(['nexus_media_providers', 'nexus_image_generate']);
    expect(Object.isFrozen(snapshot.agents)).toBe(true);
    expect(Object.isFrozen(snapshot.agents[0]?.allowedSkills)).toBe(true);
    expect(snapshotSquadAuthority(changed).hash).not.toBe(snapshot.hash);
  });
});

/**
 * Documentos de plano (PRD, arquitetura, épicos, stories) são escritos por
 * papéis explícitos do roster e pelo orquestrador de uma missão de lane plan —
 * nunca por adivinhação de id de squad. Estes testes fixam o contrato.
 */
describe('guided squad policy — vocabulário BMAD', () => {
  /** Espelho do roster builtin "Implementação por Stories". */
  function storySquad(): Squad {
    return {
      id: 'story-policy',
      name: 'Implementação por Stories',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '# Ciclo por story',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
          ownsPlanDocs: true,
        },
        {
          id: 'sm',
          agentName: 'SM',
          category: 'executor',
          cli: 'codex',
          ownsPlanDocs: true,
        },
        { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex' },
        {
          id: 'qa',
          agentName: 'QA',
          category: 'reviewer',
          cli: 'codex',
          ownsPlanDocs: true,
        },
      ],
    };
  }

  it('entrega bmad-templates ao orquestrador de uma missão de plano (PRD)', () => {
    const squad = applyGuidedSquadSkillPolicy(
      {
        ...storySquad(),
        agents: [
          {
            id: 'orch',
            agentName: 'Maestro',
            category: 'orchestrator',
            cli: 'claude',
          },
        ],
      },
      {
        objective:
          'Escrever o PRD e o plano de arquitetura do módulo de billing',
        availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
      },
    );

    expect(squad.agents[0]?.allowedSkills).toEqual([
      'ponytail',
      'check-work',
      'bmad-templates',
    ]);
  });

  it('não entrega archify na lane plan: só docs/plan.md é gravável ali', () => {
    const squad = applyGuidedSquadSkillPolicy(storySquad(), {
      objective: 'Planejar a migração do vault sem escrever código',
      lane: 'plan',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    const orch = squad.agents.find((agent) => agent.id === 'orch');
    expect(orch?.allowedSkills).toContain('bmad-templates');
    expect(orch?.allowedSkills).not.toContain('archify');
  });

  it('entrega o vocabulário BMAD a quem escreve/valida stories e a mais ninguém', () => {
    const squad = applyGuidedSquadSkillPolicy(storySquad(), {
      objective: 'Implementar as stories abertas do plano aprovado',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(squad.agents.map((agent) => [agent.id, agent.allowedSkills])).toEqual(
      [
        // Materializa docs/prd, docs/architecture, docs/stories + diagrama.
        ['orch', ['ponytail', 'check-work', 'archify', 'bmad-templates']],
        // Escreve o pacote da story pelo story-template.
        ['sm', ['ponytail', 'bmad-templates']],
        // Executor comum: a política continua restritiva.
        ['dev', ['ponytail']],
        // Percorre implementation/dev-story-checklist.md (Definition of Done).
        ['qa', ['check-work', 'bmad-templates']],
      ],
    );
  });

  it('mantém a lane plan inferida do objetivo quando o chamador não a informa', () => {
    const squad = applyGuidedSquadSkillPolicy(storySquad(), {
      objective: 'Escrever o PRD do novo onboarding',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(
      squad.agents.find((agent) => agent.id === 'orch')?.allowedSkills,
    ).not.toContain('archify');
  });

  it('deriva o piso determinístico de papel sem objetivo nem inventário', () => {
    expect(
      defaultGuidedSkillsForAgent({
        id: 'sm',
        agentName: 'SM',
        category: 'executor',
        cli: 'codex',
        ownsPlanDocs: true,
      }),
    ).toEqual(['ponytail', 'bmad-templates']);
    expect(
      defaultGuidedSkillsForAgent({
        id: 'dev',
        agentName: 'Dev',
        category: 'executor',
        cli: 'codex',
      }),
    ).toEqual(['ponytail']);
  });

  it('preenche só o buraco: allowedSkills explícito nunca é sobrescrito', () => {
    const filled = withGuidedSkillDefaults([
      { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex' },
      {
        id: 'reader',
        agentName: 'Reviewer read-only',
        category: 'reviewer',
        cli: 'codex',
        allowedSkills: [],
      },
      {
        id: 'pet',
        agentName: 'Pet Maker',
        category: 'orchestrator',
        cli: 'codex',
        allowedSkills: ['nexus-pet-studio'],
      },
    ]);

    expect(filled.map((agent) => agent.allowedSkills)).toEqual([
      ['ponytail'],
      [],
      ['nexus-pet-studio'],
    ]);
  });

  it('usa o roster main-owned como autoridade do preenchimento, não os bytes recebidos', () => {
    const filled = withGuidedSkillDefaults(
      [
        {
          id: 'sm',
          agentName: 'SM',
          category: 'executor',
          cli: 'codex',
          // Bytes forjados pedindo autoridade de documento.
          ownsPlanDocs: true,
        },
      ],
      [{ id: 'sm', agentName: 'SM', category: 'executor', cli: 'codex' }],
    );

    expect(filled[0]?.allowedSkills).toEqual(['ponytail']);
  });
});

/**
 * O vocabulário visual concede impeccable/dembrandt E liga o contrato de
 * revisão visual (build estático + screenshot). Precisão importa nos dois
 * sentidos: falso negativo deixa a missão visual sem ferramenta; falso
 * positivo exige artefato visual de missão que não é visual.
 */
describe('vocabulário de missão visual', () => {
  const VISUAL_OBJECTIVES = [
    'arrumar o visual do rail de missoes',
    'mexer no visual do app',
    'deixar a tela de missao mais bonita',
    'corrigir o alinhamento dos botoes',
    'trocar as cores do tema',
    'revisar a tipografia e o espaçamento do painel',
    'deixar o app responsivo no celular',
    'trocar o layout do rail lateral',
    'ajustar o CSS do composer',
    'melhorar a aparência da lista de tarefas',
    'redesenhar a UI do composer',
    'ajustar o dashboard',
    'melhorar o frontend da tela inicial',
    'Criar landing page inspirada em https://stripe.com',
  ];

  const NON_VISUAL_OBJECTIVES = [
    'documentar o esquema de cores do log',
    'corrigir o bug da tela de erro que trava o backend',
    'Rebuild electron packaging and fix mobile clients deploy',
    'migrar o banco de dados e revisar o design do schema',
    'investigar por que o cron de billing para de rodar',
    'implementar o tema do relatório mensal',
    'alinhar as expectativas do contrato com o time',
    // Missão de ASSET visual (nexus-visual-media), não de interface: não há
    // UI estática para o contrato de revisão visual exigir.
    'Criar desktop pet v2, avatar e spritesheet animada com QA visual',
  ];

  it.each(VISUAL_OBJECTIVES)('reconhece missão visual: %s', (objective) => {
    expect(isGuidedUiMissionObjective(objective)).toBe(true);
  });

  it.each(NON_VISUAL_OBJECTIVES)(
    'não dispara em prosa não-visual: %s',
    (objective) => {
      expect(isGuidedUiMissionObjective(objective)).toBe(false);
    },
  );

  it('concede impeccable/dembrandt no português natural do usuário', () => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective: 'deixar a tela de missao mais bonita',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(squad.agents.find((agent) => agent.id === 'orch')?.allowedSkills)
      .toEqual(['ponytail', 'check-work', 'dembrandt']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['check-work', 'impeccable']);
  });
});

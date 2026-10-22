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
  it.each(['standard', 'plan', 'consult'] as const)('routes reverse engineering roles to REA without adding tool authority (%s)', (lane) => {
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective: 'Faça engenharia reversa deste binário autorizado.',
      lane,
      availableSkillNames: ['rea'],
    });
    for (const agent of squad.agents) {
      expect(agent.allowedSkills).toContain('rea');
      expect(agent.allowedTools).toEqual(agent.category === 'orchestrator' ? null : []);
    }
  });

  it('does not add REA outside the eligible inventory or for a conceptual/negated goal', () => {
    for (const objective of ['O que é engenharia reversa?', 'Não faça engenharia reversa.', 'Create a React area']) {
      const squad = applyGuidedSquadSkillPolicy(policySquad(), { objective, availableSkillNames: ['rea'] });
      expect(squad.agents.flatMap((agent) => agent.allowedSkills ?? [])).not.toContain('rea');
    }
    const squad = applyGuidedSquadSkillPolicy(policySquad(), {
      objective: 'Decompile this binary.', availableSkillNames: ['bridgeward'],
    });
    expect(squad.agents.flatMap((agent) => agent.allowedSkills ?? [])).not.toContain('rea');
  });

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
        ['orch', ['ponytail', 'check-work', 'bridgesecurity', 'dembrandt', 'ui-kit']],
        [
          'frontend',
          ['ponytail', 'bridgesecurity', 'impeccable', 'ui-kit'],
        ],
        ['qa', ['check-work', 'bridgesecurity', 'impeccable', 'ui-kit']],
        [
          'security-review',
          ['check-work', 'bridgesecurity', 'impeccable', 'ui-kit'],
        ],
        [
          'architecture',
          [
            'ponytail',
            'check-work',
            'bridgesecurity',
            'archify',
            'superpowers',
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
      .toEqual(['ponytail', 'check-work', 'dembrandt', 'ui-kit']);
    expect(squad.agents.find((agent) => agent.id === 'frontend')?.allowedSkills)
      .toEqual(['ponytail', 'impeccable', 'ui-kit']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['check-work', 'impeccable', 'ui-kit']);
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

  it('records the visual generation grant only on the requested handoff-capable visual owner, independent of CLI brand, while the gate opens it to everyone', () => {
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
      .toEqual(['ponytail', 'impeccable', 'ui-kit', 'nexus-visual-media']);
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
    ).toEqual(['ponytail', 'impeccable', 'ui-kit']);
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
    // F-1157: a allowlist do roster continua gravada só no dono visual, mas o
    // gate não nega mais — o QA, com allowlist vazia, também alcança a geração.
    expect(
      isToolAllowed(
        squad.agents.find((agent) => agent.id === 'qa')?.allowedTools ?? null,
        'nexus_image_generate',
      ),
    ).toBe(true);
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
describe('guided squad policy — vocabulário Superpowers', () => {
  /** Espelho do roster builtin "Execução de Plano". */
  function planExecSquad(): Squad {
    return {
      id: 'plan-exec-policy',
      name: 'Execução de Plano',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '# Ciclo por task',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
          ownsPlanDocs: true,
        },
        { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex' },
        { id: 'dev-b', agentName: 'Dev B', category: 'executor', cli: 'codex' },
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

  it('entrega superpowers ao orquestrador de uma missão de plano (design)', () => {
    const squad = applyGuidedSquadSkillPolicy(
      {
        ...planExecSquad(),
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
          'Escrever o design e o plano de arquitetura do módulo de billing',
        availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
      },
    );

    expect(squad.agents[0]?.allowedSkills).toEqual([
      'ponytail',
      'check-work',
      // "design" no objetivo caracteriza missão de UI — dembrandt vem junto.
      'dembrandt',
      'superpowers',
    ]);
  });

  it('não entrega archify na lane plan: só docs/plan.md é gravável ali', () => {
    const squad = applyGuidedSquadSkillPolicy(planExecSquad(), {
      objective: 'Planejar a migração do vault sem escrever código',
      lane: 'plan',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    const orch = squad.agents.find((agent) => agent.id === 'orch');
    expect(orch?.allowedSkills).toContain('superpowers');
    expect(orch?.allowedSkills).not.toContain('archify');
  });

  it('entrega o vocabulário Superpowers a quem escreve/valida o plano e a mais ninguém', () => {
    const squad = applyGuidedSquadSkillPolicy(planExecSquad(), {
      objective: 'Implementar as tasks abertas do plano aprovado',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(squad.agents.map((agent) => [agent.id, agent.allowedSkills])).toEqual(
      [
        // Materializa docs/plan.md + diagrama.
        ['orch', ['ponytail', 'check-work', 'archify', 'superpowers']],
        // Executor comum: a política continua restritiva.
        ['dev', ['ponytail']],
        ['dev-b', ['ponytail']],
        // Review em dois estágios + verification-before-completion.
        ['qa', ['check-work', 'superpowers']],
      ],
    );
  });

  it('mantém a lane plan inferida do objetivo quando o chamador não a informa', () => {
    const squad = applyGuidedSquadSkillPolicy(planExecSquad(), {
      objective: 'Escrever o design do novo onboarding',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });

    expect(
      squad.agents.find((agent) => agent.id === 'orch')?.allowedSkills,
    ).not.toContain('archify');
  });

  it('deriva o piso determinístico de papel sem objetivo nem inventário', () => {
    expect(
      defaultGuidedSkillsForAgent({
        id: 'qa',
        agentName: 'QA',
        category: 'reviewer',
        cli: 'codex',
        ownsPlanDocs: true,
      }),
    ).toEqual(['check-work', 'superpowers']);
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
          id: 'qa',
          agentName: 'QA',
          category: 'reviewer',
          cli: 'codex',
          // Bytes forjados pedindo autoridade de documento.
          ownsPlanDocs: true,
        },
      ],
      [{ id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'codex' }],
    );

    expect(filled[0]?.allowedSkills).toEqual(['check-work']);
  });

  it('bmad-templates saiu do vocabulário padrão de grants', () => {
    const squad = applyGuidedSquadSkillPolicy(planExecSquad(), {
      objective: 'Escrever o design e o plano do módulo de billing',
      availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
    });
    const granted = squad.agents.flatMap((agent) => agent.allowedSkills ?? []);
    expect(granted).not.toContain('bmad-templates');
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
      .toEqual(['ponytail', 'check-work', 'dembrandt', 'ui-kit']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['check-work', 'impeccable', 'ui-kit']);
  });
});

describe('roster do Caminho Expresso (allowedSkills: []) sob a política de missão', () => {
  /**
   * Regressão 22/08: o roster montado pelo renderer no expresso declara
   * allowedSkills: [] — autoridade explícita que o piso (withGuidedSkill-
   * Defaults) nunca reescreve — e a missão nascia sem NENHUMA skill do motor.
   * O prepare agora aplica a política papel × objetivo × lane no main.
   */
  function expressRosterSquad(
    objective: string,
    executorRole: { id: string; agentName: string } = {
      id: 'implementar-interface',
      agentName: 'Implementar interface',
    },
  ): Squad {
    return {
      id: 'express-runtime',
      name: 'Equipe — teste',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: `# Missão\n${objective}`,
      agents: [
        {
          id: 'coordenar-e-revisar',
          agentName: 'Coordenar e revisar',
          category: 'orchestrator',
          cli: 'codex',
          allowedSkills: [],
          allowedTools: null,
        },
        {
          id: executorRole.id,
          agentName: executorRole.agentName,
          category: 'executor',
          cli: 'claude',
          allowedSkills: [],
          allowedTools: [],
        },
        {
          id: 'verificar-o-resultado',
          agentName: 'Verificar o resultado',
          category: 'reviewer',
          cli: 'glm',
          allowedSkills: [],
          allowedTools: [],
        },
      ],
    };
  }

  it('missão de UI pelo expresso nasce COM as skills do motor Nexus', () => {
    const squad = applyGuidedSquadSkillPolicy(
      expressRosterSquad('refaça a landing page do produto com visual premium'),
      {
        objective: 'refaça a landing page do produto com visual premium',
        availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
      },
    );

    expect(
      squad.agents.find((agent) => agent.id === 'coordenar-e-revisar')
        ?.allowedSkills,
    ).toContain('dembrandt');
    expect(
      squad.agents.find((agent) => agent.id === 'implementar-interface')
        ?.allowedSkills,
    ).toContain('impeccable');
    expect(
      squad.agents.find((agent) => agent.id === 'verificar-o-resultado')
        ?.allowedSkills,
    ).toContain('impeccable');
  });

  it('missão não-visual pelo expresso não ganha skill de design', () => {
    // Papel não-visual: o grant de design segue papel × objetivo, então um
    // executor de motor numa missão de sync não pode receber impeccable.
    const squad = applyGuidedSquadSkillPolicy(
      expressRosterSquad('corrija o deadlock no worker de sync', {
        id: 'implementar-motor',
        agentName: 'Implementar motor',
      }),
      {
        objective: 'corrija o deadlock no worker de sync',
        availableSkillNames: NEXUS_GUIDED_SKILL_ORDER,
      },
    );
    const granted = squad.agents.flatMap((agent) => agent.allowedSkills ?? []);
    expect(granted).not.toContain('dembrandt');
    expect(granted).not.toContain('impeccable');
    // Mas o piso de papel continua de pé.
    expect(
      squad.agents.find((agent) => agent.id === 'coordenar-e-revisar')
        ?.allowedSkills,
    ).toContain('ponytail');
  });
});

import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import {
  applyGuidedSquadSkillPolicy,
  NEXUS_GUIDED_SKILL_ORDER,
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
        ['orch', ['ponytail', 'check-work', 'bridgesecurity']],
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
      availableSkillNames: ['impeccable', 'not-a-nexus-skill'],
    });

    expect(squad.agents.find((agent) => agent.id === 'frontend')?.allowedSkills)
      .toEqual(['impeccable']);
    expect(squad.agents.find((agent) => agent.id === 'qa')?.allowedSkills)
      .toEqual(['impeccable']);
    expect(
      squad.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toContain('not-a-nexus-skill');
  });

  it('grants visual generation only to the requested Codex visual owner', () => {
    const source = policySquad();
    source.agents = [
      source.agents[0]!,
      {
        id: 'visual',
        agentName: 'Executor visual do pet',
        category: 'executor',
        cli: 'codex',
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
      .toEqual(['check-work', 'impeccable']);
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

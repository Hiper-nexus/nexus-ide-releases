import { describe, expect, it } from 'vitest';
import { countAgentCategories, lintSquadRecipes, parseGapRef } from './recipe-lint';
import type { Squad } from './orch-types';

function squad(overrides: Partial<Squad> = {}): Squad {
  return {
    id: 's1',
    name: 'Squad',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '',
    agents: [
      {
        id: 'a1',
        agentName: 'Worker',
        category: 'executor',
        cli: 'claude',
        allowedTools: ['nexus_pane_read'],
        allowedSkills: ['review'],
      },
    ],
    ...overrides,
  };
}

describe('recipe-lint', () => {
  it('aceita tools com ou sem prefixo nexus_', () => {
    const issues = lintSquadRecipes({
      squads: [squad()],
      catalog: { toolNames: ['nexus_pane_read'], skillNames: ['review'] },
    });
    expect(issues).toEqual([]);
  });

  it('rejeita referência inexistente sem gap explícito', () => {
    const issues = lintSquadRecipes({
      squads: [squad()],
      catalog: { toolNames: ['nexus_pane_write'], skillNames: [] },
    });
    expect(issues.map((i) => i.ref)).toEqual(['nexus_pane_read', 'review']);
  });

  it('aceita gap explícito com motivo', () => {
    const issues = lintSquadRecipes({
      squads: [
        squad({
          agents: [
            {
              id: 'a1',
              agentName: 'Worker',
              category: 'executor',
              cli: 'claude',
              allowedTools: ['gap:nexus_remote_bridge: aguardando bridge remoto'],
              allowedSkills: ['gap:visual-qa: instalar quando catálogo publicar'],
            },
          ],
        }),
      ],
      catalog: { toolNames: [], skillNames: [] },
    });
    expect(issues).toEqual([]);
  });

  it('aceita browser screenshot como tool nativa', () => {
    const issues = lintSquadRecipes({
      squads: [
        squad({
          agents: [
            {
              id: 'a1',
              agentName: 'Worker',
              category: 'executor',
              cli: 'claude',
              allowedTools: ['nexus_browser_screenshot'],
            },
          ],
        }),
      ],
      catalog: { toolNames: ['nexus_browser_screenshot'], skillNames: [] },
    });
    expect(issues).toEqual([]);
  });

  it('valida formato de gap', () => {
    expect(parseGapRef('gap:foo: motivo real')).toEqual({
      ref: 'foo',
      reason: 'motivo real',
    });
    const issues = lintSquadRecipes({
      squads: [
        squad({
          agents: [
            {
              id: 'a1',
              agentName: 'Worker',
              category: 'executor',
              cli: 'claude',
              allowedTools: ['gap:foo'],
            },
          ],
        }),
      ],
      catalog: { toolNames: [], skillNames: [] },
    });
    expect(issues[0].message).toContain('Gap inválido');
  });

  it('rejeita worker com tools irrestritas', () => {
    const issues = lintSquadRecipes({
      squads: [
        squad({
          agents: [
            {
              id: 'a1',
              agentName: 'Worker',
              category: 'executor',
              cli: 'claude',
              allowedTools: null,
            },
          ],
        }),
      ],
      catalog: { toolNames: [], skillNames: [] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      field: 'allowedTools',
      ref: '*',
      severity: 'error',
    });
  });

  it('conta categorias para o overlay', () => {
    expect(countAgentCategories([squad()])).toEqual({ executor: 1 });
  });
});

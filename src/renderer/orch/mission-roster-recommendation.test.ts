import { describe, expect, it } from 'vitest';
import { recommendMissionRosterRoles } from './mission-roster-customize';

describe('recommendMissionRosterRoles', () => {
  it('keeps the standard delivery roster and write scope explicit', () => {
    const roles = recommendMissionRosterRoles({
      objective: 'Implementar uma nova tela de missões',
      lane: 'standard',
    });

    expect(roles.map(({ id, category, allowedTools }) => ({
      id,
      category,
      allowedTools,
    }))).toEqual([
      {
        id: 'mission-coordinator',
        category: 'orchestrator',
        allowedTools: null,
      },
      {
        id: 'interface-executor',
        category: 'executor',
        allowedTools: ['Bash', 'Read', 'Edit'],
      },
      {
        id: 'engine-executor',
        category: 'executor',
        allowedTools: ['Bash', 'Read', 'Edit'],
      },
      {
        id: 'result-reviewer',
        category: 'reviewer',
        allowedTools: ['Bash', 'Read'],
      },
    ]);
  });

  it.each(['consult', 'plan'] as const)(
    'keeps every %s role mechanically free of write-capable grants',
    (lane) => {
      const roles = recommendMissionRosterRoles({
        objective: 'Analisar a arquitetura de autenticação e recomendar melhorias',
        lane,
      });

      expect(roles).toHaveLength(3);
      expect(roles.every((role) => role.allowedTools?.every((tool) => tool === 'Read')))
        .toBe(true);
      expect(roles.some((role) => role.category === 'executor')).toBe(false);
    },
  );

  it('recommends operational roles without presenting code implementers', () => {
    const roles = recommendMissionRosterRoles({
      objective: 'Fazer backup, configurar o DNS e publicar a aplicação',
      lane: 'ops',
    });

    expect(roles.map((role) => role.id)).toEqual([
      'mission-coordinator',
      'ops-operator',
      'ops-reviewer',
    ]);
    expect(roles.map((role) => role.agentName).join(' ')).not.toMatch(
      /implement|código|interface|motor/iu,
    );
    expect(roles.find((role) => role.id === 'ops-operator')).toMatchObject({
      category: 'executor',
      allowedTools: ['Bash', 'Read'],
    });
  });

  it('adjusts the visible scope from the objective without changing stable ids', () => {
    const bug = recommendMissionRosterRoles({
      objective: 'Corrigir o bug de login que encerra a sessão',
      lane: 'consult',
    });
    const visual = recommendMissionRosterRoles({
      objective: 'Auditar a interface do dashboard e sua acessibilidade',
      lane: 'consult',
    });

    expect(bug.map((role) => role.id)).toEqual(visual.map((role) => role.id));
    expect(bug.find((role) => role.id === 'consult-scout')?.agentName).toBe(
      'Investigar reprodução',
    );
    expect(visual.find((role) => role.id === 'consult-scout')?.agentName).toBe(
      'Auditar interface',
    );
  });
});

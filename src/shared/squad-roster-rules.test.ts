import { describe, expect, it } from 'vitest';
import type { SquadAgent } from './orch-types';
import {
  MISSION_ROSTER_MAX_AGENTS,
  squadRosterUsabilityIssue,
} from './squad-roster-rules';

function roster(
  coordinators: number,
  workers: number,
): Pick<SquadAgent, 'category'>[] {
  return [
    ...Array.from({ length: coordinators }, () => ({
      category: 'orchestrator' as const,
    })),
    ...Array.from({ length: workers }, () => ({
      category: 'executor' as const,
    })),
  ];
}

describe('F-1503: squadRosterUsabilityIssue', () => {
  it('aceita um coordenador sozinho e o teto exato de integrantes', () => {
    expect(squadRosterUsabilityIssue(roster(1, 0))).toBeNull();
    expect(
      squadRosterUsabilityIssue(roster(1, MISSION_ROSTER_MAX_AGENTS - 1)),
    ).toBeNull();
  });

  it.each([0, 2])('recusa %i coordenadores dizendo quantos há', (count) => {
    expect(squadRosterUsabilityIssue(roster(count, 2))).toBe(
      `precisa de exatamente um coordenador (categoria "orchestrator") e tem ${count}`,
    );
  });

  it('recusa acima de 12 integrantes dizendo quantos remover', () => {
    expect(squadRosterUsabilityIssue(roster(1, 14))).toBe(
      'tem 15 integrantes e uma missão aceita no máximo 12; remova 3',
    );
  });
});

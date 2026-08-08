import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import {
  snapshotSquadAuthority,
  squadAuthorityReviewStrings,
} from './squad-authority-snapshot';

const squad: Squad = {
  id: 'agentic-instructions',
  name: 'Equipe com contexto por papel',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordene sem ampliar autoridade.',
  agents: [
    {
      id: 'reviewer',
      agentName: 'Revisor',
      category: 'reviewer',
      cli: 'codex',
      instructions: 'Priorize autenticação e cite arquivo:linha.',
      allowedTools: ['Read'],
      allowedSkills: [],
    },
  ],
};

describe('snapshotSquadAuthority role instructions', () => {
  it('includes instructions in the immutable canonical snapshot and review text', () => {
    const snapshot = snapshotSquadAuthority(squad);

    expect(snapshot.agents[0]).toMatchObject({
      instructions: 'Priorize autenticação e cite arquivo:linha.',
      allowedTools: ['Read'],
    });
    expect(squadAuthorityReviewStrings(snapshot)).toContain(
      'Priorize autenticação e cite arquivo:linha.',
    );
    expect(Object.isFrozen(snapshot.agents[0])).toBe(true);
  });

  it('changes the authority hash when only role instructions change', () => {
    const changed: Squad = {
      ...squad,
      agents: squad.agents.map((agent) => ({
        ...agent,
        instructions: 'Priorize privacidade e cite arquivo:linha.',
      })),
    };

    expect(snapshotSquadAuthority(changed).hash).not.toBe(
      snapshotSquadAuthority(squad).hash,
    );
    expect(changed.agents[0]?.allowedTools).toEqual(['Read']);
  });
});

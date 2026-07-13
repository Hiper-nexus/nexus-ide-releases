import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import {
  normalizeSquadVoiceName,
  resolveSquadByVoiceName,
} from './squad-name-resolver';

const squad = (name: string, id = name.toLowerCase().replace(/\s+/g, '-')): Squad => ({
  id,
  name,
  createdAt: '2026-07-13T00:00:00.000Z',
  builtin: false,
  orchestratorInstructions: '',
  agents: [],
});

describe('squad voice resolver', () => {
  it('normalizes commands, accents, articles and punctuation', () => {
    expect(normalizeSquadVoiceName('Abra o modo Squad de Revisão Técnica'))
      .toBe('revisao tecnica');
  });

  it('resolves common Full Stack STT variants', () => {
    const squads = [squad('Full Stack'), squad('Code Review')];
    for (const spoken of ['ful stack', 'fullstack', 'full-stack']) {
      expect(resolveSquadByVoiceName(spoken, squads)).toMatchObject({
        kind: 'match',
        squad: expect.objectContaining({ name: 'Full Stack' }),
      });
    }
  });

  it('does not choose silently when the best match is ambiguous', () => {
    expect(resolveSquadByVoiceName('full stack', [
      squad('Full Stack', 'a'),
      squad('Full-Stack', 'b'),
    ])).toMatchObject({ kind: 'ambiguous' });
  });

  it('does not turn an unknown name into a match', () => {
    expect(resolveSquadByVoiceName('doctor', [squad('Full Stack')]))
      .toEqual({ kind: 'not-found' });
  });
});

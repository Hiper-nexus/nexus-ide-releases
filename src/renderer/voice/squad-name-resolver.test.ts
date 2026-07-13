import { describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import { normalizeSquadVoiceName, resolveSquadByVoiceName } from './squad-name-resolver';

const squad = (name: string, id = name.toLowerCase().replace(/\s+/g, '-')): Squad => ({
  id,
  name,
  createdAt: '2026-07-13T00:00:00.000Z',
  builtin: false,
  orchestratorInstructions: '',
  agents: [],
});

describe('squad voice resolver', () => {
  it('normaliza comando, acentos, artigos e pontuação', () => {
    expect(normalizeSquadVoiceName('Abra o modo Squad de Revisão Técnica')).toBe('revisao tecnica');
  });

  it('resolve variantes STT de Full Stack', () => {
    const squads = [squad('Full Stack'), squad('Code Review')];

    expect(resolveSquadByVoiceName('ful stack', squads)).toMatchObject({
      kind: 'match',
      squad: expect.objectContaining({ name: 'Full Stack' }),
    });
    expect(resolveSquadByVoiceName('fullstack', squads)).toMatchObject({
      kind: 'match',
      squad: expect.objectContaining({ name: 'Full Stack' }),
    });
    expect(resolveSquadByVoiceName('full-stack', squads)).toMatchObject({
      kind: 'match',
      squad: expect.objectContaining({ name: 'Full Stack' }),
    });
  });

  it('não escolhe silenciosamente quando há empate real', () => {
    const result = resolveSquadByVoiceName('full stack', [
      squad('Full Stack', 'a'),
      squad('Full-Stack', 'b'),
    ]);

    expect(result).toMatchObject({ kind: 'ambiguous' });
  });

  it('não transforma desconhecido em squad encontrado', () => {
    expect(resolveSquadByVoiceName('doctor', [squad('Full Stack')])).toEqual({
      kind: 'not-found',
    });
  });
});

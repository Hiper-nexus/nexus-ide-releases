import { describe, expect, it, vi } from 'vitest';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import {
  applySavedSquadMembers,
  orderSavedSquads,
  savedSquadsForMissionTeam,
} from './saved-squad-members';

const member: SquadAgent = {
  id: 'orch',
  agentName: 'Maestro',
  category: 'orchestrator',
  cli: 'codex',
  allowedSkills: [],
  allowedTools: null,
};

function squad(id: string, builtin: boolean, agents: SquadAgent[] = [member]): Squad {
  return { id, name: id, createdAt: '1', builtin, orchestratorInstructions: '', agents };
}

const RUNTIME_ID = 'agentic-runtime-0f8fad5b-d9cb-469f-a165-70867728950e';

describe('saved squad members (F-1578)', () => {
  it('ordena as do usuário antes das originais e tira as cópias seladas de missão', () => {
    const list = [squad('original', true), squad(RUNTIME_ID, false), squad('minha', false)];

    expect(orderSavedSquads(list).map((item) => item.id)).toEqual(['minha', 'original']);
  });

  it('a etapa Equipe também deixa o Pet Studio de fora', () => {
    const list = [PET_STUDIO_SQUAD, squad('minha', false)];

    expect(orderSavedSquads(list).map((item) => item.id)).toContain(PET_STUDIO_SQUAD.id);
    expect(savedSquadsForMissionTeam(list).map((item) => item.id)).toEqual(['minha']);
  });

  it('entrega os integrantes ao setRoster do rascunho e aceita retorno void', () => {
    const setRoster = vi.fn((_roster: readonly SquadAgent[]): void => undefined);
    const saved = squad('minha', false);

    expect(applySavedSquadMembers(saved, setRoster)).toEqual({ ok: true });
    expect(setRoster).toHaveBeenCalledWith(saved.agents);
  });

  it('explica a recusa pelo tamanho ou pelo dado inválido', () => {
    const big = squad(
      'grande',
      false,
      Array.from({ length: 13 }, (_, index) => ({ ...member, id: `a-${index}` })),
    );

    expect(applySavedSquadMembers(big, () => false)).toEqual({
      ok: false,
      message: expect.stringMatching(/tem 13 pessoas e a missão aceita até 12/),
    });
    expect(applySavedSquadMembers(squad('minha', false), () => false)).toEqual({
      ok: false,
      message: expect.stringMatching(/um deles tem um dado que a missão não aceita/),
    });
  });
});

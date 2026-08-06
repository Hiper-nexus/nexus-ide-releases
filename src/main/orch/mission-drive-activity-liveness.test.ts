import { describe, expect, it } from 'vitest';
import {
  defaultDriveConfig,
  decideDriveAction,
  deriveDriveState,
} from './mission-drive';

/**
 * Falso positivo do detector de stall — voo real HiperGO 06/08.
 *
 * Às 10:00:59 foi gravado um handoff `stalled` ("missão sem progresso há
 * 10 min") enquanto o worker emitia observer.tool_call em quase todos os
 * minutos (last: 60s antes). A causa: `deriveDriveState` media vivacidade
 * SOMENTE por `mission.updatedAt` e criação de handoffs. Uma unidade legítima
 * de 26 minutos não produz handoff nenhum e não toca a linha da missão — logo
 * "silêncio" — mesmo com o processo trabalhando o tempo todo.
 *
 * Detector que grita lobo é pior que nenhum: envenena o registro da missão com
 * um estado falso, e toda política que lê `stalled` passa a agir sobre mentira.
 */
const T0 = 1_700_000_000_000;
const MIN = 60_000;

function mission(updatedAt: number) {
  return {
    id: 'm1',
    status: 'running' as const,
    updatedAt,
    createdAt: T0,
    milestones: [],
  };
}

describe('vivacidade = ATIVIDADE, não silêncio num canal só', () => {
  it('tool call recente do worker conta como progresso (mata o falso positivo)', () => {
    const now = T0 + 11 * MIN;
    const state = deriveDriveState({
      mission: mission(T0), // linha da missão parada há 11min
      handoffs: [],
      // ...mas o worker chamou ferramenta 60s atrás
      lastWorkerActivityAt: now - MIN,
    });

    expect(state.lastProgressAt).toBe(now - MIN);
    const action = decideDriveAction(state, now, defaultDriveConfig);
    expect(action.kind).not.toBe('signal-stall');
  });

  it('sem atividade real o stall ainda dispara (o detector segue útil)', () => {
    const now = T0 + 11 * MIN;
    const state = deriveDriveState({
      mission: mission(T0),
      handoffs: [],
      lastWorkerActivityAt: T0, // mudo desde o começo
    });

    const action = decideDriveAction(state, now, defaultDriveConfig);
    expect(action.kind).toBe('signal-stall');
  });

  it('atividade ausente (não instrumentada) não fabrica vivacidade', () => {
    const now = T0 + 11 * MIN;
    const state = deriveDriveState({ mission: mission(T0), handoffs: [] });

    expect(state.lastProgressAt).toBe(T0);
    expect(decideDriveAction(state, now, defaultDriveConfig).kind).toBe(
      'signal-stall',
    );
  });

  it('marca o stall como RESOLVIDO quando a atividade volta', () => {
    // O registro não pode ficar com um `stalled` obsoleto para sempre: quem
    // ler depois precisa saber que aquilo se resolveu.
    const stalledAt = T0 + 10 * MIN;
    const state = deriveDriveState({
      mission: mission(T0),
      handoffs: [
        {
          status: 'stalled' as const,
          createdAt: stalledAt,
          evidenceTrust: 'unverified' as const,
          evidenceIds: [] as string[],
        },
      ],
      lastWorkerActivityAt: stalledAt + 2 * MIN,
    });

    expect(state.lastStallSignalAt).toBe(stalledAt);
    expect(state.stallResolved).toBe(true);
  });

  it('stall ainda vigente não é dado como resolvido', () => {
    const stalledAt = T0 + 10 * MIN;
    const state = deriveDriveState({
      mission: mission(T0),
      handoffs: [
        {
          status: 'stalled' as const,
          createdAt: stalledAt,
          evidenceTrust: 'unverified' as const,
          evidenceIds: [] as string[],
        },
      ],
      lastWorkerActivityAt: T0,
    });

    expect(state.stallResolved).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { expandFirstWaveSeats } from './via-rapida-first-wave';
import {
  missionPaneCompositionIdentity,
  sameMissionPaneComposition,
} from './mission-pane-identity';
import type { SquadAgent } from '../../shared/orch-types';

const motor = {
  id: 'motor',
  agentName: 'Implementar motor',
  category: 'executor',
  cli: 'codex',
  model: 'gpt-5.6-terra',
} as SquadAgent;

const base = {
  adapterId: 'codex',
  model: 'gpt-5.6-terra',
  cwd: '/Users/me/projeto',
  role: 'worker' as const,
};

describe('missionPaneCompositionIdentity — clone-collapse 068', () => {
  it('mesmo title em 7 clones Codex colapsa em 1 identidade', () => {
    const keys = Array.from({ length: 7 }, () =>
      missionPaneCompositionIdentity({
        ...base,
        title: 'Implementar motor',
      }),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('paneTitle único por assento first-wave não colapsa', () => {
    const seats = expandFirstWaveSeats([motor], 7);
    const keys = seats.map((seat) =>
      missionPaneCompositionIdentity({
        ...base,
        title: seat.title,
      }),
    );
    expect(seats.map((seat) => seat.title)).toEqual([
      'Implementar motor',
      'Implementar motor · 2',
      'Implementar motor · 3',
      'Implementar motor · 4',
      'Implementar motor · 5',
      'Implementar motor · 6',
      'Implementar motor · 7',
    ]);
    expect(new Set(keys).size).toBe(7);
    expect(
      sameMissionPaneComposition(
        { ...base, title: 'Implementar motor' },
        { ...base, title: 'Implementar motor · 2' },
      ),
    ).toBe(false);
  });
});

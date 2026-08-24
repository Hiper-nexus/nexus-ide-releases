import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { selectMissionTerminalPanes } from './mission-terminal-panes';

const maestro: PaneModel = {
  id: 'pane-a',
  kind: 'cli-agent',
  title: 'Maestro',
  missionId: 'mission-nova',
};
const worker: PaneModel = {
  id: 'pane-b',
  kind: 'cli-agent',
  title: 'Worker',
};
const other: PaneModel = {
  id: 'pane-c',
  kind: 'cli-agent',
  title: 'Outra',
  missionId: 'mission-velha',
};
const shell: PaneModel = { id: 'pane-shell', kind: 'shell', title: 'shell' };

describe('selectMissionTerminalPanes', () => {
  it('sem missão mostra o layout inteiro', () => {
    expect(
      selectMissionTerminalPanes([maestro, other, shell], undefined, {}),
    ).toEqual([maestro, other, shell]);
  });

  it('Terminais da missão esconde panes de outra missão e shell solto', () => {
    expect(
      selectMissionTerminalPanes([maestro, worker, other, shell], 'mission-nova', {
        'pane-b': 'mission-nova',
      }).map((pane) => pane.id),
    ).toEqual(['pane-a', 'pane-b']);
  });
});

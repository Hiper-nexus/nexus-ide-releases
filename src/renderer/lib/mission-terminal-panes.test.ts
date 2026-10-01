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

  it('shell morto com missionId não ocupa o grid da missão', () => {
    const dead: PaneModel = {
      id: 'pane-dead',
      kind: 'shell',
      title: 'shell',
      missionId: 'mission-nova',
    };
    expect(
      selectMissionTerminalPanes(
        [maestro, dead, other],
        'mission-nova',
        {},
      ).map((pane) => pane.id),
    ).toEqual(['pane-a']);
  });
});

describe('F-231 — pane solto carimbado na aba da missão', () => {
  const looseHome: PaneModel = {
    id: 'pane-loose',
    kind: 'cli-agent',
    title: 'Solto',
    homeScopeKey: 'mission:mission-nova',
  };

  it('pane com homeScopeKey da missão aparece no grid dela sem ser participante', () => {
    expect(
      selectMissionTerminalPanes([maestro, looseHome, other, shell], 'mission-nova', {})
        .map((pane) => pane.id),
    ).toEqual(['pane-a', 'pane-loose']);
    // Ele continua sem missionId — fora do ledger e do Quadro.
    expect(looseHome.missionId).toBeUndefined();
  });

  it('homeScopeKey de OUTRA missão não invade o grid', () => {
    const foreign: PaneModel = {
      ...looseHome,
      id: 'pane-foreign',
      homeScopeKey: 'mission:mission-velha',
    };
    expect(
      selectMissionTerminalPanes([maestro, foreign], 'mission-nova', {})
        .map((pane) => pane.id),
    ).toEqual(['pane-a']);
  });
});

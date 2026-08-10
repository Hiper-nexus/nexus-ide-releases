import { beforeEach, describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from './split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useMissionInspectorStore } from '../state/mission-inspector-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { routeMissionAttention } from './mission-attention-route';

const livePane: PaneModel = {
  id: 'pane-live',
  kind: 'cli-agent',
  title: 'Worker',
  adapterId: 'codex',
  missionId: 'mission-next',
};

const boundOnlyPane: PaneModel = {
  id: 'pane-bound-only',
  kind: 'cli-agent',
  title: 'Bound worker',
  adapterId: 'codex',
};

beforeEach(() => {
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
  useMissionInspectorStore.setState({
    missionId: 'mission-old',
    tab: 'result',
    selectedAgentId: null,
  });
  useOrchStore.setState({ paneMissions: {} });
  useLayoutStore.setState({
    root: buildGridTree([
      { id: 'shell-old', kind: 'shell', title: 'Terminal' },
      livePane,
    ]),
    focusedPaneId: 'shell-old',
    maximizedPaneId: null,
    hydrated: true,
    viewKind: 'grid',
  });
});

describe('shared cause-aware mission attention route', () => {
  it.each([
    ['human-question', 'chat'],
    ['human-input', 'chat'],
    ['technical-failure', 'activity'],
    ['technical-recovery', 'activity'],
    ['rail-selection', 'activity'],
    ['completed', 'result'],
  ] as const)('routes %s to the named Board inspector %s tab', (cause, tab) => {
    routeMissionAttention({ missionId: 'mission-next', cause });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-next',
      surface: 'board',
    });
    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-next',
      tab,
    });
  });

  it('selects Mission Terminals only for a notification explicitly targeting a live pane', () => {
    routeMissionAttention({
      missionId: 'mission-next',
      cause: 'human-input',
      notificationPaneId: livePane.id,
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-next',
      surface: 'terminals',
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe(livePane.id);
  });

  it('accepts a live pane whose mission ownership exists only in paneMissions', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'shell-old', kind: 'shell', title: 'Terminal' },
        boundOnlyPane,
      ]),
      focusedPaneId: 'shell-old',
    });
    useOrchStore.setState({
      paneMissions: { [boundOnlyPane.id]: 'mission-next' },
    });

    routeMissionAttention({
      missionId: 'mission-next',
      cause: 'completed',
      notificationPaneId: boundOnlyPane.id,
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-next',
      surface: 'terminals',
    });
    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-next',
      tab: 'result',
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe(boundOnlyPane.id);
  });

  it('keeps the cause route when the live target pane is truly unbound', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'shell-old', kind: 'shell', title: 'Terminal' },
        boundOnlyPane,
      ]),
      focusedPaneId: 'shell-old',
    });

    routeMissionAttention({
      missionId: 'mission-next',
      cause: 'human-input',
      notificationPaneId: boundOnlyPane.id,
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-next',
      surface: 'board',
    });
    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-next',
      tab: 'chat',
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe('shell-old');
  });

  it('does not select Terminals when a notification target is stale', () => {
    routeMissionAttention({
      missionId: 'mission-next',
      cause: 'human-input',
      notificationPaneId: 'pane-gone',
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-next',
      surface: 'board',
    });
    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-next',
      tab: 'chat',
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe('shell-old');
  });
});

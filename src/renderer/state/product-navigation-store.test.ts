/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyMissionSetupDraft,
  useMissionSetupStore,
} from './mission-setup-store';
import { useProductNavigationStore } from './product-navigation-store';

describe('product navigation', () => {
  beforeEach(() => {
    useProductNavigationStore.setState({
      destination: { kind: 'launcher' },
      settingsReturnDestination: null,
    });
    useMissionSetupStore.setState({
      workspacePath: '/projects/alpha',
      draft: {
        ...createEmptyMissionSetupDraft(),
        objective: 'Rascunho da equipe anterior',
        step: 'team',
        revision: 4,
      },
      persistence: { status: 'saved' },
      workspaceDrafts: {},
      entryContext: null,
    });
  });

  it('keeps one discriminated destination instead of parallel visibility flags', () => {
    const store = useProductNavigationStore.getState();

    store.openTerminal();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });

    store.openTaskBoard();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'task-board',
    });

    const state = useProductNavigationStore.getState();
    const dataKeys = Object.entries(state)
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key);
    expect(dataKeys).toEqual([
      'destination',
      'settingsReturnDestination',
    ]);
    for (const forbidden of [
      'panelOpen',
      'boardOpen',
      'drawerOpen',
      'home',
      'visible',
    ]) {
      expect(state).not.toHaveProperty(forbidden);
    }
  });

  it('opens the project overview destination', () => {
    useProductNavigationStore.getState().openProject();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'project',
    });
  });

  it('returns to the launcher when the workspace closes', () => {
    const store = useProductNavigationStore.getState();
    store.openMission('mission-17');

    store.closeWorkspace();

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'launcher',
    });
  });

  it('opens a mission on its board', () => {
    useProductNavigationStore.getState().openMission('mission-17');

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-17',
      surface: 'board',
    });
  });

  it('preserves the exact mission id between board and terminal surfaces', () => {
    const store = useProductNavigationStore.getState();
    store.openMission('mission-with-session');
    store.showMissionTerminals();

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-with-session',
      surface: 'terminals',
    });

    store.showMissionBoard();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-with-session',
      surface: 'board',
    });
  });

  it('returns from settings to the exact previous non-settings destination', () => {
    const store = useProductNavigationStore.getState();
    store.openMission('mission-with-session');
    store.showMissionTerminals();
    store.openSettings('appearance');

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'appearance',
    });

    store.backFromSettings();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-with-session',
      surface: 'terminals',
    });
  });

  it('keeps the original return destination across settings deep links', () => {
    const store = useProductNavigationStore.getState();
    store.openMemory();
    store.openSettings('account');
    store.openSettings('terminal');
    store.openSettings('shortcuts');

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'shortcuts',
    });

    store.backFromSettings();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'memory',
    });
    expect(
      useProductNavigationStore.getState().settingsReturnDestination,
    ).toBeNull();
  });

  it('openNewMission starts on Missão instead of restoring Equipe', () => {
    useProductNavigationStore.getState().openNewMission();

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      objective: '',
      step: 'mission',
      roster: [],
    });
  });

  it('openNewMission discards a workspace draft that was already on Equipe', () => {
    const stale = {
      ...createEmptyMissionSetupDraft(8),
      objective: 'Rascunho da equipe anterior',
      step: 'team' as const,
      roster: [
        {
          id: 'coord',
          agentName: 'Coordenar',
          category: 'orchestrator' as const,
          cli: 'claude',
        },
      ],
    };
    useMissionSetupStore.setState({
      workspacePath: '/projects/alpha',
      draft: stale,
      persistence: { status: 'saved' },
      workspaceDrafts: {
        '/projects/alpha': { draft: stale, persistence: { status: 'saved' } },
      },
      entryContext: null,
    });

    useProductNavigationStore.getState().openNewMission();

    expect(useMissionSetupStore.getState().draft).toMatchObject({
      objective: '',
      step: 'mission',
      roster: [],
    });
    expect(useMissionSetupStore.getState().entryContext).toBeNull();
  });

  it('openMissionSetup keeps a prefilled objective for handoff callers', () => {
    useMissionSetupStore.getState().setObjective('Corrigir o login');
    useProductNavigationStore.getState().openMissionSetup();

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Corrigir o login',
    );
  });
});

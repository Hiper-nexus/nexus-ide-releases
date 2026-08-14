import { create } from 'zustand';
import type { SettingsSection } from '../components/settings/settings-nav';
import { useMissionSetupStore } from './mission-setup-store';

export type ProductDestination =
  | { kind: 'launcher' }
  | { kind: 'terminal' }
  | { kind: 'project' }
  | { kind: 'mission-setup' }
  | {
      kind: 'mission';
      missionId: string;
      surface: 'board' | 'terminals';
    }
  | { kind: 'task-board' }
  | { kind: 'memory' }
  | { kind: 'settings'; section?: SettingsSection };

export type NonSettingsProductDestination = Exclude<
  ProductDestination,
  { kind: 'settings' }
>;

export interface ProductNavigationState {
  destination: ProductDestination;
  settingsReturnDestination: NonSettingsProductDestination | null;
}

export interface ProductNavigationActions {
  openLauncher(): void;
  openTerminal(): void;
  openProject(): void;
  openMissionSetup(): void;
  openNewMission(): void;
  openMission(missionId: string): void;
  showMissionBoard(): void;
  showMissionTerminals(): void;
  openTaskBoard(): void;
  openMemory(): void;
  openSettings(section?: SettingsSection): void;
  backFromSettings(): void;
  openPetReviewFromSettings(): void;
  returnToSettingsSection(section: 'appearance'): void;
  closeWorkspace(): void;
}

export type ProductNavigationStore = ProductNavigationState &
  ProductNavigationActions;

const launcherDestination: NonSettingsProductDestination = {
  kind: 'launcher',
};

export const useProductNavigationStore = create<ProductNavigationStore>()(
  (set) => {
    const open = (destination: NonSettingsProductDestination): void => {
      useMissionSetupStore.getState().clearEntryContext();
      set({ destination, settingsReturnDestination: null });
    };

    const showMissionSurface = (surface: 'board' | 'terminals'): void => {
      useMissionSetupStore.getState().clearEntryContext();
      set((state) =>
        state.destination.kind === 'mission'
          ? {
              destination: { ...state.destination, surface },
              settingsReturnDestination: null,
            }
          : {},
      );
    };

    return {
      destination: launcherDestination,
      settingsReturnDestination: null,

      openLauncher: () => open(launcherDestination),
      openTerminal: () => open({ kind: 'terminal' }),
      openProject: () => open({ kind: 'project' }),
      openMissionSetup: () => {
        open({ kind: 'mission-setup' });
      },
      openNewMission: () => {
        useMissionSetupStore.getState().beginFreshMission();
        // + Novo precisa do rascunho limpo de beginFreshMission. open() chama
        // clearEntryContext(); com entryContext de pet-studio isso reidrata o
        // draft do workspace (muitas vezes ainda em Equipe).
        set({ destination: { kind: 'mission-setup' }, settingsReturnDestination: null });
      },
      openMission: (missionId) =>
        open({ kind: 'mission', missionId, surface: 'board' }),
      showMissionBoard: () => showMissionSurface('board'),
      showMissionTerminals: () => showMissionSurface('terminals'),
      openTaskBoard: () => open({ kind: 'task-board' }),
      openMemory: () => open({ kind: 'memory' }),
      openPetReviewFromSettings: () => {
        set((state) => ({
          destination: { kind: 'mission-setup' },
          settingsReturnDestination: state.settingsReturnDestination,
        }));
      },
      returnToSettingsSection: (section) => {
        useMissionSetupStore.getState().clearEntryContext();
        set((state) => ({
          destination: { kind: 'settings', section },
          settingsReturnDestination: state.settingsReturnDestination,
        }));
      },
      openSettings: (section) => {
        useMissionSetupStore.getState().clearEntryContext();
        set((state) => ({
          destination:
            section === undefined
              ? { kind: 'settings' }
              : { kind: 'settings', section },
          settingsReturnDestination:
            state.destination.kind === 'settings'
              ? state.settingsReturnDestination
              : state.destination,
        }));
      },
      backFromSettings: () => {
        useMissionSetupStore.getState().clearEntryContext();
        set((state) => {
          if (state.destination.kind !== 'settings') return {};
          return {
            destination:
              state.settingsReturnDestination ?? launcherDestination,
            settingsReturnDestination: null,
          };
        });
      },
      closeWorkspace: () => open(launcherDestination),
    };
  },
);

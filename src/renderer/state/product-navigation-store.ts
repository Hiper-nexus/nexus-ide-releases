import { create } from 'zustand';
import type { SettingsSection } from '../components/settings/settings-nav';

export type ProductDestination =
  | { kind: 'launcher' }
  | { kind: 'terminal' }
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
  openMissionSetup(): void;
  openMission(missionId: string): void;
  showMissionBoard(): void;
  showMissionTerminals(): void;
  openTaskBoard(): void;
  openMemory(): void;
  openSettings(section?: SettingsSection): void;
  backFromSettings(): void;
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
      set({ destination, settingsReturnDestination: null });
    };

    const showMissionSurface = (surface: 'board' | 'terminals'): void => {
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
      openMissionSetup: () => open({ kind: 'mission-setup' }),
      openMission: (missionId) =>
        open({ kind: 'mission', missionId, surface: 'board' }),
      showMissionBoard: () => showMissionSurface('board'),
      showMissionTerminals: () => showMissionSurface('terminals'),
      openTaskBoard: () => open({ kind: 'task-board' }),
      openMemory: () => open({ kind: 'memory' }),
      openSettings: (section) => {
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

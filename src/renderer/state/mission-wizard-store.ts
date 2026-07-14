import { create } from 'zustand';

/**
 * Open/close state for the workspace/mission wizard.
 *  - 'workspace': full "Novo workspace" flow starting at the PASTA step
 *    (launched from the launch screen).
 *  - 'mission': "Nova Missão" inside the current workspace, starting at MODO
 *    (launched from ＋ Missão or automatically when entering a folder).
 */

export type WizardVariant = 'workspace' | 'mission';
export type MissionWizardStep =
  | 'new-ws'
  | 'mode'
  | 'libre-count'
  | 'libre-slots'
  | 'squad-select'
  | 'agentic-intent'
  | 'squad-review'
  /** Intent-first: squad armed, waiting for an explicit goal. */
  | 'intent-compose'
  /** Intent-first: short plan ready for user start/approval. */
  | 'intent-plan';

interface MissionWizardStore {
  open: boolean;
  variant: WizardVariant;
  /** When set, the wizard opens straight on this squad's review step. */
  presetSquadId: string | null;
  /** Intent-first: pre-armed mission shell waiting for a goal. */
  armedMissionId: string | null;
  /** Objective supplied by a voice request for Modo Agêntico. */
  agenticIntent: string | null;
  /**
   * Bumped for each direct voice launch so an already-open wizard also
   * switches back to Modo Agêntico instead of retaining its previous step.
   */
  agenticLaunchNonce: number;
  /** Bumped whenever voice requests the saved-squad selection screen. */
  squadPickerNonce: number;
  /** Exact wizard step currently rendered, published to Jarvis live context. */
  visibleStep: MissionWizardStep | null;
  /**
   * Voice / Live "wizard-fire": bump to ask MissionWizard to launch the
   * squad currently on the review step (Overclock navegar wizard-fire).
   */
  voiceLaunchNonce: number;
  openForNewWorkspace(): void;
  openForMission(): void;
  /** Open Nova Missão already on Modo Agêntico, optionally with its objective. */
  openForAgentic(intent?: string): void;
  /** Open Nova Missão directly on the existing saved-squad list. */
  openSquadPicker(): void;
  /** Open directly on a squad's review (used by the Home deck shortcuts). */
  openForSquad(squadId: string): void;
  /**
   * Intent-first: open on goal compose for an already-armed mission shell
   * (no agent pane, zero tokens spent).
   */
  openForArmedMission(squadId: string, missionId: string): void;
  /** Request launch of the open squad-review (confirm_squad / voice "sim"). */
  requestVoiceLaunch(): void;
  setVisibleStep(step: MissionWizardStep): void;
  close(): void;
}

export const useMissionWizardStore = create<MissionWizardStore>((set) => ({
  open: false,
  variant: 'mission',
  presetSquadId: null,
  armedMissionId: null,
  agenticIntent: null,
  agenticLaunchNonce: 0,
  squadPickerNonce: 0,
  visibleStep: null,
  voiceLaunchNonce: 0,
  openForNewWorkspace: () =>
    set({
      open: true,
      variant: 'workspace',
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: null,
      voiceLaunchNonce: 0,
      visibleStep: 'new-ws',
    }),
  openForMission: () =>
    set({
      open: true,
      variant: 'mission',
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: null,
      voiceLaunchNonce: 0,
      visibleStep: 'mode',
    }),
  openForAgentic: (intent) =>
    set((state) => ({
      open: true,
      variant: 'mission',
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: intent?.trim() || null,
      agenticLaunchNonce: state.agenticLaunchNonce + 1,
      voiceLaunchNonce: 0,
      visibleStep: 'agentic-intent',
    })),
  openSquadPicker: () =>
    set((state) => ({
      open: true,
      variant: 'mission',
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: null,
      squadPickerNonce: state.squadPickerNonce + 1,
      voiceLaunchNonce: 0,
    })),
  openForSquad: (squadId) =>
    set({
      open: true,
      variant: 'mission',
      presetSquadId: squadId,
      armedMissionId: null,
      agenticIntent: null,
      voiceLaunchNonce: 0,
      visibleStep: 'squad-review',
    }),
  openForArmedMission: (squadId, missionId) =>
    set({
      open: true,
      variant: 'mission',
      presetSquadId: squadId,
      armedMissionId: missionId,
      agenticIntent: null,
      voiceLaunchNonce: 0,
      visibleStep: 'intent-compose',
    }),
  requestVoiceLaunch: () =>
    set((s) => ({ voiceLaunchNonce: s.voiceLaunchNonce + 1 })),
  setVisibleStep: (visibleStep) => set({ visibleStep }),
  close: () =>
    set({
      open: false,
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: null,
      voiceLaunchNonce: 0,
      visibleStep: null,
    }),
}));

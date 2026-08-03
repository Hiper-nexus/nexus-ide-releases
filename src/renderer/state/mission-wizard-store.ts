import { create } from 'zustand';
import type { MissionIntentSource } from '../../shared/mission-intent';
import type { MissionAttachment } from '../lib/mission-attachments';

/**
 * Open/close state for the workspace/mission wizard.
 *  - 'workspace': full "Novo workspace" flow starting at the PASTA step
 *    (launched from the launch screen).
 *  - 'mission': "Nova Missão" inside the current workspace, starting at MODO
 *    (launched from ＋ Missão or automatically when entering a folder).
 *
 * Draft persistence: accidental close (overlay / Escape / clicar na Jarvis
 * sob o overlay) must NOT wipe the objective the user was typing. Only an
 * explicit Cancelar or a successful launch discards the draft.
 */

export type WizardVariant = 'workspace' | 'mission';
export type WizardMode = 'libre' | 'squad' | 'agentic';
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

export interface MissionWizardDraft {
  variant: WizardVariant;
  step: MissionWizardStep;
  mode: WizardMode | null;
  intent: string;
  missionGoal: string;
  missionLane: 'standard' | 'consult' | 'plan' | 'ops';
  squadId: string;
  armedMissionId: string | null;
  count: number;
  slots: string[];
  wsPath: string;
  missionAttachments: MissionAttachment[];
}

export type MissionWizardCloseOptions = {
  /** true = user cancelled or launch finished; wipe draft. Default keeps draft. */
  discard?: boolean;
};

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
   * Provenance of the agentic objective (issue import, voice, typed). Flows
   * into the intent contract's `source` so a missão nascida de uma issue é
   * auditável como 'imported-issue', não como texto digitado.
   */
  agenticSource: MissionIntentSource;
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
   * squad currently on the review step (wizard-fire wizard-fire).
   */
  voiceLaunchNonce: number;
  /**
   * Last in-progress form. Survives soft close so reopening restores the
   * objective the user was typing (anti-loss vs overlay / Jarvis click).
   */
  draft: MissionWizardDraft | null;
  openForNewWorkspace(): void;
  openForMission(): void;
  /** Open Nova Missão already on Modo Agêntico, optionally with its objective. */
  openForAgentic(intent?: string, source?: MissionIntentSource): void;
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
  saveDraft(draft: MissionWizardDraft): void;
  clearDraft(): void;
  close(options?: MissionWizardCloseOptions): void;
}

const closedFields = {
  open: false as const,
  presetSquadId: null as string | null,
  voiceLaunchNonce: 0,
  visibleStep: null as MissionWizardStep | null,
};

export const useMissionWizardStore = create<MissionWizardStore>((set) => ({
  open: false,
  variant: 'mission',
  presetSquadId: null,
  armedMissionId: null,
  agenticIntent: null,
  agenticSource: 'typed',
  agenticLaunchNonce: 0,
  squadPickerNonce: 0,
  visibleStep: null,
  voiceLaunchNonce: 0,
  draft: null,
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
    set((state) => ({
      open: true,
      variant: 'mission',
      presetSquadId: null,
      // Resume only a shell bound to the saved draft. A bare store id is stale
      // authority and must not capture the next voice objective.
      armedMissionId:
        state.draft?.variant === 'mission' ? state.draft.armedMissionId : null,
      agenticIntent: null,
      voiceLaunchNonce: 0,
      visibleStep: 'mode',
    })),
  openForAgentic: (intent, source) =>
    set((state) => {
      const spoken = intent?.trim() || null;
      // Voice may open agentic without a spoken objective — never wipe a draft
      // the user already typed in the composer.
      const preserved = spoken ?? (state.draft?.intent?.trim() || null);
      const nextDraft: MissionWizardDraft | null = spoken
        ? {
            variant: 'mission',
            step: 'agentic-intent',
            mode: 'agentic',
            intent: spoken,
            missionGoal: state.draft?.missionGoal ?? '',
            missionLane: state.draft?.missionLane ?? 'standard',
            squadId: '',
            armedMissionId: null,
            count: state.draft?.count ?? 2,
            slots: state.draft?.slots ?? [],
            wsPath: state.draft?.wsPath ?? '',
            missionAttachments: state.draft?.missionAttachments ?? [],
          }
        : state.draft && state.draft.variant === 'mission'
          ? {
              ...state.draft,
              step: 'agentic-intent',
              mode: 'agentic',
            }
          : state.draft;
      return {
        open: true,
        variant: 'mission',
        presetSquadId: null,
        armedMissionId: null,
        agenticIntent: preserved,
        agenticSource: source ?? (spoken ? 'voice' : state.agenticSource),
        agenticLaunchNonce: state.agenticLaunchNonce + 1,
        voiceLaunchNonce: 0,
        visibleStep: 'agentic-intent',
        draft: nextDraft,
      };
    }),
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
  saveDraft: (draft) =>
    set((state) => {
      const existing = state.draft;
      // Don't clobber a dirty mission objective with a sparse workspace shell
      // when the user opens "Novo workspace" while a mission draft is parked.
      if (
        existing &&
        existing.variant !== draft.variant &&
        isMissionWizardDraftDirty(existing) &&
        !isMissionWizardDraftDirty(draft)
      ) {
        return state;
      }
      return { draft };
    }),
  clearDraft: () => set({ draft: null }),
  close: (options) =>
    set((state) => ({
      ...closedFields,
      // Soft-close keeps the draft (and agentic seed) so a mis-click on Jarvis
      // / overlay does not nuke the objective mid-type.
      draft: options?.discard ? null : state.draft,
      armedMissionId: options?.discard ? null : state.armedMissionId,
      agenticIntent: options?.discard ? null : state.agenticIntent,
      agenticSource: options?.discard ? 'typed' : state.agenticSource,
    })),
}));

/** True when the draft has user-authored content worth restoring. */
export function isMissionWizardDraftDirty(
  draft: MissionWizardDraft | null | undefined,
): boolean {
  if (!draft) return false;
  // Mode alone (user only tapped a card) is not enough — require authored
  // content or a step past the empty mode/pasta shell.
  if (
    draft.intent.trim().length > 0 ||
    draft.missionGoal.trim().length > 0 ||
    draft.missionAttachments.length > 0 ||
    draft.wsPath.trim().length > 0 ||
    draft.squadId.trim().length > 0 ||
    draft.armedMissionId != null
  ) {
    return true;
  }
  return (
    draft.step !== 'mode' &&
    draft.step !== 'new-ws' &&
    draft.step !== 'agentic-intent'
  );
}

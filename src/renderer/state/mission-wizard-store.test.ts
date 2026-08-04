import { beforeEach, describe, expect, it } from 'vitest';
import {
  isMissionWizardDraftDirty,
  useMissionWizardStore,
  type MissionWizardDraft,
} from './mission-wizard-store';

const emptyDraft = (): MissionWizardDraft => ({
  variant: 'mission',
  step: 'mode',
  mode: null,
  intent: '',
  missionGoal: '',
  missionLane: 'standard',
  squadId: '',
  armedMissionId: null,
  count: 2,
  slots: [],
  wsPath: '',
  missionAttachments: [],
});

describe('mission-wizard-store voice launches', () => {
  beforeEach(() => {
    useMissionWizardStore.setState({
      open: false,
      variant: 'mission',
      presetSquadId: null,
      armedMissionId: null,
      voiceLaunchNonce: 0,
      agenticIntent: null,
      agenticSource: 'typed',
      agenticLaunchNonce: 0,
      squadPickerNonce: 0,
      visibleStep: null,
      draft: null,
    });
  });

  it('opens an armed mission on the goal composer without launching agents', () => {
    useMissionWizardStore
      .getState()
      .openForArmedMission('navalha', 'mission-armed-1');

    expect(useMissionWizardStore.getState()).toMatchObject({
      open: true,
      presetSquadId: 'navalha',
      armedMissionId: 'mission-armed-1',
      visibleStep: 'intent-compose',
    });
  });

  it('opens a mission directly in agentic mode and preserves the spoken objective', () => {
    useMissionWizardStore
      .getState()
      .openForAgentic('investigar os atrasos de resposta da Jarvis');

    expect(useMissionWizardStore.getState()).toMatchObject({
      open: true,
      variant: 'mission',
      presetSquadId: null,
      agenticIntent: 'investigar os atrasos de resposta da Jarvis',
      agenticLaunchNonce: 1,
    });
  });

  it('signals a new agentic selection even when the wizard is already open', () => {
    const store = useMissionWizardStore.getState();
    store.openForAgentic();
    store.openForAgentic('auditar a aplicação');

    expect(useMissionWizardStore.getState()).toMatchObject({
      open: true,
      agenticIntent: 'auditar a aplicação',
      agenticLaunchNonce: 2,
    });
  });

  it('keeps agentic launch signals monotonic across other wizard modes', () => {
    const store = useMissionWizardStore.getState();
    store.openForAgentic('primeira missão');
    store.close({ discard: true });
    store.openForMission();
    store.openForAgentic('segunda missão');

    expect(useMissionWizardStore.getState()).toMatchObject({
      agenticIntent: 'segunda missão',
      agenticLaunchNonce: 2,
      visibleStep: 'agentic-intent',
    });
  });

  it('requests the existing-squad picker repeatedly without faking rendered state', () => {
    const store = useMissionWizardStore.getState();
    store.openForMission();
    store.openSquadPicker();
    store.openSquadPicker();

    expect(useMissionWizardStore.getState()).toMatchObject({
      open: true,
      variant: 'mission',
      presetSquadId: null,
      agenticIntent: null,
      squadPickerNonce: 2,
      visibleStep: 'mode',
    });
  });

  it('opens the mode picker even when an old agentic draft has authored text', () => {
    useMissionWizardStore.setState({
      draft: {
        ...emptyDraft(),
        step: 'agentic-intent',
        mode: 'agentic',
        intent: 'objetivo que deve continuar preservado',
      },
    });

    useMissionWizardStore.getState().openForMission();

    expect(useMissionWizardStore.getState()).toMatchObject({
      open: true,
      visibleStep: 'mode',
      draft: {
        step: 'mode',
        mode: null,
        intent: 'objetivo que deve continuar preservado',
      },
    });
  });

  it('tracks the exact wizard step visible to Jarvis', () => {
    const store = useMissionWizardStore.getState();
    store.openForMission();
    store.setVisibleStep('mode');
    expect(useMissionWizardStore.getState().visibleStep).toBe('mode');

    store.setVisibleStep('squad-select');
    expect(useMissionWizardStore.getState().visibleStep).toBe('squad-select');

    store.close({ discard: true });
    expect(useMissionWizardStore.getState().visibleStep).toBeNull();
  });
});

describe('mission-wizard-store draft persistence', () => {
  beforeEach(() => {
    useMissionWizardStore.setState({
      open: false,
      variant: 'mission',
      presetSquadId: null,
      armedMissionId: null,
      voiceLaunchNonce: 0,
      agenticIntent: null,
      agenticSource: 'typed',
      agenticLaunchNonce: 0,
      squadPickerNonce: 0,
      visibleStep: null,
      draft: null,
    });
  });

  it('soft close keeps the draft so reopening can restore the typed objective', () => {
    const store = useMissionWizardStore.getState();
    store.openForAgentic();
    store.saveDraft({
      ...emptyDraft(),
      step: 'agentic-intent',
      mode: 'agentic',
      intent: 'landing page premium do site X com dark mode',
    });

    store.close(); // soft — overlay / Escape / mis-click Jarvis

    expect(useMissionWizardStore.getState().open).toBe(false);
    expect(useMissionWizardStore.getState().draft?.intent).toBe(
      'landing page premium do site X com dark mode',
    );
  });

  it('discard close wipes the draft (Cancelar / launch ok)', () => {
    const store = useMissionWizardStore.getState();
    store.openForAgentic();
    store.saveDraft({
      ...emptyDraft(),
      step: 'agentic-intent',
      mode: 'agentic',
      intent: 'não quero perder',
    });

    store.close({ discard: true });

    expect(useMissionWizardStore.getState().open).toBe(false);
    expect(useMissionWizardStore.getState().draft).toBeNull();
  });

  it('clears an orphaned armed shell but resumes one owned by the draft', () => {
    useMissionWizardStore.setState({
      armedMissionId: 'mission-orphaned',
      draft: null,
    });

    useMissionWizardStore.getState().openForMission();
    expect(useMissionWizardStore.getState().armedMissionId).toBeNull();

    useMissionWizardStore.setState({
      armedMissionId: 'mission-owned',
      draft: {
        ...emptyDraft(),
        step: 'intent-compose',
        mode: 'squad',
        armedMissionId: 'mission-owned',
        missionGoal: 'corrigir o login',
      },
    });

    useMissionWizardStore.getState().openForMission();
    expect(useMissionWizardStore.getState().armedMissionId).toBe('mission-owned');
  });

  it('openForAgentic without spoken intent keeps the draft objective', () => {
    const store = useMissionWizardStore.getState();
    store.saveDraft({
      ...emptyDraft(),
      step: 'agentic-intent',
      mode: 'agentic',
      intent: 'rascunho que o usuário já digitou',
    });

    store.openForAgentic(); // voice "modo agêntico" with no text

    expect(useMissionWizardStore.getState().agenticIntent).toBe(
      'rascunho que o usuário já digitou',
    );
    expect(useMissionWizardStore.getState().draft?.intent).toBe(
      'rascunho que o usuário já digitou',
    );
  });

  it('openForAgentic with spoken intent overwrites the draft objective', () => {
    const store = useMissionWizardStore.getState();
    store.saveDraft({
      ...emptyDraft(),
      step: 'agentic-intent',
      mode: 'agentic',
      intent: 'rascunho antigo',
    });

    store.openForAgentic('objetivo falado pela Jarvis', 'voice');

    expect(useMissionWizardStore.getState().agenticIntent).toBe(
      'objetivo falado pela Jarvis',
    );
    expect(useMissionWizardStore.getState().draft?.intent).toBe(
      'objetivo falado pela Jarvis',
    );
  });

  it('isMissionWizardDraftDirty detects authored content, not empty mode shells', () => {
    expect(isMissionWizardDraftDirty(null)).toBe(false);
    expect(isMissionWizardDraftDirty(emptyDraft())).toBe(false);
    expect(
      isMissionWizardDraftDirty({
        ...emptyDraft(),
        intent: '  algo  ',
      }),
    ).toBe(true);
    // Empty agentic step alone is not worth restoring (no typed objective).
    expect(
      isMissionWizardDraftDirty({
        ...emptyDraft(),
        step: 'agentic-intent',
        mode: 'agentic',
      }),
    ).toBe(false);
    expect(
      isMissionWizardDraftDirty({
        ...emptyDraft(),
        step: 'squad-select',
        mode: 'squad',
      }),
    ).toBe(true);
  });

  it('saveDraft does not clobber a dirty mission draft with a sparse workspace shell', () => {
    const store = useMissionWizardStore.getState();
    store.saveDraft({
      ...emptyDraft(),
      variant: 'mission',
      step: 'agentic-intent',
      mode: 'agentic',
      intent: 'não apagar',
    });
    store.saveDraft({
      ...emptyDraft(),
      variant: 'workspace',
      step: 'new-ws',
    });
    expect(useMissionWizardStore.getState().draft?.intent).toBe('não apagar');
    expect(useMissionWizardStore.getState().draft?.variant).toBe('mission');
  });
});

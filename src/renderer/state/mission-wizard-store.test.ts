import { beforeEach, describe, expect, it } from 'vitest';
import { useMissionWizardStore } from './mission-wizard-store';

describe('mission-wizard-store voice launches', () => {
  beforeEach(() => {
    useMissionWizardStore.setState({
      open: false,
      variant: 'mission',
      presetSquadId: null,
      armedMissionId: null,
      voiceLaunchNonce: 0,
      agenticIntent: null,
      agenticLaunchNonce: 0,
      squadPickerNonce: 0,
      visibleStep: null,
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
    store.close();
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

  it('tracks the exact wizard step visible to Jarvis', () => {
    const store = useMissionWizardStore.getState();
    store.openForMission();
    store.setVisibleStep('mode');
    expect(useMissionWizardStore.getState().visibleStep).toBe('mode');

    store.setVisibleStep('squad-select');
    expect(useMissionWizardStore.getState().visibleStep).toBe('squad-select');

    store.close();
    expect(useMissionWizardStore.getState().visibleStep).toBeNull();
  });
});

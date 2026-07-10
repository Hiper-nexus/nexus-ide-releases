import { beforeEach, describe, expect, it } from 'vitest';
import { useMissionWizardStore } from './mission-wizard-store';

describe('mission-wizard-store voice launches', () => {
  beforeEach(() => {
    useMissionWizardStore.setState({
      open: false,
      variant: 'mission',
      presetSquadId: null,
      voiceLaunchNonce: 0,
      agenticIntent: null,
      agenticLaunchNonce: 0,
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
});

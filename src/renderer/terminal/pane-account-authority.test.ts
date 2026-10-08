import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { shouldAutoPinPaneAccount } from './pane-account-authority';

function cliPane(overrides: Partial<PaneModel> = {}): PaneModel {
  return {
    id: 'pane-agent',
    kind: 'cli-agent',
    title: 'Agent',
    adapterId: 'codex',
    ...overrides,
  };
}

describe('pane account authority', () => {
  it('allows account discovery only for an unowned manual pane', () => {
    expect(shouldAutoPinPaneAccount(cliPane(), undefined)).toBe(true);
  });

  it('keeps an undefined account sealed for mission-owned spawns', () => {
    expect(
      shouldAutoPinPaneAccount(cliPane({ missionId: 'mission-a' }), 'mission-a'),
    ).toBe(false);
  });

  it('keeps an undefined account sealed for orchestration request spawns', () => {
    expect(
      shouldAutoPinPaneAccount(
        cliPane({ orchRequestId: 'orchspawn-a' }),
        undefined,
      ),
    ).toBe(false);
  });

  it('F-969: pane Claude do "+ Pane" não é fixado na ativa pelo renderer — o Main escolhe pela regra de folga', () => {
    expect(shouldAutoPinPaneAccount(cliPane({ adapterId: 'claude' }), undefined)).toBe(false);
    // A conta que o Main escolheu e o renderer persistiu continua valendo.
    expect(
      shouldAutoPinPaneAccount(cliPane({ adapterId: 'claude', accountId: 'acct-re' }), undefined),
    ).toBe(false);
    expect(shouldAutoPinPaneAccount(cliPane({ adapterId: 'codex' }), undefined)).toBe(true);
  });
});

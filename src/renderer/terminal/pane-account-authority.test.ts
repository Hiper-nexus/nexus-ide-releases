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
});

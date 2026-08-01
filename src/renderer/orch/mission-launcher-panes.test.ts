import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { panesAfterSquadLaunch } from './mission-launcher';

const pane = (
  id: string,
  kind: PaneModel['kind'],
  patch: Partial<PaneModel> = {},
): PaneModel => ({
  id,
  kind,
  title: id,
  ...patch,
});

describe('panesAfterSquadLaunch', () => {
  const orchestrator = pane('orchestrator', 'cli-agent');

  it('replaces the fresh structural placeholder shell with the orchestrator', () => {
    expect(
      panesAfterSquadLaunch(
        [pane('shell', 'shell', { isStructuralPlaceholder: true })],
        new Set(),
        orchestrator,
      ),
    )
      .toEqual([orchestrator]);
  });

  it('preserves user-created shell-only layouts and appends the orchestrator', () => {
    const existing = [pane('shell-a', 'shell'), pane('shell-b', 'shell')];
    expect(panesAfterSquadLaunch(existing, new Set(), orchestrator))
      .toEqual([...existing, orchestrator]);
  });

  it('preserves an existing mission layout and appends the orchestrator', () => {
    const existing = [pane('agent', 'cli-agent'), pane('terminal', 'shell')];
    expect(panesAfterSquadLaunch(existing, new Set(), orchestrator))
      .toEqual([...existing, orchestrator]);
  });
});

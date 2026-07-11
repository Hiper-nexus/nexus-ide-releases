import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { panesAfterSquadLaunch } from './mission-launcher';

const pane = (id: string, kind: PaneModel['kind']): PaneModel => ({
  id,
  kind,
  title: id,
});

describe('panesAfterSquadLaunch', () => {
  const orchestrator = pane('orchestrator', 'cli-agent');

  it('replaces the fresh placeholder shell with the orchestrator', () => {
    expect(panesAfterSquadLaunch([pane('shell', 'shell')], new Set(), orchestrator))
      .toEqual([orchestrator]);
  });

  it('preserves an existing mission layout and appends the orchestrator', () => {
    const existing = [pane('agent', 'cli-agent'), pane('terminal', 'shell')];
    expect(panesAfterSquadLaunch(existing, new Set(), orchestrator))
      .toEqual([...existing, orchestrator]);
  });
});

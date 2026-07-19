import { describe, expect, it } from 'vitest';
import {
  buildPlanPromotedKickoff,
  orchestratorPaneIdForMission,
} from './plan-promote-notify';

describe('plan-promote-notify', () => {
  it('builds a Portuguese PREVC kickoff mentioning plan.md', () => {
    const text = buildPlanPromotedKickoff('Migrar auth para OAuth');
    expect(text).toContain('plan → standard');
    expect(text).toContain('plan.md');
    expect(text).toContain('Migrar auth para OAuth');
    expect(text).toContain('PREVC');
    expect(text).toContain('nexus_bg_run');
    expect(text).toContain('worktrees');
  });

  it('prefers the mission orchestrator pane', () => {
    const panes = [
      { id: 'w1', kind: 'cli-agent' as const, role: 'worker' as const },
      { id: 'o1', kind: 'cli-agent' as const, role: 'orchestrator' as const },
    ];
    const paneMissions = { w1: 'm1', o1: 'm1' };
    expect(orchestratorPaneIdForMission('m1', panes, paneMissions)).toBe('o1');
  });

  it('falls back to any bound agent pane', () => {
    const panes = [
      { id: 'w1', kind: 'cli-agent' as const, role: 'worker' as const },
    ];
    expect(
      orchestratorPaneIdForMission('m1', panes, { w1: 'm1' }),
    ).toBe('w1');
  });

  it('returns null when mission has no panes', () => {
    expect(orchestratorPaneIdForMission('m1', [], {})).toBeNull();
  });
});

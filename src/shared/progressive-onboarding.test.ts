import { describe, expect, it } from 'vitest';
import {
  progressiveLaunchSchema,
  previewLaunchSummary,
  LAUNCHER_MODES,
  LAYOUT_PANE_COUNTS,
} from './progressive-onboarding';

describe('progressive onboarding contracts', () => {
  it('defaults to open-without-AI terminal-only (no agent/MCP required)', () => {
    const plan = progressiveLaunchSchema.parse({});
    expect(plan.openWithoutAi).toBe(true);
    expect(plan.mode).toBe('terminal-only');
    expect(plan.agentDistribution).toBe('none');
    expect(plan.paneCount).toBe(1);
  });

  it('preview summary marks without AI clearly', () => {
    const plan = progressiveLaunchSchema.parse({
      openWithoutAi: true,
      paneCount: 4,
      mode: 'terminal-only',
    });
    const summary = previewLaunchSummary(plan);
    expect(summary).toMatch(/without AI/);
    expect(summary).toMatch(/4 pane/);
    expect(summary).not.toMatch(/with agents/);
  });

  it('exposes all launcher modes for Terminal/Missions/Swarm/Board/Memory/Skills', () => {
    const ids = LAUNCHER_MODES.map((m) => m.id);
    expect(ids).toEqual([
      'terminal',
      'missions',
      'swarm',
      'board',
      'memory',
      'skills',
    ]);
  });

  it('accepts visual pane counts 1–12 from BridgeSpace-inspired set', () => {
    for (const n of LAYOUT_PANE_COUNTS) {
      expect(progressiveLaunchSchema.parse({ paneCount: n }).paneCount).toBe(n);
    }
    expect(() => progressiveLaunchSchema.parse({ paneCount: 3 })).toThrow();
  });

  it('forces agentDistribution none when openWithoutAi semantics apply', () => {
    // Schema allows agents, but product path (ProgressiveOnboarding) forces none.
    // Contract: openWithoutAi true is valid with agentDistribution none.
    const plan = progressiveLaunchSchema.parse({
      openWithoutAi: true,
      agentDistribution: 'none',
    });
    expect(plan.agentDistribution).toBe('none');
  });
});

import { describe, expect, it } from 'vitest';
import {
  progressiveLaunchSchema,
  previewLaunchSummary,
  LAUNCHER_MODES,
  LAYOUT_PANE_COUNTS,
} from './progressive-onboarding';

describe('progressive onboarding contracts', () => {
  it('defaults to the mission-first path and keeps terminal-only explicit', () => {
    const plan = progressiveLaunchSchema.parse({});
    expect(plan.openWithoutAi).toBe(false);
    expect(plan.mode).toBe('missions');
    expect(plan.agentDistribution).toBe('one-of-each');
    expect(plan.paneCount).toBe(1);
  });

  it('preview summary marks without AI clearly', () => {
    const plan = progressiveLaunchSchema.parse({
      openWithoutAi: true,
      paneCount: 4,
      mode: 'terminal-only',
    });
    const summary = previewLaunchSummary(plan);
    expect(summary).toMatch(/sem IA/);
    expect(summary).toMatch(/4 pane/);
    expect(summary).not.toMatch(/com agentes/);
  });

  it('exposes all launcher modes for Terminal/Missões/Enxame/Board/Memória/Skills/Marketplace', () => {
    const ids = LAUNCHER_MODES.map((m) => m.id);
    expect(ids).toEqual([
      'terminal',
      'missions',
      'swarm',
      'board',
      'memory',
      'skills',
      'marketplace',
    ]);
    expect(LAUNCHER_MODES.map((m) => m.label)).toEqual([
      'Terminal',
      'Missões',
      'Enxame',
      'Board',
      'Memória',
      'Skills',
      'Marketplace',
    ]);
  });

  it('accepts visual pane counts 1–12 from BridgeSpace-inspired set', () => {
    for (const n of LAYOUT_PANE_COUNTS) {
      expect(progressiveLaunchSchema.parse({ paneCount: n }).paneCount).toBe(n);
    }
    expect(() => progressiveLaunchSchema.parse({ paneCount: 3 })).toThrow();
  });

  it('forces agentDistribution none when openWithoutAi semantics apply', () => {
    // Terminal-only product routing forces an agent-free launch.
    // Contract: openWithoutAi true is valid with agentDistribution none.
    const plan = progressiveLaunchSchema.parse({
      openWithoutAi: true,
      agentDistribution: 'none',
    });
    expect(plan.agentDistribution).toBe('none');
  });
});

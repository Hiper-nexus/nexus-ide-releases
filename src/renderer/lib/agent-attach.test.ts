import { describe, expect, it } from 'vitest';
import {
  annotationsToAgentPrompt,
  resolveReviewTargetPaneId,
} from './agent-attach';

describe('annotationsToAgentPrompt', () => {
  it('formats annotations for the agent', () => {
    const text = annotationsToAgentPrompt([
      { path: 'src/a.ts', line: 10, body: 'fix null check' },
      { path: 'src/b.ts', line: 2, body: 'rename' },
    ]);
    expect(text).toContain('src/a.ts:10');
    expect(text).toContain('fix null check');
    expect(text).toContain('src/b.ts:2');
    expect(text).toMatch(/revisão humana/i);
  });

  it('returns empty for no annotations', () => {
    expect(annotationsToAgentPrompt([])).toBe('');
  });
});

describe('resolveReviewTargetPaneId', () => {
  const orch = { id: 'p-orch', kind: 'cli-agent', role: 'orchestrator' } as const;
  const orchB = { id: 'p-orch-b', kind: 'cli-agent', role: 'orchestrator' } as const;
  const worker = { id: 'p-worker', kind: 'cli-agent', role: 'worker' } as const;
  const shell = { id: 'p-shell', kind: 'shell' } as const;

  it('routes the review to the mission orchestrator, not the focused worker', () => {
    expect(
      resolveReviewTargetPaneId({
        panes: [shell, worker, orch],
        focusedPaneId: 'p-worker',
        paneMissions: { 'p-orch': 'm1', 'p-worker': 'm1' },
      }),
    ).toBe('p-orch');
  });

  it('prefers the orchestrator of the focused pane mission in multi-mission grids', () => {
    expect(
      resolveReviewTargetPaneId({
        panes: [orch, orchB, worker],
        focusedPaneId: 'p-worker',
        paneMissions: { 'p-orch': 'm1', 'p-orch-b': 'm2', 'p-worker': 'm2' },
      }),
    ).toBe('p-orch-b');
  });

  it('ignores orchestrator panes without a mission binding', () => {
    expect(
      resolveReviewTargetPaneId({
        panes: [orch, worker],
        focusedPaneId: 'p-worker',
        paneMissions: {},
      }),
    ).toBe('p-worker');
  });

  it('falls back to the focused/first cli-agent pane in solo layouts', () => {
    expect(
      resolveReviewTargetPaneId({
        panes: [shell, worker],
        focusedPaneId: 'p-shell',
        paneMissions: {},
      }),
    ).toBe('p-worker');
    expect(
      resolveReviewTargetPaneId({
        panes: [shell],
        focusedPaneId: null,
        paneMissions: {},
      }),
    ).toBeNull();
  });

  it('does not select an exited orchestrator when live state is available', () => {
    expect(
      resolveReviewTargetPaneId({
        panes: [orch, worker],
        focusedPaneId: 'p-worker',
        paneMissions: { 'p-orch': 'm1', 'p-worker': 'm1' },
        isPaneLive: (paneId) => paneId === 'p-worker',
      }),
    ).toBe('p-worker');
  });
});

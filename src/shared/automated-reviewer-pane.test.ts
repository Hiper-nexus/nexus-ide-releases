import { describe, expect, it } from 'vitest';
import { isAutomatedReviewerPaneIdentity } from './automated-reviewer-pane';

const exactReviewer = {
  missionId: 'mission-a',
  adapterId: 'claude',
  title: 'review-mission-a-1-a1b2c3d4e5f6',
  agentName: 'reviewer-claude-1-a1b2c3d4e5f6',
  role: 'worker' as const,
};

describe('automated reviewer pane identity', () => {
  it('recognizes only the exact internal PREVC identity', () => {
    expect(isAutomatedReviewerPaneIdentity(exactReviewer)).toBe(true);
  });

  it.each([
    { ...exactReviewer, role: 'orchestrator' as const },
    { ...exactReviewer, title: 'QA sênior' },
    { ...exactReviewer, title: 'review-mission-a-0-a1b2c3d4e5f6' },
    { ...exactReviewer, title: 'review-mission-a-1-reviewcrash1' },
    { ...exactReviewer, title: 'review-mission-a-1-a1b2c3d4e5f' },
    { ...exactReviewer, agentName: 'reviewer-claude-2-a1b2c3d4e5f6' },
    { ...exactReviewer, adapterId: 'codex' },
    { ...exactReviewer, missionId: undefined },
  ])('rejects normal panes and near-miss legacy identities', (candidate) => {
    expect(isAutomatedReviewerPaneIdentity(candidate)).toBe(false);
  });
});

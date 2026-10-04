import { expect, it } from 'vitest';
import { AnalysisJobProgress } from './pty-analysis-progress';

it('never lets another job or another Worker rescue the current job deadline', () => {
  const owner = new AnalysisJobProgress();
  owner.start(1); owner.complete(1); owner.start(2);
  expect(owner.completed(2)).toBe(false);
  owner.complete(2); expect(owner.completed(2)).toBe(true);
  expect(owner.completed(1)).toBe(false);
  const replacement = new AnalysisJobProgress(); replacement.start(2);
  expect(replacement.completed(2)).toBe(false);
  owner.startActivity(5); owner.completeActivity(5); owner.startActivity(6);
  expect(owner.completedActivity(6)).toBe(false);
  expect(owner.completedActivity(5)).toBe(true);
});

import { describe, expect, it, vi } from 'vitest';
import { finalizeIntegratedTask } from './merge-task-finalizer';

describe('finalizeIntegratedTask', () => {
  it('uses the same task and autopilot finalizer after any successful merge path', async () => {
    const order: string[] = [];
    const markTaskDone = vi.fn(() => order.push('task'));
    const driveMission = vi.fn(async () => {
      order.push('autopilot');
      return { state: 'confirmation' };
    });
    const result = {
      taskKey: 'mission-a:task-a',
      taskHeadSha: 'a'.repeat(40),
      integrationBaseSha: 'b'.repeat(40),
      candidateSha: 'c'.repeat(40),
      integratedSha: 'c'.repeat(40),
      diffHash: 'd'.repeat(64),
      evidenceIds: ['evidence-a'],
    };

    await expect(finalizeIntegratedTask(
      'mission-a',
      'task-a',
      result,
      { markTaskDone, driveMission },
    )).resolves.toEqual({
      ...result,
      autopilot: { state: 'confirmation' },
    });
    expect(markTaskDone).toHaveBeenCalledWith('mission-a', 'task-a');
    expect(driveMission).toHaveBeenCalledWith('mission-a');
    expect(order).toEqual(['task', 'autopilot']);
  });
});

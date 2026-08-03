import { describe, expect, it } from 'vitest';
import {
  computeTaskWaveHints,
  withMissionTaskWaveHints,
  type MissionTaskScheduleItem,
} from './mission-task-schedule';

function item(
  taskId: string,
  dependsOn: readonly string[] = [],
  patch: Partial<MissionTaskScheduleItem> = {},
): MissionTaskScheduleItem {
  return {
    taskId,
    title: `Task ${taskId}`,
    agentName: null,
    agentCategory: null,
    stage: null,
    status: 'pending',
    dependsOn,
    waveHint: 0,
    ...patch,
  };
}

describe('computeTaskWaveHints — topological BFS', () => {
  it('puts independent roots in wave 1', () => {
    const hints = computeTaskWaveHints([item('a'), item('b')]);
    expect(hints.get('a')).toBe(1);
    expect(hints.get('b')).toBe(1);
  });

  it('places a task one wave after its slowest dependency', () => {
    const hints = computeTaskWaveHints([
      item('impl'),
      item('review', ['impl']),
      item('qa', ['review']),
    ]);
    expect(hints.get('impl')).toBe(1);
    expect(hints.get('review')).toBe(2);
    expect(hints.get('qa')).toBe(3);
  });

  it('fans out siblings that share one dependency', () => {
    const hints = computeTaskWaveHints([
      item('impl'),
      item('review', ['impl']),
      item('docs', ['impl']),
      item('merge', ['review', 'docs']),
    ]);
    expect(hints.get('review')).toBe(2);
    expect(hints.get('docs')).toBe(2);
    expect(hints.get('merge')).toBe(3);
  });

  it('ignores dependencies outside the item set (stale receipt revision)', () => {
    const hints = computeTaskWaveHints([item('solo', ['ghost'])]);
    expect(hints.get('solo')).toBe(1);
  });

  it('resolves a cycle deterministically instead of hanging', () => {
    const hints = computeTaskWaveHints([
      item('a', ['b']),
      item('b', ['a']),
    ]);
    expect([...hints.values()].every((wave) => wave >= 1)).toBe(true);
    expect(hints.size).toBe(2);
  });
});

describe('withMissionTaskWaveHints', () => {
  it('fills waveHint on every item preserving the rest', () => {
    const filled = withMissionTaskWaveHints([
      item('impl'),
      item('review', ['impl'], { title: 'Revisar' }),
    ]);
    expect(filled[0]?.waveHint).toBe(1);
    expect(filled[1]?.waveHint).toBe(2);
    expect(filled[1]?.title).toBe('Revisar');
  });
});

import { describe, expect, it } from 'vitest';
import {
  isParallelSchedulerFlagEnabled,
  taskRecordToSchedulerTask,
  taskRecordsToScheduleTasks,
} from './mission-scheduler-io';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';
import { decideSchedule } from './mission-scheduler';
import type { TaskRecord } from '../../shared/orch-types';

function record(
  id: string,
  detail: string,
  status: TaskRecord['status'] = 'pending',
): TaskRecord {
  return {
    id,
    missionId: 'm1',
    title: id,
    detail,
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('mission-scheduler-io', () => {
  it('flag resolves fail-closed default off', () => {
    expect(isParallelSchedulerFlagEnabled({})).toBe(false);
    expect(isParallelSchedulerFlagEnabled({ override: true })).toBe(true);
  });

  it('maps planned task records into schedule tasks and decides a wave', () => {
    const aDetail = encodeTaskScheduleDetail('work a', {
      dependsOn: [],
      ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      merged: false,
      parallelEligible: true,
    });
    const bDetail = encodeTaskScheduleDetail('work b', {
      dependsOn: [],
      ownership: { files: ['src/b.ts'], symbols: [], domains: [] },
      merged: false,
      parallelEligible: true,
    });
    const cDetail = encodeTaskScheduleDetail('work c depends a', {
      dependsOn: ['task-a'],
      ownership: { files: ['src/c.ts'], symbols: [], domains: [] },
      merged: false,
      parallelEligible: true,
    });
    const records = [
      record('task-a', aDetail),
      record('task-b', bDetail),
      record('task-c', cDetail),
    ];
    const scheduleTasks = taskRecordsToScheduleTasks(records);
    const decision = decideSchedule(
      scheduleTasks,
      [],
      { configuredCap: 4, cores: 8, paneBudget: 8 },
      Date.now(),
    );
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    expect(decision.plan.taskIds).toEqual(['task-a', 'task-b']);
    expect(decision.deferredIds).toEqual([]);
    // c is not ready
    expect(decision.readyIds).not.toContain('task-c');

    const mapped = taskRecordToSchedulerTask(records[0]!);
    expect(mapped.parallelEligible).toBe(true);
    expect(mapped.ownership.files).toEqual(['src/a.ts']);
  });

  it('legacy tasks without meta are sequential-only', () => {
    const mapped = taskRecordToSchedulerTask(
      record('legacy', 'plain detail text'),
    );
    expect(mapped.dependsOn).toEqual([]);
    expect(mapped.parallelEligible).toBe(false);
    expect(mapped.ownership.domains).toContain('sequential-only');
  });
});

/**
 * IO bridge for the parallel scheduler: task-store records ↔ ScheduleTask,
 * feature-flag resolution, adaptive state in-memory (process-local).
 *
 * Production wiring lives in mission-scheduler-production.ts; the pure core
 * remains free of stores.
 */

import {
  BUILTIN_FEATURE_FLAGS,
  FEATURE_FLAG_IDS,
  resolveFeatureFlag,
  type FeatureFlagChannel,
} from '../../shared/feature-flags';
import type { TaskRecord } from '../../shared/orch-types';
import { decodeTaskScheduleDetail } from './mission-scheduler-meta';
import type {
  ScheduleOwnership,
  ScheduleTask,
  ScheduleTaskStatus,
} from './mission-scheduler';
import {
  PARALLEL_SCHEDULER_FLAG_ID,
  type SchedulerRuntimeTask,
} from './mission-scheduler-runtime';

export function isParallelSchedulerFlagEnabled(options: {
  runtimeChannel?: FeatureFlagChannel;
  override?: boolean;
}): boolean {
  const def = BUILTIN_FEATURE_FLAGS.find(
    (f) => f.id === FEATURE_FLAG_IDS.parallelScheduler,
  );
  return resolveFeatureFlag(def, {
    runtimeChannel: options.runtimeChannel ?? 'dev',
    override: options.override,
  }).enabled;
}

export function taskRecordToSchedulerTask(
  record: TaskRecord,
): SchedulerRuntimeTask {
  const { meta } = decodeTaskScheduleDetail(record.detail ?? '');
  const ownership: ScheduleOwnership = meta?.ownership ?? {
    files: Object.freeze([]),
    symbols: Object.freeze([]),
    domains: Object.freeze(['sequential-only']),
  };
  return {
    id: record.id,
    status: record.status as ScheduleTaskStatus,
    dependsOn: meta?.dependsOn ?? Object.freeze([]),
    ownership,
    // With schedule meta: only explicit merge flag counts (done ≠ merged).
    // Legacy tasks without meta: status done is treated as fully complete.
    merged: meta ? meta.merged === true : record.status === 'done',
    parallelEligible:
      meta?.parallelEligible ??
      ((meta?.ownership.files.length ?? 0) > 0 &&
        !(meta?.ownership.domains ?? []).includes('sequential-only')),
  };
}

export function taskRecordsToScheduleTasks(
  records: readonly TaskRecord[],
): readonly ScheduleTask[] {
  return Object.freeze(
    records.map((r) => {
      const s = taskRecordToSchedulerTask(r);
      return Object.freeze({
        id: s.id,
        status: s.status,
        dependsOn: s.dependsOn,
        ownership: s.ownership,
        merged: s.merged,
      });
    }),
  );
}

export { PARALLEL_SCHEDULER_FLAG_ID };

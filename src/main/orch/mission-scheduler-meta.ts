/**
 * Encode/decode schedule metadata (ownership + dependsOn + merged) on task
 * detail without a DB schema migration. Additive and fail-closed.
 */

import type { ScheduleOwnership } from './mission-scheduler';

const META_PREFIX = 'NEXUS_SCHEDULE_META:';
const META_SEP = '\n---\n';

export interface TaskScheduleMeta {
  readonly dependsOn: readonly string[];
  readonly ownership: ScheduleOwnership;
  readonly merged: boolean;
  readonly parallelEligible?: boolean;
  /** Canonical squad agent id frozen by the plan receipt. */
  readonly agentRef?: string;
  readonly agentCategory?: 'executor' | 'reviewer' | 'scout' | 'architect';
  readonly executionMode?: 'isolated_worktree' | 'read_only';
}

export function encodeTaskScheduleDetail(
  body: string,
  meta: TaskScheduleMeta,
): string {
  const payload = {
    dependsOn: [...meta.dependsOn],
    ownership: {
      files: [...meta.ownership.files],
      symbols: [...meta.ownership.symbols],
      domains: [...meta.ownership.domains],
    },
    merged: meta.merged,
    ...(meta.parallelEligible !== undefined
      ? { parallelEligible: meta.parallelEligible }
      : {}),
    ...(meta.agentRef ? { agentRef: meta.agentRef } : {}),
    ...(meta.agentCategory ? { agentCategory: meta.agentCategory } : {}),
    ...(meta.executionMode ? { executionMode: meta.executionMode } : {}),
  };
  return `${META_PREFIX}${JSON.stringify(payload)}${META_SEP}${body}`;
}

export function decodeTaskScheduleDetail(detail: string): {
  readonly body: string;
  readonly meta: TaskScheduleMeta | null;
} {
  if (!detail.startsWith(META_PREFIX)) {
    return { body: detail, meta: null };
  }
  const sep = detail.indexOf(META_SEP);
  if (sep < 0) {
    return { body: detail, meta: null };
  }
  const raw = detail.slice(META_PREFIX.length, sep);
  const body = detail.slice(sep + META_SEP.length);
  try {
    const parsed = JSON.parse(raw) as {
      dependsOn?: unknown;
      ownership?: {
        files?: unknown;
        symbols?: unknown;
        domains?: unknown;
      };
      merged?: unknown;
      parallelEligible?: unknown;
      agentRef?: unknown;
      agentCategory?: unknown;
      executionMode?: unknown;
    };
    const files = Array.isArray(parsed.ownership?.files)
      ? parsed.ownership!.files.filter((f): f is string => typeof f === 'string')
      : [];
    const symbols = Array.isArray(parsed.ownership?.symbols)
      ? parsed.ownership!.symbols.filter(
          (s): s is string => typeof s === 'string',
        )
      : [];
    const domains = Array.isArray(parsed.ownership?.domains)
      ? parsed.ownership!.domains.filter(
          (d): d is string => typeof d === 'string',
        )
      : [];
    const dependsOn = Array.isArray(parsed.dependsOn)
      ? parsed.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];
    return {
      body,
      meta: {
        dependsOn: Object.freeze(dependsOn),
        ownership: Object.freeze({
          files: Object.freeze(files),
          symbols: Object.freeze(symbols),
          domains: Object.freeze(domains),
        }),
        merged: parsed.merged === true,
        parallelEligible:
          typeof parsed.parallelEligible === 'boolean'
            ? parsed.parallelEligible
            : undefined,
        agentRef:
          typeof parsed.agentRef === 'string' && parsed.agentRef.length > 0
            ? parsed.agentRef
            : undefined,
        agentCategory:
          parsed.agentCategory === 'executor' ||
          parsed.agentCategory === 'reviewer' ||
          parsed.agentCategory === 'scout' ||
          parsed.agentCategory === 'architect'
            ? parsed.agentCategory
            : undefined,
        executionMode:
          parsed.executionMode === 'isolated_worktree' ||
          parsed.executionMode === 'read_only'
            ? parsed.executionMode
            : undefined,
      },
    };
  } catch {
    return { body: detail, meta: null };
  }
}

export function withMergedFlag(detail: string, merged: boolean): string {
  const { body, meta } = decodeTaskScheduleDetail(detail);
  if (!meta) {
    return encodeTaskScheduleDetail(body, {
      dependsOn: [],
      ownership: { files: [], symbols: [], domains: [] },
      merged,
    });
  }
  return encodeTaskScheduleDetail(body, { ...meta, merged });
}

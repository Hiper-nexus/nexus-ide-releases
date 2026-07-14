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

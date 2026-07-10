import type Database from 'better-sqlite3';
import { z } from 'zod';
import type {
  GamificationTier,
  XpEventKind,
} from '../../shared/gamification-types';
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectDomainStoreSuite } from '../orch/project-domain-store-registry';
import { getMeta } from './gamification-store';
import type { StreakState } from './streak';
import { TIER_THRESHOLDS } from './xp-rules';

export const DELIVERY_KINDS: ReadonlySet<XpEventKind> = new Set([
  'mission_green',
  'mission_done',
  'handoff_green',
  'handoff_success',
  'task_done',
]);

export const EMPTY_STREAK: StreakState = Object.freeze({
  streakDays: 0,
  lastDeliveryDay: null,
  shieldsUsedMonth: null,
  shieldsUsed: 0,
});

export const streakSchema = z
  .object({
    streakDays: z.number().int().nonnegative(),
    lastDeliveryDay: z.string().nullable(),
    shieldsUsedMonth: z.string().nullable(),
    shieldsUsed: z.number().int().nonnegative(),
  })
  .strict();

export const countersSchema = z.record(
  z.string().min(1).max(128),
  z.number().int().nonnegative(),
);

export const stringListSchema = z.array(z.string().min(1).max(128)).max(10_000);

export const tierSchema = z.enum([
  'RECRUTA',
  'INICIADO',
  'VETERANO',
  'ELITE',
  'MAESTRO',
  'LENDA',
]);

const TIER_ORDER: GamificationTier[] = TIER_THRESHOLDS.map(
  (entry) => entry.tier,
);
const EFFORT_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

export function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

export function sameScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

export function tierRank(tier: GamificationTier): number {
  const index = TIER_ORDER.indexOf(tier);
  return index < 0 ? 0 : index;
}

export function maxTier(
  first: GamificationTier,
  second: GamificationTier,
): GamificationTier {
  return tierRank(first) >= tierRank(second) ? first : second;
}

export function monthKeyOf(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function dayStartOf(epochMs: number): number {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function metaJson<T>(
  db: Database.Database,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  const raw = getMeta(db, key);
  if (raw === null) return fallback;
  return schema.parse(JSON.parse(raw) as unknown);
}

export function metaNumber(
  db: Database.Database,
  key: string,
  fallback: number,
): number {
  const raw = getMeta(db, key);
  if (raw === null) return fallback;
  return z.coerce.number().finite().nonnegative().parse(raw);
}

/** Artifact `{kind:'verification', command, exitCode:0}` becomes evidence. */
export function hasGreenEvidence(artifacts: unknown[]): string | null {
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    const record = artifact as Record<string, unknown>;
    if (
      record.kind === 'verification' &&
      typeof record.command === 'string' &&
      record.exitCode === 0
    ) {
      return `${record.command} (exit 0)`;
    }
  }
  return null;
}

export function missionEffort(
  suite: ProjectDomainStoreSuite,
  missionId: string,
): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const pane of suite.missionPanes.list(missionId)) {
    const rank = pane.effort ? EFFORT_RANK[pane.effort] ?? 0 : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = pane.effort ?? null;
    }
  }
  return best;
}

export function handoffEffort(
  suite: ProjectDomainStoreSuite,
  handoff: Handoff,
): string | null {
  if (!handoff.missionId) return null;
  const panes = suite.missionPanes.list(handoff.missionId);
  if (handoff.fromAgent) {
    const own = panes.find((pane) => pane.agentName === handoff.fromAgent);
    if (own?.effort) return own.effort;
  }
  return panes.find((pane) => pane.role === 'worker')?.effort ?? null;
}

/** Reads project-local usage contracts; missing measurements mean no bonus. */
export function missionCost(
  db: Database.Database,
  missionId: string,
): number | null {
  try {
    const usage = db
      .prepare(
        `SELECT COALESCE(SUM(cost_micros), 0) AS cost_micros
         FROM usage_events WHERE mission_id = ?`,
      )
      .get(missionId) as { cost_micros?: unknown } | undefined;
    const micros = Number(usage?.cost_micros ?? 0);
    if (!Number.isFinite(micros) || micros < 0) {
      throw new Error('invalid usage cost');
    }
    let total = micros / 1_000_000;
    const mediaRows = db
      .prepare('SELECT metadata_json FROM media_artifacts WHERE mission_id = ?')
      .all(missionId) as Array<{ metadata_json?: unknown }>;
    for (const row of mediaRows) {
      if (typeof row.metadata_json !== 'string') continue;
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const cost = metadata.estimatedCostUsd ?? metadata.costUsd;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
        total += cost;
      }
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

export function bumpExtra(extra: Record<string, number>, key: string): void {
  extra[key] = (extra[key] ?? 0) + 1;
}

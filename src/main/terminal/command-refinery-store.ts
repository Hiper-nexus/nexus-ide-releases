import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  commandSuggestionSchema,
  type CommandSuggestion,
  type CommandSuggestionScope,
} from '../../shared/command-refinery';
import { commandBlockSchema, type CommandBlock } from '../../shared/command-block';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { redactCommandLine } from './command-redaction';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DECAY_PERIOD_MS = 30 * DAY_MS;
const MAX_SUGGESTIONS = 20;
const CANDIDATE_MULTIPLIER = 4;
const MIN_CANDIDATES_PER_TIER = 12;
const MAX_CANDIDATES_PER_TIER = 80;
const LEGACY_BACKFILL_BATCH = 250;
const SCOPE_WEIGHT: Readonly<Record<CommandSuggestionScope, number>> = {
  cwd: 3,
  project: 2,
  global: 1,
};

const commandStatRowSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    command: z.string().min(1).max(16_384),
    cwd_project_root: z.string().min(1).max(4096).nullable(),
    total_count: z.number().int().nonnegative(),
    success_count: z.number().int().nonnegative(),
    distinct_days: z.number().int().nonnegative(),
    last_day: z.number().int().nonnegative(),
    first_used: z.number().int().nonnegative(),
    last_used: z.number().int().nonnegative(),
    last_branch: z.string().max(512).nullable(),
    dismissed_count: z.number().int().nonnegative(),
    last_dismissed_at: z.number().int().nonnegative().nullable(),
    last_decayed_at: z.number().int().nonnegative(),
  })
  .strict();

const legacyCommandRowSchema = z
  .object({
    idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
    command: z.string().max(16_384),
    cwd: z.string().min(1).max(4096),
    project_root: z.string().min(1).max(4096).nullable(),
    git_branch: z.string().max(512).nullable(),
    started_at: z.number().int().nonnegative(),
    ended_at: z.number().int().nonnegative().nullable(),
    status: z.enum(['running', 'success', 'failed', 'cancelled', 'unknown']),
    redacted: z.number().int(),
    denylisted: z.number().int(),
    secret_hits: z.number().int().nonnegative(),
  })
  .strict();

type CommandStatRow = z.infer<typeof commandStatRowSchema>;
type LegacyCommandRow = z.infer<typeof legacyCommandRowSchema>;

interface RefineryObservation {
  readonly observationKey: string;
  readonly command: string;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly gitBranch?: string;
  readonly usedAt: number;
  readonly isSuccess: boolean;
}

export interface CommandSuggestionQuery {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly prefix?: string;
  readonly limit?: number;
}

export interface CommandSuggestionTarget {
  readonly command: string;
  readonly cwd: string;
}

/**
 * Materialized, scope-bound command history. Raw CommandBlocks remain the
 * audit trail; this store is a rebuildable product index over clean results.
 */
export class CommandRefineryStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  /** Returns true only when this physical block changed the aggregate. */
  record(raw: CommandBlock): boolean {
    const block = commandBlockSchema.parse(raw);
    if (block.status !== 'success' && block.status !== 'failed') return false;
    const scrubbed = redactCommandLine(block.command);
    if (
      block.redaction.redacted ||
      block.redaction.denylisted ||
      block.redaction.secretHits > 0 ||
      scrubbed.redacted ||
      scrubbed.denylisted ||
      scrubbed.secretHits > 0
    ) {
      return false;
    }
    const command = scrubbed.command.trim();
    if (!command) return false;
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    return db.transaction(() =>
      this.#recordObservation(
        db,
        {
          observationKey: block.idempotencyKey,
          command,
          cwd: block.cwd,
          projectRoot: block.projectRoot,
          gitBranch: block.gitBranch,
          usedAt: block.endedAt ?? block.startedAt,
          isSuccess: block.status === 'success',
        },
        now,
      ),
    )();
  }

  suggest(query: CommandSuggestionQuery): readonly CommandSuggestion[] {
    const cwd = parsePath(query.cwd, 'cwd');
    const projectRoot = query.projectRoot
      ? parsePath(query.projectRoot, 'projectRoot')
      : undefined;
    const prefix = parsePrefix(query.prefix ?? '');
    const limit = Math.min(Math.max(query.limit ?? 12, 1), MAX_SUGGESTIONS);
    this.#backfillLegacyHistory();
    const candidateLimit = Math.min(
      Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATES_PER_TIER),
      MAX_CANDIDATES_PER_TIER,
    );
    const now = this.#binding.now();
    const db = this.#binding.readDatabase();
    const pattern = `${escapeLike(prefix)}%`;
    const rows = [
      ...readCandidates(db, 'cwd = ?', [cwd], pattern, candidateLimit),
      ...(projectRoot
        ? readCandidates(
            db,
            'cwd <> ? AND cwd_project_root = ?',
            [cwd, projectRoot],
            pattern,
            candidateLimit,
          )
        : []),
      ...readCandidates(
        db,
        projectRoot
          ? `cwd <> ? AND (
               cwd_project_root IS NULL OR cwd_project_root <> ?
             )`
          : 'cwd <> ?',
        projectRoot ? [cwd, projectRoot] : [cwd],
        pattern,
        candidateLimit,
      ),
    ];

    const byCommand = new Map<string, CommandSuggestion>();
    for (const row of rows) {
      const suggestion = toSuggestion(row, { cwd, projectRoot, now });
      const existing = byCommand.get(suggestion.command);
      if (!existing || compareSuggestions(suggestion, existing) < 0) {
        byCommand.set(suggestion.command, suggestion);
      }
    }
    return [...byCommand.values()].sort(compareSuggestions).slice(0, limit);
  }

  dismiss(target: CommandSuggestionTarget): boolean {
    const command = parseCommand(target.command);
    const cwd = parsePath(target.cwd, 'cwd');
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const info = db
      .prepare(
        `UPDATE command_stats
         SET dismissed_count = dismissed_count + 1,
             last_dismissed_at = ?
         WHERE cwd = ? AND command = ?
           AND (last_dismissed_at IS NULL OR last_used > last_dismissed_at)`,
      )
      .run(now, cwd, command) as { changes?: number };
    if ((info.changes ?? 0) > 0) return true;
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM command_stats WHERE cwd = ? AND command = ?`,
        )
        .get(cwd, command),
    );
  }

  resolveRunnable(target: CommandSuggestionTarget): string | null {
    const command = parseCommand(target.command);
    const cwd = parsePath(target.cwd, 'cwd');
    const raw = this.#binding
      .readDatabase()
      .prepare(
        `SELECT command FROM command_stats
         WHERE cwd = ? AND command = ?
           AND (last_dismissed_at IS NULL OR last_used > last_dismissed_at)`,
      )
      .get(cwd, command) as { command?: unknown } | undefined;
    return typeof raw?.command === 'string' && raw.command === command
      ? raw.command
      : null;
  }

  #backfillLegacyHistory(): void {
    try {
      const db = this.#binding.writeDatabase();
      while (true) {
        const rawRows = db
          .prepare(
            `SELECT
               blocks.idempotency_key, blocks.command, blocks.cwd,
               blocks.project_root, blocks.git_branch, blocks.started_at,
               blocks.ended_at, blocks.status, blocks.redacted,
               blocks.denylisted, blocks.secret_hits
             FROM command_blocks AS blocks
             LEFT JOIN command_stat_observations AS observed
               ON observed.observation_key = blocks.idempotency_key
             WHERE observed.observation_key IS NULL
               AND blocks.status <> 'running'
             ORDER BY blocks.started_at ASC
             LIMIT ?`,
          )
          .all(LEGACY_BACKFILL_BATCH);
        if (rawRows.length === 0) return;
        const rows = rawRows.map(parseLegacyCommandRow);
        const now = this.#binding.now();
        db.transaction(() => {
          for (const row of rows) this.#backfillRow(db, row, now);
        })();
        if (rows.length < LEGACY_BACKFILL_BATCH) return;
      }
    } catch (error) {
      // Suggestions are a derived convenience. A read-only/corrupt legacy
      // history must not take the terminal or already materialized stats down.
      console.warn('[command-refinery] legacy backfill unavailable:', error);
    }
  }

  #backfillRow(
    db: Database.Database,
    row: LegacyCommandRow,
    now: number,
  ): void {
    const usedAt = row.ended_at ?? row.started_at;
    const scrubbed = redactCommandLine(row.command);
    const isEligible =
      (row.status === 'success' || row.status === 'failed') &&
      row.redacted === 0 &&
      row.denylisted === 0 &&
      row.secret_hits === 0 &&
      !scrubbed.redacted &&
      !scrubbed.denylisted &&
      scrubbed.secretHits === 0 &&
      scrubbed.command.trim().length > 0;
    if (!isEligible) {
      this.#insertObservation(db, row.idempotency_key, usedAt);
      return;
    }
    this.#recordObservation(
      db,
      {
        observationKey: row.idempotency_key,
        command: scrubbed.command.trim(),
        cwd: row.cwd,
        projectRoot: row.project_root ?? undefined,
        gitBranch: row.git_branch ?? undefined,
        usedAt,
        isSuccess: row.status === 'success',
      },
      now,
    );
  }

  #recordObservation(
    db: Database.Database,
    observation: RefineryObservation,
    now: number,
  ): boolean {
    if (
      !this.#insertObservation(
        db,
        observation.observationKey,
        observation.usedAt,
      )
    ) {
      return false;
    }
    const day = Math.floor(observation.usedAt / DAY_MS);
    this.#decay(db, observation.cwd, observation.command, now);
    const distinctDay = db
      .prepare(
        `INSERT OR IGNORE INTO command_stat_days (cwd, command, day)
         VALUES (?, ?, ?)`,
      )
      .run(observation.cwd, observation.command, day) as { changes?: number };

    db.prepare(
      `INSERT INTO command_stats (
         cwd, command, cwd_project_root, total_count, success_count,
         distinct_days, last_day, first_used, last_used, last_branch,
         dismissed_count, last_dismissed_at, last_decayed_at
       ) VALUES (
         @cwd, @command, @project_root, 1, @success_count,
         @distinct_days, @day, @used_at, @used_at, @last_branch,
         0, NULL, @now
       )
       ON CONFLICT(cwd, command) DO UPDATE SET
         cwd_project_root = COALESCE(
           excluded.cwd_project_root,
           command_stats.cwd_project_root
         ),
         total_count = command_stats.total_count + 1,
         success_count = command_stats.success_count + excluded.success_count,
         distinct_days = command_stats.distinct_days + excluded.distinct_days,
         last_day = MAX(command_stats.last_day, excluded.last_day),
         first_used = MIN(command_stats.first_used, excluded.first_used),
         last_branch = CASE
           WHEN excluded.last_used >= command_stats.last_used
             THEN COALESCE(excluded.last_branch, command_stats.last_branch)
           ELSE command_stats.last_branch
         END,
         last_used = MAX(command_stats.last_used, excluded.last_used),
         last_dismissed_at = NULL`,
    ).run({
      cwd: observation.cwd,
      command: observation.command,
      project_root: observation.projectRoot ?? null,
      success_count: observation.isSuccess ? 1 : 0,
      distinct_days: distinctDay.changes ?? 0,
      day,
      used_at: observation.usedAt,
      last_branch: observation.gitBranch ?? null,
      now,
    });
    return true;
  }

  #insertObservation(
    db: Database.Database,
    observationKey: string,
    observedAt: number,
  ): boolean {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO command_stat_observations
           (observation_key, observed_at)
         VALUES (?, ?)`,
      )
      .run(observationKey, observedAt) as { changes?: number };
    return (info.changes ?? 0) > 0;
  }

  #decay(
    db: Database.Database,
    cwd: string,
    command: string,
    now: number,
  ): void {
    const raw = db
      .prepare(
        `SELECT total_count, success_count, dismissed_count, last_decayed_at
         FROM command_stats WHERE cwd = ? AND command = ?`,
      )
      .get(cwd, command) as
      | {
          total_count: number;
          success_count: number;
          dismissed_count: number;
          last_decayed_at: number;
        }
      | undefined;
    if (!raw) return;
    const decayed = effectiveCounts(
      {
        totalCount: raw.total_count,
        successCount: raw.success_count,
        dismissedCount: raw.dismissed_count,
        lastDecayedAt: raw.last_decayed_at,
      },
      now,
    );
    if (decayed.periods === 0) return;
    db.prepare(
      `UPDATE command_stats SET
         total_count = ?, success_count = ?, dismissed_count = ?,
         last_decayed_at = ?
       WHERE cwd = ? AND command = ?`,
    ).run(
      decayed.totalCount,
      decayed.successCount,
      decayed.dismissedCount,
      decayed.lastDecayedAt,
      cwd,
      command,
    );
  }
}

function rowToCommandStat(raw: unknown): CommandStatRow {
  try {
    return commandStatRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('command stat', { cause: error });
  }
}

function parseLegacyCommandRow(raw: unknown): LegacyCommandRow {
  try {
    return legacyCommandRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('legacy command block', {
      cause: error,
    });
  }
}

function readCandidates(
  db: Database.Database,
  scopeClause: string,
  scopeParams: readonly string[],
  pattern: string,
  limit: number,
): CommandStatRow[] {
  return db
    .prepare(
      `SELECT * FROM command_stats
       WHERE command LIKE ? ESCAPE '\\' COLLATE NOCASE
         AND (last_dismissed_at IS NULL OR last_used > last_dismissed_at)
         AND (${scopeClause})
       ORDER BY last_used DESC
       LIMIT ?`,
    )
    .all(pattern, ...scopeParams, limit)
    .map(rowToCommandStat);
}

function toSuggestion(
  row: CommandStatRow,
  context: {
    readonly cwd: string;
    readonly projectRoot?: string;
    readonly now: number;
  },
): CommandSuggestion {
  const scope: CommandSuggestionScope =
    row.cwd === context.cwd
      ? 'cwd'
      : context.projectRoot && row.cwd_project_root === context.projectRoot
        ? 'project'
        : 'global';
  const decayed = effectiveCounts(
    {
      totalCount: row.total_count,
      successCount: row.success_count,
      dismissedCount: row.dismissed_count,
      lastDecayedAt: row.last_decayed_at,
    },
    context.now,
  );
  const successRate = decayed.successCount / decayed.totalCount;
  const ageDays = Math.max(0, (context.now - row.last_used) / DAY_MS);
  const frequency = Math.min(Math.log2(decayed.totalCount + 1) * 12, 60);
  const recency = Math.max(0, 30 - ageDays);
  const breadth = Math.min(row.distinct_days, 10);
  const dismissPenalty = Math.min(decayed.dismissedCount * 12, 48);
  return commandSuggestionSchema.parse({
    command: row.command,
    cwd: row.cwd,
    projectRoot: row.cwd_project_root ?? undefined,
    lastBranch: row.last_branch ?? undefined,
    totalCount: decayed.totalCount,
    successCount: decayed.successCount,
    successRate,
    distinctDays: row.distinct_days,
    dismissedCount: decayed.dismissedCount,
    lastUsed: row.last_used,
    score:
      SCOPE_WEIGHT[scope] * 1_000 +
      frequency +
      successRate * 24 +
      recency +
      breadth -
      dismissPenalty,
    scope,
  });
}

interface DecayCounts {
  readonly totalCount: number;
  readonly successCount: number;
  readonly dismissedCount: number;
  readonly lastDecayedAt: number;
  readonly periods: number;
}

function effectiveCounts(
  input: Omit<DecayCounts, 'periods'>,
  now: number,
): DecayCounts {
  const periods = Math.max(
    0,
    Math.floor((now - input.lastDecayedAt) / DECAY_PERIOD_MS),
  );
  if (periods === 0) return { ...input, periods };
  const factor = 0.5 ** Math.min(periods, 30);
  const totalCount = Math.max(1, Math.floor(input.totalCount * factor));
  const successRate = input.successCount / input.totalCount;
  return {
    totalCount,
    successCount: Math.min(
      totalCount,
      Math.round(totalCount * successRate),
    ),
    dismissedCount: Math.floor(input.dismissedCount * factor),
    lastDecayedAt: input.lastDecayedAt + periods * DECAY_PERIOD_MS,
    periods,
  };
}

function compareSuggestions(
  left: CommandSuggestion,
  right: CommandSuggestion,
): number {
  const scopeDelta = SCOPE_WEIGHT[right.scope] - SCOPE_WEIGHT[left.scope];
  if (scopeDelta !== 0) return scopeDelta;
  if (right.score !== left.score) return right.score - left.score;
  if (right.lastUsed !== left.lastUsed) return right.lastUsed - left.lastUsed;
  return left.command.localeCompare(right.command);
}

function parsePath(value: string, label: string): string {
  const parsed = z.string().min(1).max(4096).parse(value);
  if (parsed.includes('\0')) throw new Error(`invalid ${label}`);
  return parsed;
}

function parseCommand(value: string): string {
  const parsed = z.string().min(1).max(16_384).parse(value).trim();
  if (!parsed || parsed.includes('\0')) throw new Error('invalid command');
  return parsed;
}

function parsePrefix(value: string): string {
  const parsed = z.string().max(512).parse(value);
  if (parsed.includes('\0')) throw new Error('invalid command prefix');
  return parsed.trimStart();
}

function escapeLike(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1');
}

import { z } from 'zod';
import {
  commandBlockSchema,
  createCommandBlock,
  type CommandBlock,
  type CreateCommandBlockInput,
} from '../../shared/command-block';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { computeCommandBlockIdempotencyKey } from './command-block-id';
import { redactCommandLine } from './command-redaction';

/**
 * Persist semantic command blocks (history). Stream remains visual SoT.
 */

const rowSchema = z
  .object({
    id: z.string().min(1).max(128),
    session_id: z.string().min(1).max(128),
    pane_id: z.string().min(1).max(128),
    workspace_id: z.string().min(1).max(128),
    mission_id: z.string().min(1).max(128).nullable(),
    command: z.string().max(16_384),
    cwd: z.string().min(1).max(4096),
    project_root: z.string().min(1).max(4096).nullable(),
    shell: z.string().min(1).max(256),
    git_branch: z.string().max(512).nullable(),
    started_at: z.number().int().nonnegative(),
    ended_at: z.number().int().nonnegative().nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    exit_code: z.number().int().nullable(),
    status: z.string().min(1).max(32),
    output_start_seq: z.number().int().nonnegative().nullable(),
    output_end_seq: z.number().int().nonnegative().nullable(),
    redacted: z.number().int(),
    denylisted: z.number().int(),
    secret_hits: z.number().int().nonnegative(),
    idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface CommandBlockSearchQuery {
  readonly projectRoot?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly commandContains?: string;
  readonly workspaceId?: string;
  readonly limit?: number;
}

export interface CommandBlockStats {
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  readonly successRate: number;
}

export class CommandBlockStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  /**
   * Insert or return existing by idempotency key. Always redacts on write
   * (fail-closed) — caller redaction metadata is merged, never trusted alone.
   */
  insert(raw: CreateCommandBlockInput): CommandBlock {
    const scrubbed = redactCommandLine(raw.command);
    const command = scrubbed.command;
    const redaction = {
      redacted: scrubbed.redacted || scrubbed.denylisted,
      denylisted: scrubbed.denylisted,
      secretHits: scrubbed.secretHits,
    };

    const idempotencyKey =
      raw.idempotencyKey ||
      computeCommandBlockIdempotencyKey({
        sessionId: raw.sessionId,
        startedAt: raw.startedAt,
        command,
        cwd: raw.cwd,
      });

    const block = createCommandBlock({
      ...raw,
      command,
      redaction,
      idempotencyKey,
    });

    const db = this.#binding.writeDatabase();
    const existing = db
      .prepare(`SELECT * FROM command_blocks WHERE idempotency_key = ?`)
      .get(block.idempotencyKey);
    if (existing) {
      const stored = rowToBlock(existing);
      if (
        stored.sessionId !== block.sessionId ||
        stored.startedAt !== block.startedAt ||
        stored.command !== block.command ||
        stored.cwd !== block.cwd
      ) {
        throw new Error('command block idempotency conflict');
      }
      return stored;
    }

    db.prepare(
      `INSERT INTO command_blocks (
         id, session_id, pane_id, workspace_id, mission_id, command, cwd,
         project_root, shell, git_branch, started_at, ended_at, duration_ms,
         exit_code, status, output_start_seq, output_end_seq, redacted,
         denylisted, secret_hits, idempotency_key
       ) VALUES (
         @id, @session_id, @pane_id, @workspace_id, @mission_id, @command, @cwd,
         @project_root, @shell, @git_branch, @started_at, @ended_at, @duration_ms,
         @exit_code, @status, @output_start_seq, @output_end_seq, @redacted,
         @denylisted, @secret_hits, @idempotency_key
       )`,
    ).run({
      id: block.id,
      session_id: block.sessionId,
      pane_id: block.paneId,
      workspace_id: block.workspaceId,
      mission_id: block.missionId ?? null,
      command: block.command,
      cwd: block.cwd,
      project_root: block.projectRoot ?? null,
      shell: block.shell,
      git_branch: block.gitBranch ?? null,
      started_at: block.startedAt,
      ended_at: block.endedAt ?? null,
      duration_ms: block.durationMs ?? null,
      exit_code: block.exitCode ?? null,
      status: block.status,
      output_start_seq: block.outputRange?.startSeq ?? null,
      output_end_seq: block.outputRange?.endSeq ?? null,
      redacted: block.redaction.redacted ? 1 : 0,
      denylisted: block.redaction.denylisted ? 1 : 0,
      secret_hits: block.redaction.secretHits,
      idempotency_key: block.idempotencyKey,
    });

    return block;
  }

  update(block: CommandBlock): CommandBlock {
    const parsed = commandBlockSchema.parse(block);
    const db = this.#binding.writeDatabase();
    db.prepare(
      `UPDATE command_blocks SET
         ended_at = @ended_at,
         duration_ms = @duration_ms,
         exit_code = @exit_code,
         status = @status,
         output_end_seq = @output_end_seq
       WHERE id = @id`,
    ).run({
      id: parsed.id,
      ended_at: parsed.endedAt ?? null,
      duration_ms: parsed.durationMs ?? null,
      exit_code: parsed.exitCode ?? null,
      status: parsed.status,
      output_end_seq: parsed.outputRange?.endSeq ?? null,
    });
    return parsed;
  }

  search(query: CommandBlockSearchQuery): readonly CommandBlock[] {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.projectRoot) {
      clauses.push('project_root = ?');
      params.push(query.projectRoot);
    }
    if (query.cwd) {
      clauses.push('cwd = ?');
      params.push(query.cwd);
    }
    if (query.gitBranch) {
      clauses.push('git_branch = ?');
      params.push(query.gitBranch);
    }
    if (query.workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(query.workspaceId);
    }
    if (query.commandContains) {
      clauses.push('command LIKE ?');
      params.push(`%${escapeLike(query.commandContains)}%`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `SELECT * FROM command_blocks ${where}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map((row) => rowToBlock(row));
  }

  stats(projectRoot?: string): CommandBlockStats {
    const db = this.#binding.readDatabase();
    const row = (
      projectRoot
        ? db
            .prepare(
              `SELECT
                 COUNT(*) AS total,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
               FROM command_blocks WHERE project_root = ?`,
            )
            .get(projectRoot)
        : db
            .prepare(
              `SELECT
                 COUNT(*) AS total,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
               FROM command_blocks`,
            )
            .get()
    ) as { total: number; success: number | null; failed: number | null };

    const total = row.total ?? 0;
    const success = row.success ?? 0;
    const failed = row.failed ?? 0;
    return {
      total,
      success,
      failed,
      successRate: total === 0 ? 0 : success / total,
    };
  }

  /**
   * Retention: delete oldest finished rows beyond keepLatest.
   * Never deletes status=running.
   */
  prune(keepLatest = 5_000): number {
    const keep = Math.max(1, keepLatest);
    const db = this.#binding.writeDatabase();
    // SQLite forbids deleting from a table while selecting the same table in
    // a correlated NOT IN without materializing — use an explicit id list.
    const keepIds = (
      db
        .prepare(
          `SELECT id FROM command_blocks
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(keep) as Array<{ id: string }>
    ).map((row) => row.id);
    if (keepIds.length === 0) return 0;
    const placeholders = keepIds.map(() => '?').join(', ');
    const info = db
      .prepare(
        `DELETE FROM command_blocks
         WHERE status != 'running'
           AND id NOT IN (${placeholders})`,
      )
      .run(...keepIds) as { changes?: number };
    return info.changes ?? 0;
  }

  /**
   * Size budget: if approximate payload bytes exceed maxBytes, drop oldest
   * finished rows until under budget (or only running remain).
   */
  enforceSizeBudget(maxBytes = 32 * 1024 * 1024): number {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
      throw new Error('invalid command history size budget');
    }
    const db = this.#binding.writeDatabase();
    const estimate = db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(command) + LENGTH(cwd) + 128), 0) AS bytes
         FROM command_blocks`,
      )
      .get() as { bytes: number };
    if ((estimate.bytes ?? 0) <= maxBytes) return 0;

    let deleted = 0;
    const batch = db.prepare(
      `DELETE FROM command_blocks
       WHERE id IN (
         SELECT id FROM command_blocks
         WHERE status != 'running'
         ORDER BY started_at ASC
         LIMIT 100
       )`,
    );
    for (let i = 0; i < 100; i += 1) {
      const info = batch.run() as { changes?: number };
      const n = info.changes ?? 0;
      deleted += n;
      if (n === 0) break;
      const again = db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(command) + LENGTH(cwd) + 128), 0) AS bytes
           FROM command_blocks`,
        )
        .get() as { bytes: number };
      if ((again.bytes ?? 0) <= maxBytes) break;
    }
    return deleted;
  }
}

function rowToBlock(raw: unknown): CommandBlock {
  let row: z.infer<typeof rowSchema>;
  try {
    row = rowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('command block', { cause: error });
  }
  return commandBlockSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    paneId: row.pane_id,
    workspaceId: row.workspace_id,
    missionId: row.mission_id ?? undefined,
    command: row.command,
    cwd: row.cwd,
    projectRoot: row.project_root ?? undefined,
    shell: row.shell,
    gitBranch: row.git_branch ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    exitCode: row.exit_code ?? undefined,
    status: row.status,
    outputRange:
      row.output_start_seq != null
        ? {
            startSeq: row.output_start_seq,
            endSeq: row.output_end_seq,
          }
        : undefined,
    redaction: {
      redacted: row.redacted === 1,
      denylisted: row.denylisted === 1,
      secretHits: row.secret_hits,
    },
    idempotencyKey: row.idempotency_key,
  });
}

function escapeLike(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1');
}

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import { assertSafeLocalGitConfigAsync, AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';
import { ScopedStoreBinding, ScopedStoreCorruptionError } from './scoped-store';

const KEY = 'nexus:mission-code-baseline:v1';
const RUN_ID = 'nexus-code-baseline';
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const headSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const captureSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), headSha: headSchema, executionRootHash: hashSchema, observedAt: timestampSchema }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.enum(['root-unavailable', 'head-unavailable', 'root-changed']), executionRootHash: hashSchema, observedAt: timestampSchema }).strict(),
]);
export type MissionCodeBaseline = Readonly<z.infer<typeof captureSchema>>;
/** In-memory provenance only: serialized agent input cannot mint a Main capture. */
const captures = new WeakSet<object>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function executionRootHash(root: string): string {
  if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('mission code baseline requires an absolute execution root');
  return hash(path.resolve(root));
}
function scopeHash(scope: ProjectExecutionScope): string {
  return hash(JSON.stringify([scope.installationId, scope.projectId, scope.checkoutId, scope.rootRealPath]));
}

/** Main must await this before creating the mission. Never reads or changes WIP. */
export async function captureMissionCodeBaseline(
  executionRoot: string,
  options: { readonly git?: AsyncGitRunner; readonly now?: () => number } = {},
): Promise<MissionCodeBaseline> {
  let rootHash = executionRootHash(executionRoot);
  const finish = (result: { status: 'known'; headSha: string } | { status: 'unknown'; reason: 'root-unavailable' | 'head-unavailable' | 'root-changed' }): MissionCodeBaseline => {
    const captured = Object.freeze(captureSchema.parse({ ...result, executionRootHash: rootHash, observedAt: (options.now ?? Date.now)() }));
    captures.add(captured);
    return captured;
  };
  let root: string;
  let identity: Awaited<ReturnType<typeof fs.stat>>;
  try {
    root = await fs.realpath(executionRoot);
    identity = await fs.stat(root);
    if (!identity.isDirectory()) return finish({ status: 'unknown', reason: 'root-unavailable' });
    rootHash = executionRootHash(root);
  } catch { return finish({ status: 'unknown', reason: 'root-unavailable' }); }
  const runner = options.git ?? new AsyncProcessGitRunner();
  const bounded: AsyncGitRunner = { run: (cwd, args, runOptions) => runner.run(cwd, args, { ...runOptions, timeoutMs: 5_000 }) };
  try {
    await assertSafeLocalGitConfigAsync(bounded, root);
    const head = await bounded.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
    const parsed = headSchema.safeParse(head.stdout.trim().toLowerCase());
    if (head.status !== 0 || !parsed.success) return finish({ status: 'unknown', reason: 'head-unavailable' });
    const after = await fs.stat(root);
    if ((await fs.realpath(executionRoot)) !== root || after.dev !== identity.dev || after.ino !== identity.ino) {
      return finish({ status: 'unknown', reason: 'root-changed' });
    }
    return finish({ status: 'known', headSha: parsed.data });
  } catch { return finish({ status: 'unknown', reason: 'head-unavailable' }); }
}

const payloadSchema = z.object({
  kind: z.literal('nexus.mission-code-baseline'), version: z.literal(1),
  scopeHash: hashSchema, baseline: captureSchema,
}).strict();
const rowSchema = z.object({
  event_type: z.literal('custom'), origin: z.literal('main'), run_id: z.literal(RUN_ID),
  payload_json: z.string().max(2_048), occurred_at: timestampSchema,
}).strict();

/** Reserved custom Main event, independent of optional journal emit flags. */
export class MissionCodeBaselineLedger {
  readonly #binding: ScopedStoreBinding;
  constructor(binding: ScopedStoreBinding) { this.#binding = binding; }

  record(missionId: string, captured: MissionCodeBaseline): MissionCodeBaseline {
    z.string().min(1).max(128).parse(missionId);
    if (!captures.has(captured)) throw new Error('mission code baseline requires a Main capture');
    const input = captureSchema.parse(captured);
    const db = this.#binding.writeDatabase();
    let inserted = false;
    const baseline = db.transaction(() => {
      if (!db.prepare('SELECT id FROM missions WHERE id = ?').get(missionId)) throw new Error('mission code baseline mission not found');
      const existing = this.readFromDatabase(db, missionId, input.executionRootHash);
      if (existing) return existing;
      const sequence = (db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM mission_events WHERE mission_id = ?').get(missionId) as { value: number }).value;
      const id = z.string().min(1).max(128).parse(this.#binding.makeId('code-baseline'));
      db.prepare(`INSERT INTO mission_events (sequence, id, mission_id, run_id, parent_run_id, event_type,
        payload_json, idempotency_key, occurred_at, origin, delivery_status)
        VALUES (?, ?, ?, ?, NULL, 'custom', ?, ?, ?, 'main', 'pending')`).run(
        sequence, id, missionId, RUN_ID,
        JSON.stringify({ kind: 'nexus.mission-code-baseline', version: 1, scopeHash: scopeHash(this.#binding.scope), baseline: input }),
        KEY, input.observedAt,
      );
      inserted = true;
      return Object.freeze(input);
    }).immediate();
    if (inserted) this.#binding.emitChange();
    return baseline;
  }

  /** executionRoot is the current Main-authoritative canonical execution root. */
  read(missionId: string, executionRoot: string): MissionCodeBaseline | null {
    z.string().min(1).max(128).parse(missionId);
    return this.readFromDatabase(this.#binding.readDatabase(), missionId, executionRootHash(executionRoot));
  }

  private readFromDatabase(db: ReturnType<ScopedStoreBinding['readDatabase']>, missionId: string, rootHash: string): MissionCodeBaseline | null {
    const raw = db.prepare(`SELECT event_type, origin, run_id, payload_json, occurred_at FROM mission_events
      WHERE mission_id = ? AND idempotency_key = ?`).get(missionId, KEY);
    if (raw === undefined) return null;
    try {
      const row = rowSchema.parse(raw);
      const payload = payloadSchema.parse(JSON.parse(row.payload_json));
      if (payload.scopeHash !== scopeHash(this.#binding.scope) || payload.baseline.executionRootHash !== rootHash || row.occurred_at !== payload.baseline.observedAt) {
        throw new Error('mission code baseline binding mismatch');
      }
      return Object.freeze(payload.baseline);
    } catch (cause) { throw new ScopedStoreCorruptionError('mission code baseline', { cause }); }
  }
}

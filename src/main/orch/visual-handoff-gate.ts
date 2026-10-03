import type { ProjectExecutionScope } from '../../shared/types';
import { requiresDesignAuthority } from '../../shared/mission-work-kind';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import type { VisualTaskRequirement } from '../../shared/orch-types';

export type { VisualTaskRequirement } from '../../shared/orch-types';
export interface VisualHandoffContext {
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly executionScope?: Readonly<ProjectExecutionScope>;
  readonly sessionId?: string;
  readonly missionId?: string;
  readonly workerIncarnationId?: string;
  readonly visualTask?: VisualTaskRequirement;
}
export type VisualHandoffVerdict = { readonly required: false; readonly verified: true } |
  { readonly required: true; readonly verified: false; readonly reason: string } |
  { readonly required: true; readonly verified: true; readonly artifactId: string; readonly sha256: string };

/** Only the Main assignment/immutable task is classified, never the reported result. */
export function visualTaskRequirement(assignment: string | undefined, now = Date.now()): VisualTaskRequirement | undefined {
  return assignment && requiresDesignAuthority(assignment.slice(0, 16_384)) ? Object.freeze({ since: now }) : undefined;
}

/** A supplied undefined is Main's negative classification, before adding boilerplate. */
export function visualTaskAtSpawn(input: {
  role?: string; visualTask?: VisualTaskRequirement; initialPrompt?: string;
}): VisualTaskRequirement | undefined {
  if (input.role === 'orchestrator') return undefined;
  return Object.hasOwn(input, 'visualTask') ? input.visualTask : visualTaskRequirement(input.initialPrompt);
}

/** Called after an authorized native browser capture, not from tool arguments. */
export function recordVisualHandoffEvidence(ctx: VisualHandoffContext, artifactId: string,
  manager = getMissionEventRuntimeManager()): boolean {
  if (!manager || !ctx.sessionId) return false;
  const runtime = manager.open(ctx.scope);
  const row = runtime.db.prepare(`SELECT mission_id, created_at FROM browser_artifacts
    WHERE id = ? AND artifact_type = 'screenshot'`).get(artifactId) as { mission_id: string | null; created_at: number } | undefined;
  if (!row || row.mission_id !== (ctx.missionId ?? null)) return false;
  runtime.assertWritable();
  const result = runtime.db.prepare(`INSERT OR IGNORE INTO visual_handoff_evidence
    (artifact_id, mission_id, session_id, worker_incarnation_id, execution_root, captured_at) VALUES (?,?,?,?,?,?)`)
    .run(artifactId, ctx.missionId ?? null, ctx.sessionId, ctx.workerIncarnationId ?? null,
      ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath, row.created_at);
  return result.changes === 1;
}

export async function checkVisualHandoff(ctx: VisualHandoffContext, options: {
  manager?: ProjectRuntimeManager | null;
  task?: { readonly plannedTitle: string; readonly plannedDetail: string; readonly task: { readonly createdAt: number } } | null;
  assertCurrent?: () => void;
} = {}): Promise<VisualHandoffVerdict> {
  const requirement = ctx.visualTask ?? (options.task ? visualTaskRequirement(`${options.task.plannedTitle}\n${options.task.plannedDetail}`, options.task.task.createdAt) : undefined);
  const initialAssignment = ctx.visualTask;
  if (!requirement) return { required: false, verified: true };
  const missing = (): VisualHandoffVerdict => ({ required: true, verified: false,
    reason: 'A tarefa visual ainda precisa de uma captura do navegador do Nexus feita por este worker nesta execução.' });
  const manager = options.manager ?? getMissionEventRuntimeManager();
  if (!manager || !ctx.sessionId) return missing();
  options.assertCurrent?.();
  const runtime = manager.open(ctx.scope);
  const rows = runtime.db.prepare(`SELECT artifact_id FROM visual_handoff_evidence
    WHERE session_id = ? AND mission_id IS ? AND worker_incarnation_id IS ? AND execution_root = ? AND captured_at >= ?
    ORDER BY captured_at DESC LIMIT 4`).all(ctx.sessionId, ctx.missionId ?? null, ctx.workerIncarnationId ?? null,
    ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath, requirement.since) as Array<{ artifact_id: string }>;
  const store = createScopedBrowserArtifactStore(manager, ctx.scope);
  for (const row of rows) {
    const artifact = await store.verifiedScreenshot(row.artifact_id, options.assertCurrent);
    options.assertCurrent?.();
    if (ctx.visualTask !== initialAssignment) return missing();
    if (artifact && artifact.missionId === (ctx.missionId ?? null) && artifact.capturedAt >= requirement.since) {
      return { required: true, verified: true, artifactId: artifact.id, sha256: artifact.sha256 };
    }
  }
  return missing();
}

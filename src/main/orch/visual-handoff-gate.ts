import type { ProjectExecutionScope } from '../../shared/types';
import { createHash, randomUUID } from 'node:crypto';
import { classifyWorkKind, requiresDesignAuthority } from '../../shared/mission-work-kind';
import { isUiWorkText } from '../../shared/ui-work-signal';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import type { VisualTaskRequirement } from '../../shared/orch-types';
import { createScopedTaskStore } from './task-store';
import { withoutMountedPromptContextBlocks } from './prompt-context-blocks';

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
export function createVisualTaskRequirement(now = Date.now(), id: string = randomUUID()): VisualTaskRequirement {
  return Object.freeze({ since: now, id });
}
export function visualTaskRequirement(assignment: string | undefined, now = Date.now(), id?: string): VisualTaskRequirement | undefined {
  if (!assignment) return undefined;
  // F-1271: os blocos de contexto montados na frente (<business-model> com as
  // invariantes de UI do projeto, <workspace-memory>…) não são a tarefa.
  const text = withoutMountedPromptContextBlocks(assignment).slice(0, 16_384);
  // A UI defect is still a visual delivery. Requiring a capture does not
  // reclassify it as new design work or grant design-authority capabilities.
  const required = requiresDesignAuthority(text) || (classifyWorkKind(text).kind === 'bug' && isUiWorkText(text));
  return required ? createVisualTaskRequirement(now, id) : undefined;
}

type VisualPlannedTask = { readonly taskId?: string; readonly plannedTitle: string; readonly plannedDetail: string;
  readonly task: { readonly createdAt: number } };
function plannedRequirement(ctx: VisualHandoffContext, task?: VisualPlannedTask | null): VisualTaskRequirement | undefined {
  if (!task) return undefined;
  const id = `plan-${createHash('sha256').update(JSON.stringify([ctx.scope.installationId, ctx.scope.projectId,
    ctx.scope.checkoutId, ctx.sessionId, ctx.workerIncarnationId, task.taskId, task.task.createdAt,
    task.plannedTitle, task.plannedDetail])).digest('hex')}`;
  return visualTaskRequirement(`${task.plannedTitle}\n${task.plannedDetail}`, task.task.createdAt, id);
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
  let requirement = ctx.visualTask;
  if (!requirement && ctx.missionId) {
    const bound = runtime.db.prepare(`SELECT task_id FROM task_dispatch_queue
      WHERE mission_id = ? AND session_id = ? AND worker_incarnation_id IS ? LIMIT 2`)
      .all(ctx.missionId, ctx.sessionId, ctx.workerIncarnationId ?? null) as Array<{ task_id: string }>;
    if (bound.length === 1) requirement = plannedRequirement(ctx, createScopedTaskStore(manager, ctx.scope).getPlannedTask(bound[0].task_id));
  }
  if (!requirement) return false;
  const row = runtime.db.prepare(`SELECT mission_id, created_at FROM browser_artifacts
    WHERE id = ? AND artifact_type = 'screenshot'`).get(artifactId) as { mission_id: string | null; created_at: number } | undefined;
  if (!row || row.mission_id !== (ctx.missionId ?? null)) return false;
  runtime.assertWritable();
  const result = runtime.db.prepare(`INSERT OR IGNORE INTO visual_handoff_evidence
    (artifact_id, mission_id, session_id, worker_incarnation_id, execution_root, captured_at, assignment_id) VALUES (?,?,?,?,?,?,?)`)
    .run(artifactId, ctx.missionId ?? null, ctx.sessionId, ctx.workerIncarnationId ?? null,
      ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath, row.created_at, requirement.id);
  return result.changes === 1;
}

export async function checkVisualHandoff(ctx: VisualHandoffContext, options: {
  manager?: ProjectRuntimeManager | null;
  task?: VisualPlannedTask | null;
  assertCurrent?: () => void;
} = {}): Promise<VisualHandoffVerdict> {
  const requirement = ctx.visualTask ?? plannedRequirement(ctx, options.task);
  const initialAssignment = ctx.visualTask;
  if (!requirement) return { required: false, verified: true };
  const missing = (): VisualHandoffVerdict => ({ required: true, verified: false,
    reason: 'A tarefa visual ainda precisa de uma captura do navegador do Nexus feita por este worker nesta execução.' });
  const manager = options.manager ?? getMissionEventRuntimeManager();
  if (!manager || !ctx.sessionId) return missing();
  options.assertCurrent?.();
  const runtime = manager.open(ctx.scope);
  const rows = runtime.db.prepare(`SELECT artifact_id FROM visual_handoff_evidence
    WHERE session_id = ? AND mission_id IS ? AND worker_incarnation_id IS ? AND execution_root = ? AND assignment_id = ?
    ORDER BY captured_at DESC LIMIT 4`).all(ctx.sessionId, ctx.missionId ?? null, ctx.workerIncarnationId ?? null,
    ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath, requirement.id) as Array<{ artifact_id: string }>;
  const store = createScopedBrowserArtifactStore(manager, ctx.scope);
  for (const row of rows) {
    const artifact = await store.verifiedScreenshot(row.artifact_id, options.assertCurrent);
    options.assertCurrent?.();
    if (ctx.visualTask !== initialAssignment) return missing();
    if (artifact && artifact.missionId === (ctx.missionId ?? null)) {
      return { required: true, verified: true, artifactId: artifact.id, sha256: artifact.sha256 };
    }
  }
  return missing();
}

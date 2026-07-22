import { ipcMain } from 'electron';
import {
  CONTEXT_DRAFT_CHANNELS,
  approveContextDraftInputSchema,
  approveContextDraftResultSchema,
  pendingContextDraftSchema,
  type ApproveContextDraftResult,
  type PendingContextDraft,
} from '../../shared/context-draft-types';
import { resolveProjectExecutionScope } from '../persistence/project-identity';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';
import type { ContextAttestationActor } from './context-attestation';
import {
  getContextKnowledgeService,
  getContextWorkflowService,
} from './context-workflow-registry';

/**
 * The local human operator IS an independent reviewer: draft authors are
 * agent sessions, so a UI approval by the user satisfies the same
 * author≠reviewer / cross-provider independence the CLI reviewer quorum
 * enforces. The `human` provider label is what the attestation records.
 */
export const HUMAN_CONTEXT_REVIEWER: ContextAttestationActor = Object.freeze({
  id: 'user:local-operator',
  sessionId: 'human-ui-context-review',
  provider: 'human',
});

function requireActiveScope() {
  const workspace = activeWorkspaceOrNull();
  if (!workspace) throw new Error('no workspace is open');
  return resolveProjectExecutionScope(workspace);
}

export function registerContextDraftIpc(): void {
  ipcMain.handle(
    CONTEXT_DRAFT_CHANNELS.listProposed,
    async (): Promise<PendingContextDraft[]> => {
      const scope = requireActiveScope();
      return getContextKnowledgeService(scope)
        .list({ status: 'proposed' })
        .map((draft) =>
          pendingContextDraftSchema.parse({
            id: draft.id,
            missionId: draft.missionId,
            targetPath: draft.targetPath,
            content: draft.content,
            contentHash: draft.contentHash,
            sources: draft.sources,
            authorProvider: draft.author.provider,
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
          }),
        );
    },
  );

  ipcMain.handle(
    CONTEXT_DRAFT_CHANNELS.approve,
    async (_event, raw: unknown): Promise<ApproveContextDraftResult> => {
      const input = approveContextDraftInputSchema.parse(raw);
      const scope = requireActiveScope();
      const knowledge = getContextKnowledgeService(scope);
      const draft = knowledge.get(input.draftId);
      if (!draft) throw new Error('context draft not found');
      if (draft.status !== 'proposed') {
        throw new Error('only a proposed context draft can be approved');
      }
      // review() re-validates the content and re-hashes every source and the
      // target fail-closed before accepting the human decision; apply()
      // materializes the target and writes the portable attestation.
      knowledge.review(draft.id, {
        decision: 'approve',
        reviewer: HUMAN_CONTEXT_REVIEWER,
        rationale:
          input.rationale ??
          'Reviewed and approved by the human operator in the Nexus UI ' +
            '(independent of the agent author).',
      });
      const applied = knowledge.apply(draft.id);
      const readiness = getContextWorkflowService(scope).inspectReadiness();
      return approveContextDraftResultSchema.parse({
        draftId: applied.draft.id,
        targetPath: applied.draft.targetPath,
        status: 'applied' as const,
        attestationId: applied.draft.attestationId,
        attestationPath: applied.attestationPath,
        reviewerProvider: 'human' as const,
        readinessReady: readiness.ready,
        readinessBlockers: readiness.blockers.map((blocker) => blocker.code),
      });
    },
  );
}

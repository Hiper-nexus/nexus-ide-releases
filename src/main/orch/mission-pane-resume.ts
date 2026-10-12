import type { ProjectExecutionScope } from '../../shared/types';
import { getProviderPaneSession } from '../persistence/provider-session-store';
import { getProjectDomainStores } from './project-domain-store-registry';
import { sameExactPaneScope } from './pane-authz';
import { hasLivePaneSession } from './pane-registry';
import { reserveWorkerContinuation, assertWorkerContinuationCurrent, reconcilePreparedWorkerContinuation } from './mission-pane-resume-ownership';

/** A resume names an existing Main-owned conversation, never a new route. */
export function captureMissionPaneResume(
  scope: ProjectExecutionScope,
  missionId: string,
  paneId: string | undefined,
  requested: { adapterId?: string; model?: string; accountId?: string; effort?: string; cwd?: string },
  // F-1388: writer sem conversa retomável mas com worktree viva cai nela
  // como pane novo — a validação de dono/runtime segue, a exigência de
  // provider session é o que muda.
  opts?: { allowMissingConversation?: boolean },
) {
  if (!paneId) throw new Error('resume_unavailable: pane original não encontrado nesta missão');
  const store = getProjectDomainStores(scope).missionPanes;
  const found = store.findByPaneId(paneId);
  const stored = found ? reconcilePreparedWorkerContinuation(found) : null;
  if (!stored || stored.missionId !== missionId || !sameExactPaneScope(stored.scope, scope)) {
    throw new Error('resume_unavailable: pane original não pertence a esta missão e checkout');
  }
  for (const key of ['adapterId', 'model', 'accountId', 'effort', 'cwd'] as const) {
    if (requested[key] !== undefined && requested[key] !== stored[key]) {
      throw new Error(`resume_runtime_mismatch: ${key} deve preservar o registro original do pane`);
    }
  }
  const conversation = getProviderPaneSession(scope, paneId, stored.adapterId, stored.accountId);
  if (!conversation && !opts?.allowMissingConversation) {
    throw new Error('resume_context_unavailable: conversa original indisponível; nenhum pane novo foi iniciado');
  }
  const baseline = JSON.stringify(stored);
  const conversationIdentity = JSON.stringify(conversation);
  if (stored.role === 'worker' && hasLivePaneSession(paneId)) {
    throw new Error('resume_source_live: este worker já está vivo; use nexus_pane_write no pane atual, sem abrir outra continuação');
  }
  const continuation = stored.role === 'worker' ? reserveWorkerContinuation(stored) : undefined;
  return {
    spec: Object.freeze({ ...stored }),
    continuation,
    assertCurrent() {
      if (continuation) { assertWorkerContinuationCurrent(scope, continuation); return; }
      if (JSON.stringify(store.findByPaneId(paneId)) !== baseline ||
          JSON.stringify(getProviderPaneSession(scope, paneId, stored.adapterId, stored.accountId)) !== conversationIdentity) {
        throw new Error('resume_authority_changed: o registro original mudou durante a retomada');
      }
    },
  };
}

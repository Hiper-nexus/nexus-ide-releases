import type { ProjectExecutionScope } from '../../shared/types';
import { getProviderPaneSession } from '../persistence/provider-session-store';
import { getProjectDomainStores } from './project-domain-store-registry';
import { sameExactPaneScope } from './pane-authz';

/** A resume names an existing Main-owned conversation, never a new route. */
export function captureMissionPaneResume(
  scope: ProjectExecutionScope,
  missionId: string,
  paneId: string | undefined,
  requested: { adapterId?: string; model?: string; accountId?: string; effort?: string; cwd?: string },
) {
  if (!paneId) throw new Error('resume_unavailable: pane original não encontrado nesta missão');
  const store = getProjectDomainStores(scope).missionPanes;
  const stored = store.findByPaneId(paneId);
  if (!stored || stored.missionId !== missionId || !sameExactPaneScope(stored.scope, scope)) {
    throw new Error('resume_unavailable: pane original não pertence a esta missão e checkout');
  }
  for (const key of ['adapterId', 'model', 'accountId', 'effort', 'cwd'] as const) {
    if (requested[key] !== undefined && requested[key] !== stored[key]) {
      throw new Error(`resume_runtime_mismatch: ${key} deve preservar o registro original do pane`);
    }
  }
  const conversation = getProviderPaneSession(scope, paneId, stored.adapterId, stored.accountId);
  if (!conversation) throw new Error('resume_context_unavailable: conversa original indisponível; nenhum pane novo foi iniciado');
  const baseline = JSON.stringify(stored);
  const conversationIdentity = JSON.stringify(conversation);
  return {
    spec: Object.freeze({ ...stored }),
    assertCurrent() {
      if (JSON.stringify(store.findByPaneId(paneId)) !== baseline ||
          JSON.stringify(getProviderPaneSession(scope, paneId, stored.adapterId, stored.accountId)) !== conversationIdentity) {
        throw new Error('resume_authority_changed: o registro original mudou durante a retomada');
      }
    },
  };
}

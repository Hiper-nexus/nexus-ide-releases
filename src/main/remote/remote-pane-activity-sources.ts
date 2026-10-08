// MOB-05 (F-1021): liga o feed de atividade do celular aos sinais que o
// desktop JÁ publica — os mesmos do toolbar do pane (pty:stateChange) e da
// caixa "pede você" (agent-waiting-broadcast.ts). Nenhuma detecção nova.
import { tapAgentHookStatus } from '../agent-hooks/hook-ingest';
import { tapAgentSemanticStatus } from '../orch/agent-status';
import { tapSessionExit, tapSessionState } from '../pty/pty-manager';
import { remotePaneActivity, type RemotePaneActivityFeed } from './remote-pane-activity';

let stop: (() => void) | null = null;

export function startRemotePaneActivitySources(
  feed: RemotePaneActivityFeed = remotePaneActivity,
): () => void {
  if (stop) return stop;
  const offs = [
    tapSessionState((sessionId, state) => feed.sessionState(sessionId, state)),
    tapSessionExit((sessionId) => feed.sessionExit(sessionId)),
    tapAgentSemanticStatus((entry) => feed.waiting(entry.sessionId, 'semantic', entry.status)),
    tapAgentHookStatus((sessionId, state) => feed.waiting(sessionId, 'orca', state)),
  ];
  stop = () => {
    for (const off of offs) off();
    stop = null;
  };
  return stop;
}

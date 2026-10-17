import { useMemo } from 'react';
import type { PaneModel } from '../../../shared/types';
import { workingNowLabel, workingSignature } from '../../lib/agent-roster';
import {
  isDeadPaneState,
  retiredScopeKeys,
  withRetiredScopes,
  withWorkingCounts,
  workingCountsByScope,
} from '../../lib/pane-spaces';
import { usePaneParkedStore } from '../../state/pane-parked-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { WorkspaceTabs, type WorkspaceTabsProps } from './WorkspaceTabs';

/**
 * Sinal de "trabalhando agora" dos Terminais.
 *
 * O estado dos panes muda a cada turno de cada agente. Quem assina esse estado
 * re-renderiza com ele — e o `TerminalWorkspace` carrega o grid dos xterms, que
 * não pode refazer o trabalho (nem receber callbacks novos) a cada busy↔idle.
 * Por isso a assinatura mora AQUI, em dois componentes folha — e, mesmo aqui,
 * só pela ASSINATURA do conjunto de quem trabalha: um pane que vai de aguardando
 * a iniciando, ou a encerrado, não muda nada na barra e não a re-renderiza.
 *
 * Estado de apresentação (`displayStates`): o busy segura um instante depois
 * de ociosar, a mesma leitura do rail e do chip da toolbar.
 */
function useWorkingPaneIds(panes: readonly PaneModel[]): ReadonlySet<string> {
  const parked = usePaneParkedStore((state) => state.parked);
  const signature = useSessionStateStore((state) =>
    workingSignature(panes, { states: state.displayStates, parked }),
  );
  return useMemo(
    () => new Set(signature === '' ? [] : signature.split('\n')),
    [signature],
  );
}

/** Abas só com panes mortos; assina a assinatura do conjunto, não cada estado. */
function useRetiredScopeKeys(
  panes: readonly PaneModel[],
  scopeOf: (pane: PaneModel) => string,
): ReadonlySet<string> {
  const signature = useSessionStateStore((state) =>
    [
      ...retiredScopeKeys(
        panes,
        scopeOf,
        new Set(
          panes
            .filter((pane) => isDeadPaneState(state.paneStates.get(pane.id)))
            .map((pane) => pane.id),
        ),
      ),
    ]
      .sort()
      .join('\n'),
  );
  return useMemo(
    () => new Set(signature === '' ? [] : signature.split('\n')),
    [signature],
  );
}

export interface LiveWorkspaceTabsProps extends WorkspaceTabsProps {
  readonly panes: readonly PaneModel[];
  /** A aba de cada pane, com a casa das missões hospedadas já resolvida. */
  readonly scopeOf: (pane: PaneModel) => string;
}

/** A barra de abas, com a contagem de quem trabalha em cada uma. */
export function LiveWorkspaceTabs({
  panes,
  scopeOf,
  scopes,
  ...tabs
}: LiveWorkspaceTabsProps) {
  const working = useWorkingPaneIds(panes);
  const retired = useRetiredScopeKeys(panes, scopeOf);
  const liveScopes = useMemo(
    () =>
      withRetiredScopes(
        withWorkingCounts(scopes, workingCountsByScope(panes, scopeOf, working)),
        retired,
      ),
    [scopes, panes, scopeOf, working, retired],
  );
  return <WorkspaceTabs {...tabs} scopes={liveScopes} />;
}

export interface MissionWorkingChipProps {
  readonly panes: readonly PaneModel[];
  /** Os panes que o cabeçalho desenha; `null` quando não há o que contar. */
  readonly visibleIds: ReadonlySet<string> | null;
}

/**
 * "N trabalhando agora" ao lado do título dos Terminais da missão. Conta só o
 * que a missão desenha: a aba que a hospeda pode ter painéis soltos do operador.
 */
export function MissionWorkingChip({
  panes,
  visibleIds,
}: MissionWorkingChipProps) {
  const working = useWorkingPaneIds(panes);
  let count = 0;
  if (visibleIds) {
    for (const id of visibleIds) if (working.has(id)) count += 1;
  }
  if (count === 0) return null;
  return (
    <span className="terminal-workspace__live">
      <span className="terminal-workspace__live-dot" aria-hidden="true" />
      {workingNowLabel(count)}
      {count > 1 ? ' · em paralelo' : ''}
    </span>
  );
}

import type { PaneModel } from '../../../shared/types';
import type { PaneScopeEntry } from '../../lib/pane-spaces';
import { useSessionStateStore } from '../../state/session-state-store';

/**
 * Entrada do mapa da equipe (o grafo do Quadro) na barra de abas dos
 * Terminais. O mapa só existia dentro do Quadro da missão, e quem trabalha nas
 * abas nem sabia dele (campo 14/10). Aqui ele ganha nome e uma prévia viva:
 * um rack por agente com terminal aberto, no estado do pane.
 *
 * A prévia lê só `displayStates` (muda na transição busy/idle, nunca por byte
 * de saída) e o seletor devolve uma string: pane de outra aba mudando de
 * estado não redesenha nada aqui.
 */

export interface MissionTeamMember {
  readonly paneId: string;
  readonly coordinator: boolean;
}

export interface MissionTeamMap {
  readonly missionId: string;
  readonly title: string;
  readonly members: readonly MissionTeamMember[];
}

/** Acima disso a barra mostra "+N" em vez de alargar. */
const MAX_RACKS = 8;

/**
 * A equipe da missão que mora na aba: a própria missão (aba de missão) ou a
 * hospedada, a que roda primeiro. Membros são os panes de agente da missão,
 * coordenador na frente, como no mapa. Sem agente aberto não há mapa a mostrar.
 */
export function missionTeamOfScope(
  scope: PaneScopeEntry,
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
): MissionTeamMap | null {
  const mission =
    scope.kind === 'mission' && scope.id
      ? { id: scope.id, title: scope.title }
      : (scope.missions.find((hosted) => hosted.state === 'running') ??
        scope.missions[0]);
  if (!mission) return null;
  const members = panes
    .filter(
      (pane) =>
        pane.kind === 'cli-agent' &&
        (pane.missionId ?? paneMissions[pane.id]) === mission.id,
    )
    .map((pane) => ({ paneId: pane.id, coordinator: pane.role === 'orchestrator' }))
    .sort((left, right) => Number(right.coordinator) - Number(left.coordinator));
  return members.length > 0
    ? { missionId: mission.id, title: mission.title, members }
    : null;
}

type RackTone = 'working' | 'starting' | 'idle';

/** Fechado ou dormindo some do mapa; sem estado ainda, o pane está subindo. */
function rackTone(state: string): RackTone | null {
  switch (state) {
    case 'busy':
      return 'working';
    case 'idle':
      return 'idle';
    case 'exited':
    case 'hibernated':
      return null;
    default:
      return 'starting';
  }
}

function teamSummary(racks: readonly { readonly coordinator: boolean; readonly tone: RackTone }[]): string {
  const agents = racks.filter((rack) => !rack.coordinator).length;
  const hasCoordinator = racks.some((rack) => rack.coordinator);
  const agentsText = `${agents} ${agents === 1 ? 'agente' : 'agentes'}`;
  const people = hasCoordinator
    ? agents > 0 ? `coordenador e ${agentsText}` : 'coordenador'
    : agentsText;
  const working = racks.filter((rack) => rack.tone === 'working').length;
  const starting = racks.filter((rack) => rack.tone === 'starting').length;
  const activity = [
    working > 0 ? `${working} trabalhando` : null,
    starting > 0 ? `${starting} iniciando` : null,
  ].filter(Boolean);
  return [people, activity.length > 0 ? activity.join(', ') : 'em espera'].join(', ');
}

export interface MissionTeamMapButtonProps {
  readonly team: MissionTeamMap;
  readonly onOpen: (missionId: string) => void;
}

export function MissionTeamMapButton({ team, onOpen }: MissionTeamMapButtonProps) {
  const states = useSessionStateStore((store) =>
    team.members
      .map((member) => store.displayStates.get(member.paneId) ?? '')
      .join(' '),
  ).split(' ');
  const racks = team.members.flatMap((member, index) => {
    const tone = rackTone(states[index] ?? '');
    return tone ? [{ ...member, tone }] : [];
  });
  const summary = racks.length > 0 ? teamSummary(racks) : 'nenhum terminal aberto';
  const overflow = racks.length - MAX_RACKS;

  return (
    <button
      type="button"
      className="workspace-tabs__team"
      data-live={racks.some((rack) => rack.tone === 'working') || undefined}
      aria-label={`Abrir o mapa da equipe de “${team.title}”: ${summary}`}
      title={`Mapa da equipe · ${team.title}\n${summary}\nOs terminais continuam rodando.`}
      onClick={() => onOpen(team.missionId)}
    >
      <span className="workspace-tabs__team-racks" aria-hidden="true">
        {racks.slice(0, MAX_RACKS).map((rack) => (
          <span
            key={rack.paneId}
            className="workspace-tabs__team-rack"
            data-state={rack.tone}
            data-coordinator={rack.coordinator || undefined}
          />
        ))}
        {overflow > 0 ? <span className="workspace-tabs__team-more">+{overflow}</span> : null}
      </span>
      <span className="workspace-tabs__team-label">Mapa da equipe</span>
    </button>
  );
}

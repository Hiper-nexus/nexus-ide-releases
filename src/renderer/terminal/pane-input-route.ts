/**
 * Lane de entrada de um pane — a MESMA decisão que o teclado toma.
 *
 * Pane de missão não aceita escrita crua do renderer: a posse é do main e
 * `writeSession` recusa agentes orquestrados por design (pty-manager). O
 * teclado já entra pela lane do operador (terminal-host, xterm onData); toda
 * escrita programática no pane (espaço retido do hold-to-talk, comandos de
 * catálogo, agent-attach) precisa da MESMA rota — senão morre em silêncio
 * exatamente como o espaço do toque rápido no voo real de 06/08.
 */
export type PaneInputLane = 'operator' | 'raw';

export function paneInputLane(
  pane:
    | {
        readonly kind?: string;
        readonly missionId?: string | null;
        /**
         * Papel de orquestração do pane. Um pane `worker`/`orchestrator` é
         * governado pelo main MESMO sem missão — o `nexus_pane_spawn` do
         * operador minta o papel sem criar missão (campo 09/09: "não consigo
         * digitar nos panes que o orquestrador abriu"). A lane crua é recusada
         * por design nesses panes; sem o papel aqui a tecla morria em silêncio.
         */
        readonly role?: 'orchestrator' | 'worker';
      }
    | undefined,
  paneMissionIdFromStore: string | undefined,
): PaneInputLane {
  const missionId = pane?.missionId ?? paneMissionIdFromStore;
  const governed = Boolean(missionId) || Boolean(pane?.role);
  return pane?.kind === 'cli-agent' && governed ? 'operator' : 'raw';
}

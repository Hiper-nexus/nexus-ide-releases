import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Espelho da liderança ÚNICA confirmada pelo Main (onda 2 da religação).
 *
 * O Main é a autoridade: `mission.orchestratorSessionId` (A) é o par durável da
 * liderança e `listMissionPanes` (C) é a composição registrada por ele. O
 * renderer NUNCA elege líder — só reflete o que já foi confirmado. Este módulo
 * é a única função de decisão do renderer: dado o snapshot de missões + panes,
 * devolve as ações promote/demote que faltam para o layout concordar com o Main.
 *
 * Por que existe: antes cada sítio do renderer decidia sozinho quem tinha a
 * estrela (o bind por sessão no broadcast, o "primeiro role orchestrator" do
 * reopen, a promoção local do layout-store). Dois deles discordando deixavam
 * DOIS coordenadores na tela enquanto o Main tinha um só — e o operador não tem
 * como saber qual manda.
 */

export interface LeadershipMissionSnapshot {
  readonly id: string;
  /** A: sessão durável do líder. Ausente/null = missão SEM líder confirmado. */
  readonly orchestratorSessionId?: string | null;
}

export interface LeadershipPaneSnapshot {
  readonly paneId: string;
  /** Missão do pane: `pane.missionId` ou o índice local `paneMissions`. */
  readonly missionId?: string;
  readonly role?: string;
  readonly sessionId?: string | null;
}

export interface LeadershipAction {
  readonly missionId: string;
  readonly paneId: string;
  readonly action: 'promote' | 'demote';
}

/**
 * O pane local que o Main confirma como líder da missão, ou null.
 *
 * A confirmação é o par (missão, sessão durável): `role` no layout NUNCA basta.
 * Sem A não há líder confirmado; duas panes carregando a mesma sessão é
 * ambiguidade do Main — fail-closed, ninguém recebe a estrela.
 */
export function confirmedLeaderPaneId(
  mission: LeadershipMissionSnapshot,
  panes: readonly LeadershipPaneSnapshot[],
): string | null {
  const sessionId = mission.orchestratorSessionId;
  if (!sessionId) return null;
  const matches = panes.filter(
    (pane) => pane.missionId === mission.id && pane.sessionId === sessionId,
  );
  return matches.length === 1 ? matches[0]!.paneId : null;
}

/**
 * Ações idempotentes: promote do líder confirmado, demote de quem carrega a
 * estrela sem bater com o Main. Reaplicar o MESMO snapshot devolve lista vazia,
 * porque depois de aplicado o layout já concorda com o Main.
 */
export function reflectLeadershipActions(input: {
  readonly missions: readonly LeadershipMissionSnapshot[];
  readonly panes: readonly LeadershipPaneSnapshot[];
}): LeadershipAction[] {
  const actions: LeadershipAction[] = [];
  for (const mission of input.missions) {
    const bound = input.panes.filter((pane) => pane.missionId === mission.id);
    if (bound.length === 0) continue;
    const leaderPaneId = confirmedLeaderPaneId(mission, input.panes);
    if (leaderPaneId === null && mission.orchestratorSessionId) {
      // A existe, mas nenhuma pane local carrega esta sessão: o painel ainda
      // não anexou (boot, troca de workspace) ou o Main está à frente do
      // renderer. NÃO demove: apagar a estrela aqui derruba a do coordenador
      // vivo enquanto o PTY conecta, e o próximo broadcast pode nunca chegar
      // depois do attach.
      //
      // ponytail: teto conhecido — uma associação stale sobrevive até o próximo
      // broadcast COM a sessão. O upgrade é casar também pelo paneId selado que
      // `listMissionPanes` (C) devolve, em vez de só pela sessão (A).
      continue;
    }
    for (const pane of bound) {
      const isLeader = pane.paneId === leaderPaneId;
      if (isLeader && pane.role !== 'orchestrator') {
        actions.push({
          missionId: mission.id,
          paneId: pane.paneId,
          action: 'promote',
        });
      } else if (!isLeader && pane.role === 'orchestrator') {
        actions.push({
          missionId: mission.id,
          paneId: pane.paneId,
          action: 'demote',
        });
      }
    }
  }
  return actions;
}

/**
 * Snapshot do layout + índice local. `paneMissions` entra só como CLASSIFICAÇÃO
 * (a que missão esta pane pertence) — nunca como votação de liderança.
 */
export function snapshotLeadershipPanes(): LeadershipPaneSnapshot[] {
  const paneMissions = useOrchStore.getState().paneMissions;
  return listPanes(useLayoutStore.getState().root).map((pane) => ({
    paneId: pane.id,
    missionId: pane.missionId ?? paneMissions[pane.id],
    role: pane.role,
    sessionId: getPaneSessionId(pane.id),
  }));
}

/**
 * Escreve no layout o que `reflectLeadershipActions` decidiu. Uma única
 * operação idempotente por missão afetada: promover o líder e rebaixar os
 * demais é o MESMO espelho, não duas escritas.
 *
 * Devolve quantas ações foram necessárias (0 = layout já concordava).
 */
export function applyLeadershipReflection(input: {
  readonly missions: readonly LeadershipMissionSnapshot[];
  readonly panes: readonly LeadershipPaneSnapshot[];
}): number {
  const actions = reflectLeadershipActions(input);
  if (actions.length === 0) return 0;
  const affected = new Set(actions.map((action) => action.missionId));
  for (const mission of input.missions) {
    if (!affected.has(mission.id)) continue;
    useLayoutStore
      .getState()
      .reflectMissionLeader(
        mission.id,
        confirmedLeaderPaneId(mission, input.panes),
      );
  }
  return actions.length;
}

/** Snapshot + escrita, para os sítios que já têm o snapshot de missões em mão. */
export function reflectLeadershipFromMissions(
  missions: readonly LeadershipMissionSnapshot[],
): number {
  return applyLeadershipReflection({
    missions,
    panes: snapshotLeadershipPanes(),
  });
}

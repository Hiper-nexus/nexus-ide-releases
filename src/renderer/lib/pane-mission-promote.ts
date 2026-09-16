import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { askChoice } from '../state/choice-store';
import { useToastStore } from '../state/toast-store';
import { listPanes } from './split-tree';
import { usePendingOrchestratorAdoptionStore } from '../state/pending-orchestrator-adoption-store';

/**
 * F-527: promoção de pane a orquestrador com vínculo EXPLÍCITO de missão.
 *
 * Antes: pane sem missão caía em `activeMissions.find(running|blocked) ??
 * activeMissions[0]` — anexado silenciosamente à "missão padrão". Com duas
 * missões rolando, o pane entrava na missão errada e os panes das duas se
 * misturavam no grid. Agora:
 *  - vínculo inequívoco (pane/destination/paneMissions) → promove direto;
 *  - pane solto com missões ativas → DIÁLOGO: escolher a missão ou abrir uma
 *    nova (separada por construção);
 *  - sem missões ativas → confirma e abre o caminho expresso de nova missão.
 */

/** Valor sentinel da opção "abrir nova missão" no diálogo. */
export const PROMOTE_NEW_MISSION = '__new_mission__';

export type PanePromoteTarget =
  | { readonly kind: 'mission'; readonly missionId: string }
  | {
      readonly kind: 'choose';
      readonly missions: ReadonlyArray<{
        id: string;
        title: string;
        status: string;
      }>;
    }
  | { readonly kind: 'no-mission' };

/** Status de missão que ainda pode receber um orquestrador. */
const ACTIVE_MISSION_STATUSES = new Set(['setup', 'running', 'blocked']);

export function resolvePanePromoteTarget(input: {
  readonly paneMissionId?: string;
  readonly destinationMissionId?: string;
  readonly boundMissionId?: string;
  readonly missions: ReadonlyArray<{ id: string; title: string; status: string }>;
}): PanePromoteTarget {
  const active = input.missions.filter((m) =>
    ACTIVE_MISSION_STATUSES.has(m.status),
  );
  const bound =
    input.paneMissionId ?? input.destinationMissionId ?? input.boundMissionId;
  // F-561: o vínculo só vence se a missão AINDA PODE receber um orquestrador.
  // Antes qualquer id passava — abrir uma missão `done` e clicar "Tornar
  // orquestrador" carimbava o pane numa missão encerrada (ou inexistente), e o
  // main recusava sem que o operador visse. Vínculo morto cai na escolha.
  if (bound && active.some((m) => m.id === bound)) {
    return { kind: 'mission', missionId: bound };
  }
  if (active.length > 0) return { kind: 'choose', missions: active };
  return { kind: 'no-mission' };
}

/**
 * Corpo comum da promoção (IPC main + layout + vínculo), sem UI.
 *
 * F-561: a recusa do main é FINAL. Antes o resultado era descartado e o layout
 * promovia mesmo assim — o pane ganhava a estrela de orquestrador enquanto o
 * main não o reconhecia como tal. Esse é o orquestrador órfão: a UI dizia que
 * havia um líder, o motor não tinha nenhum, e o operador só descobria quando
 * nada acontecia. Quem manda no papel é a autoridade de missão.
 *
 * Devolve `true` só quando o main confirmou.
 */
export async function promotePaneToMissionOrchestrator(
  missionId: string,
  paneId: string,
): Promise<boolean> {
  const promote = window.nexus?.orch?.promoteMissionOrchestrator;
  if (!promote) {
    console.warn(
      `[promote] sem bridge de missão — pane=${paneId} mission=${missionId}`,
    );
    return false;
  }
  let result: { ok?: boolean; error?: string } | undefined;
  try {
    result = (await promote({ missionId, paneId })) as
      | { ok?: boolean; error?: string }
      | undefined;
  } catch (error) {
    console.warn(
      `[promote] IPC falhou pane=${paneId} mission=${missionId}:`,
      error,
    );
    return false;
  }
  if (result?.ok !== true) {
    console.warn(
      `[promote] main recusou pane=${paneId} mission=${missionId} ` +
        `motivo=${result?.error ?? 'desconhecido'}`,
    );
    return false;
  }
  useLayoutStore.getState().promoteMissionPaneRole(missionId, paneId);
  useOrchStore.getState().bindPaneMission(paneId, missionId);
  return true;
}

const MISSION_STATUS_LABEL: Record<string, string> = {
  setup: 'preparando',
  running: 'em andamento',
  blocked: 'bloqueada',
};

/**
 * Fluxo completo de "tornar este pane orquestrador" com a escolha explícita.
 * Devolve a missão promovida (ou null quando cancelado / abriu o wizard).
 */
export async function promotePaneWithMissionChoice(input: {
  readonly paneId: string;
  readonly paneTitle?: string;
}): Promise<string | null> {
  const orch = useOrchStore.getState();
  const destination = useProductNavigationStore.getState().destination;
  // O vínculo GRAVADO no pane é autoridade tão boa quanto o observado — ler só
  // `paneMissions` fazia um pane restaurado do disco (que traz `missionId` no
  // modelo) parecer solto e cair no diálogo à toa.
  const paneMissionId = listPanes(useLayoutStore.getState().root).find(
    (pane) => pane.id === input.paneId,
  )?.missionId;
  const target = resolvePanePromoteTarget({
    paneMissionId,
    destinationMissionId:
      destination.kind === 'mission' ? destination.missionId : undefined,
    boundMissionId: orch.paneMissions[input.paneId],
    missions: orch.missions,
  });

  if (target.kind === 'mission') {
    const promoted = await promotePaneToMissionOrchestrator(
      target.missionId,
      input.paneId,
    );
    if (!promoted) {
      toastPromoteRefused();
      return null;
    }
    return target.missionId;
  }

  if (target.kind === 'no-mission') {
    // F-561: sem missão não existe orquestrador. O diálogo "Nenhuma missão
    // ativa" era um beco sem saída — confirmar abria o wizard e o painel
    // continuava solto. Agora o painel fica MARCADO: o Novo pedido abre, e a
    // missão que nascer adota este painel como Maestro em vez de subir um
    // coordenador em branco. O objetivo é a única coisa que ainda precisa vir
    // do operador — ninguém briefa um Maestro sem saber o que entregar.
    requestPaneAdoptionForNextMission(input.paneId, input.paneTitle);
    return null;
  }

  const options = target.missions.map((m) => ({
    value: m.id,
    label: m.title || 'Missão sem título',
    detail: MISSION_STATUS_LABEL[m.status] ?? m.status,
  }));
  options.push({
    value: PROMOTE_NEW_MISSION,
    label: 'Nova missão deste painel',
    detail: 'Cria uma missão separada — abre o caminho expresso',
  });
  const picked = await askChoice({
    title: 'Este painel lidera qual missão?',
    body:
      'Este painel não pertence a uma missão. Escolher a missão errada mistura ' +
      'os panes de missões diferentes — a escolha é sua, não do sistema.',
    options,
  });
  if (picked === null) return null;
  if (picked === PROMOTE_NEW_MISSION) {
    requestPaneAdoptionForNextMission(input.paneId, input.paneTitle);
    return null;
  }
  const promoted = await promotePaneToMissionOrchestrator(picked, input.paneId);
  if (!promoted) {
    toastPromoteRefused();
    return null;
  }
  return picked;
}

/**
 * Recusa VISÍVEL. O silêncio era metade do bug: o main negava, a UI promovia
 * assim mesmo, e o operador ficava com uma estrela de orquestrador que não
 * comandava nada.
 */
export function toastPromoteRefused(): void {
  useToastStore.getState().push(
    'error',
    'Não foi possível definir o orquestrador',
    'A missão não aceitou este painel como líder. Abra a missão pelo Quadro e ' +
      'tente de novo, ou crie uma nova missão.',
  );
}

/**
 * Marca o painel para liderar a PRÓXIMA missão e leva o operador ao Novo
 * pedido. Três pontos de entrada usam isto: o menu do pane, a barra e o ⌘K.
 */
export function requestPaneAdoptionForNextMission(
  paneId: string,
  paneTitle?: string,
): void {
  usePendingOrchestratorAdoptionStore.getState().request({
    paneId,
    paneTitle: paneTitle ?? null,
  });
  useProductNavigationStore.getState().openNewMission();
  useToastStore.getState().push(
    'info',
    'Este painel vai liderar',
    'Descreva o que a missão deve entregar. Quando ela começar, é este painel ' +
      'que assume como coordenador — nenhum terminal novo é aberto.',
  );
}

/** Toast padrão de sucesso usado pelos três pontos de entrada. */
export function toastPromoted(missionTitle: string | undefined): void {
  useToastStore.getState().push(
    'success',
    'Orquestrador definido',
    missionTitle
      ? `Este painel agora lidera “${missionTitle}”.`
      : 'Este painel agora é o orquestrador líder.',
  );
}

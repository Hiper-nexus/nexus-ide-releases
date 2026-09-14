import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { askChoice } from '../state/choice-store';
import { askConfirm } from '../state/confirm-store';
import { useToastStore } from '../state/toast-store';

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
  const bound =
    input.paneMissionId ?? input.destinationMissionId ?? input.boundMissionId;
  if (bound) return { kind: 'mission', missionId: bound };
  const active = input.missions.filter((m) => ACTIVE_MISSION_STATUSES.has(m.status));
  if (active.length > 0) return { kind: 'choose', missions: active };
  return { kind: 'no-mission' };
}

/** Corpo comum da promoção (IPC main + layout + vínculo), sem UI. */
export async function promotePaneToMissionOrchestrator(
  missionId: string,
  paneId: string,
): Promise<void> {
  try {
    await window.nexus?.orch?.promoteMissionOrchestrator?.({
      missionId,
      paneId,
    });
  } catch {
    // Promoção direta de layout segue se o IPC estiver indisponível.
  }
  useLayoutStore.getState().promoteMissionPaneRole(missionId, paneId);
  useOrchStore.getState().bindPaneMission(paneId, missionId);
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
  const target = resolvePanePromoteTarget({
    paneMissionId: undefined,
    destinationMissionId:
      destination.kind === 'mission' ? destination.missionId : undefined,
    boundMissionId: orch.paneMissions[input.paneId],
    missions: orch.missions,
  });

  if (target.kind === 'mission') {
    await promotePaneToMissionOrchestrator(target.missionId, input.paneId);
    return target.missionId;
  }

  if (target.kind === 'no-mission') {
    const ok = await askConfirm({
      title: 'Nenhuma missão ativa',
      body:
        'Este painel não pertence a uma missão e não há missões em andamento. ' +
        'Abrir uma nova missão para liderar a partir daqui?',
      confirmLabel: 'Abrir nova missão',
    });
    if (ok) useProductNavigationStore.getState().openNewMission();
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
    useProductNavigationStore.getState().openNewMission();
    return null;
  }
  await promotePaneToMissionOrchestrator(picked, input.paneId);
  return picked;
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

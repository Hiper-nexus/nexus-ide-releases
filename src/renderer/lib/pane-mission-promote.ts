import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { askChoice } from '../state/choice-store';
import { useToastStore } from '../state/toast-store';
import { listPanes } from './split-tree';
import { listPaneScopes, paneScopeResolver } from './pane-spaces';
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
 *
 * 0.76.110 — orquestrador POR ABA: antes do diálogo, a aba do pane decide. Aba
 * com missão viva a reusa; aba sem missão ganha a sua, leve (Autopilot, livre,
 * sem squad), liderada por este pane. O diálogo acima só sobra no Hardened.
 */

/** Valor sentinel da opção "abrir nova missão" no diálogo. */
export const PROMOTE_NEW_MISSION = '__new_mission__';
/**
 * Devolvido quando o painel virou coordenador do OPERADOR, sem missão: o papel
 * foi marcado no layout e nenhuma missão foi criada. Quem chama trata como
 * sucesso (toast genérico), não como id de missão.
 */
export const PROMOTE_LOCAL_ORCHESTRATOR = '__local_orchestrator__';

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

/** Nome automático da missão leve: o da aba, que é o nome da feature. */
export function tabMissionTitle(tabTitle: string): string {
  return `Missão · ${tabTitle.trim() || 'Terminais'}`.slice(0, 120);
}

/**
 * A aba do pane: o nome dela e a missão viva que ela já hospeda (a de algum
 * pane do mesmo escopo). `null` quando o pane não está no layout.
 */
function paneTabContext(
  paneId: string,
): { readonly title: string; readonly missionId: string | null } | null {
  const panes = listPanes(useLayoutStore.getState().root);
  const pane = panes.find((candidate) => candidate.id === paneId);
  if (!pane) return null;
  const orch = useOrchStore.getState();
  const scopeOf = paneScopeResolver(panes, orch.paneMissions);
  const key = scopeOf(pane);
  const entry = listPaneScopes({
    panes,
    paneMissions: orch.paneMissions,
    missions: orch.missions.map((m) => ({ id: m.id, title: m.title, state: m.status })),
  }).find((scope) => scope.key === key);
  const missionId =
    entry?.missions.find((hosted) =>
      orch.missions.some(
        (m) => m.id === hosted.id && ACTIVE_MISSION_STATUSES.has(m.status),
      ),
    )?.id ?? null;
  return { title: entry?.title ?? 'Terminais', missionId };
}

type TabMissionOutcome =
  | { readonly kind: 'created'; readonly missionId: string }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unavailable' };

/** Recusas do main que só dizem "este caminho não vale aqui", não "falhou". */
const TAB_MISSION_UNAVAILABLE = new Set(['hardened', 'pane_unavailable']);

/** Cria a missão leve da aba no main e reflete o líder no layout. */
async function createTabMission(
  paneId: string,
  tabTitle: string,
): Promise<TabMissionOutcome> {
  const create = window.nexus?.orch?.createPaneMission;
  if (!create) return { kind: 'unavailable' };
  let result: Awaited<ReturnType<typeof create>> | undefined;
  try {
    result = await create({ paneId, title: tabMissionTitle(tabTitle) });
  } catch (error) {
    console.warn(`[promote] missão da aba falhou pane=${paneId}:`, error);
    return { kind: 'unavailable' };
  }
  const missionId = result?.ok === true ? result.mission?.id : undefined;
  if (!missionId) {
    return TAB_MISSION_UNAVAILABLE.has(result?.error ?? '')
      ? { kind: 'unavailable' }
      : { kind: 'refused' };
  }
  useLayoutStore.getState().promoteMissionPaneRole(missionId, paneId);
  useOrchStore.getState().bindPaneMission(paneId, missionId);
  return { kind: 'created', missionId };
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

  // Orquestrador POR ABA: a aba é a feature, e a missão dela é a do grupo de
  // panes dela. Aba que já hospeda uma missão viva a reusa; aba sem missão
  // ganha a sua, leve, na hora — sem diálogo com as missões das OUTRAS abas
  // (escolher uma delas era o que misturava os trabalhos).
  const tab = paneTabContext(input.paneId);
  if (tab?.missionId) {
    const promoted = await promotePaneToMissionOrchestrator(
      tab.missionId,
      input.paneId,
    );
    if (!promoted) {
      toastPromoteRefused();
      return null;
    }
    return tab.missionId;
  }
  if (tab) {
    const created = await createTabMission(input.paneId, tab.title);
    if (created.kind === 'created') return created.missionId;
    if (created.kind === 'refused') {
      toastPromoteRefused();
      return null;
    }
    // 'unavailable' (Hardened, shell sem agente, janela sem bridge): segue o
    // fluxo de antes, com escolha explícita.
  }

  if (target.kind === 'no-mission') {
    // Sem missão nenhuma, o painel vira o coordenador DO OPERADOR: marca o
    // papel no layout e pronto — sem diálogo, sem wizard. É como sempre
    // funcionou antes do F-527 e é o que o operador cobra: a sessão `user` já
    // tem todos os poderes sem missão (spawn, write, terminal, git — modo
    // vibe), então a coroa é só o nome do papel na tela. Mandar para o Novo
    // pedido aqui era trocar um clique por uma tela de criação de missão que
    // ninguém pediu. Quem QUER uma missão a partir deste painel usa a opção
    // "Nova missão deste painel", que existe quando há missões para escolher.
    useLayoutStore.getState().setPaneRole(input.paneId, 'orchestrator');
    return PROMOTE_LOCAL_ORCHESTRATOR;
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

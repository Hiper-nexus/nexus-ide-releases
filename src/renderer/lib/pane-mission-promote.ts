import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { askChoice } from '../state/choice-store';
import { useToastStore } from '../state/toast-store';
import { useSessionStateStore } from '../state/session-state-store';
import { listPanes } from './split-tree';
import { listPaneScopes, paneScopeResolver } from './pane-spaces';
import { usePendingOrchestratorAdoptionStore } from '../state/pending-orchestrator-adoption-store';
import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import type { PaneSessionState } from '../../shared/types';

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
/**
 * F-374: a aba já tem um orquestrador VIVO — as opções do diálogo entre uma
 * missão própria em paralelo e tomar a liderança da que existe.
 */
export const PROMOTE_OWN_MISSION = '__own_mission__';
export const PROMOTE_TAKE_OVER = '__take_over__';

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
  return (await promoteToMission(missionId, paneId)).ok;
}

/** Igual, devolvendo o motivo da recusa do main para a mensagem certa. */
async function promoteToMission(
  missionId: string,
  paneId: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const promote = window.nexus?.orch?.promoteMissionOrchestrator;
  if (!promote) {
    console.warn(
      `[promote] sem bridge de missão — pane=${paneId} mission=${missionId}`,
    );
    return { ok: false };
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
    return { ok: false };
  }
  if (result?.ok !== true) {
    console.warn(
      `[promote] main recusou pane=${paneId} mission=${missionId} ` +
        `motivo=${result?.error ?? 'desconhecido'}`,
    );
    return { ok: false, error: result?.error };
  }
  useLayoutStore.getState().promoteMissionPaneRole(missionId, paneId);
  useOrchStore.getState().bindPaneMission(paneId, missionId);
  return { ok: true };
}

/** Nome automático da missão leve: o da aba, que é o nome da feature. */
export function tabMissionTitle(tabTitle: string): string {
  return `Missão · ${tabTitle.trim() || 'Terminais'}`.slice(0, 120);
}

/**
 * Estado de sessão que ainda pode receber a coroa: o processo existe e atende.
 * `exited`/`hibernated`/ausente é transcript morto — coroá-lo daria um
 * `pane_unavailable` do Main (ou um orquestrador fantasma).
 */
export function isLivePaneSessionState(
  state: PaneSessionState | undefined,
): boolean {
  return state === 'spawning' || state === 'busy' || state === 'idle';
}

/**
 * Quem lidera a missão da aba: o orquestrador do escopo se estiver vivo, senão
 * o pane focado vivo, senão o primeiro vivo. `null` quando nenhum pane da aba
 * tem sessão de IA viva — quem chama pede "Abra uma IA nesta aba".
 *
 * F-996: worker de missão (revisor readOnly, helper aberto pelo Maestro) nunca
 * é escolhido no lugar do orquestrador — foco não é designação. Na queda do
 * líder de 07/10 o revisor Codex focado virou o "orquestrador" da missão e o
 * pane do operador voltou a `user`. Sem orquestrador nem pane do operador
 * vivo, a resposta é `null` (a missão fica sem líder vivo e o operador é
 * avisado), nunca um worker.
 */
export function pickTabMissionLeader<
  T extends { readonly id: string; readonly role?: 'orchestrator' | 'worker' },
>(
  agents: readonly T[],
  options: {
    readonly orchestratorPaneId?: string | null;
    readonly focusedPaneId?: string | null;
    readonly paneStates: ReadonlyMap<string, PaneSessionState>;
  },
): T | null {
  const isLive = (agent: T) =>
    isLivePaneSessionState(options.paneStates.get(agent.id));
  const canLead = (agent: T) => agent.role !== 'worker' && isLive(agent);
  const orchestrator = agents.find(
    (agent) => agent.id === options.orchestratorPaneId && isLive(agent),
  );
  return (
    orchestrator ??
    agents.find((agent) => agent.id === options.focusedPaneId && canLead(agent)) ??
    agents.find(canLead) ??
    null
  );
}

/**
 * A aba do pane: o nome dela e a missão viva que ela já hospeda (a de algum
 * pane do mesmo escopo). `null` quando o pane não está no layout.
 *
 * F-373: "missão viva" é a que tem autoridade de despacho corrente — o mesmo
 * teste que o Main faz antes de aceitar a coroa. Uma parada durável (Dormindo
 * no leftover / Parou pelo operador) continua listada em `hostedMissionIds`,
 * mas não é mais "a missão da aba": coroar nela seria recusado de qualquer
 * jeito, e a aba fica livre para nascer outra.
 */
function paneTabContext(paneId: string): {
  readonly key: string;
  readonly title: string;
  readonly missionId: string | null;
  readonly missionTitle: string | null;
  readonly leader: {
    readonly paneId: string;
    readonly title: string;
    readonly live: boolean;
  } | null;
  readonly hostedMissionIds: readonly string[];
} | null {
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
  // Com duas missões vivas na aba ("Nova missão deste painel"), a da ABA é a
  // que carrega o vínculo `workspaceBinding.tabKey` — a ordem de `orch.missions`
  // (a mais nova primeiro) apontaria a do grupo. Sem vínculo, a primeira
  // elegível na ordem dos panes.
  const eligible = (entry?.missions ?? []).flatMap((hosted) => {
    const mission = orch.missions.find((m) => m.id === hosted.id);
    return mission && hasCurrentDispatchAuthority(mission) ? [mission] : [];
  });
  const mission =
    eligible.find(
      (m) => m.intentContract?.workspaceBinding?.tabKey === key,
    ) ??
    eligible[0] ??
    null;
  const leaderPane =
    mission === null
      ? undefined
      : panes.find(
          (candidate) =>
            candidate.role === 'orchestrator' &&
            (candidate.missionId ?? orch.paneMissions[candidate.id]) ===
              mission.id,
        );
  return {
    key,
    title: entry?.title ?? 'Terminais',
    missionId: mission?.id ?? null,
    missionTitle: mission?.title ?? null,
    leader: leaderPane
      ? {
          paneId: leaderPane.id,
          title: leaderPane.title || leaderPane.id,
          live: isLivePaneSessionState(
            useSessionStateStore.getState().paneStates.get(leaderPane.id),
          ),
        }
      : null,
    hostedMissionIds: entry?.missions.map((hosted) => hosted.id) ?? [],
  };
}

type TabMissionOutcome =
  | { readonly kind: 'created'; readonly missionId: string }
  | { readonly kind: 'refused'; readonly error?: string }
  /** Hardened: missão só com despacho explícito na interface. */
  | { readonly kind: 'hardened' }
  /** O painel não tem sessão de IA viva (morreu, reiniciando, shell). */
  | { readonly kind: 'pane-unavailable' }
  /** Janela sem a bridge de missão. */
  | { readonly kind: 'unavailable' };

/**
 * Pedidos em voo por aba: a segunda promoção na MESMA aba espera a primeira e
 * reusa a missão dela. O Main já resolve isso de forma atômica; aqui é só para
 * não disparar dois pedidos à toa.
 */
const tabMissionsInFlight = new Map<string, Promise<TabMissionOutcome>>();

/** Cria (ou reusa) a missão leve da aba no main e reflete o líder no layout. */
async function createTabMission(
  paneId: string,
  tab: { readonly key: string; readonly title: string },
): Promise<TabMissionOutcome> {
  const pending = tabMissionsInFlight.get(tab.key);
  if (pending) {
    const first = await pending;
    if (first.kind !== 'created') return first;
    return (await promotePaneToMissionOrchestrator(first.missionId, paneId))
      ? first
      : { kind: 'refused' };
  }
  const request = requestTabMission(paneId, tab);
  tabMissionsInFlight.set(tab.key, request);
  try {
    return await request;
  } finally {
    tabMissionsInFlight.delete(tab.key);
  }
}

async function requestTabMission(
  paneId: string,
  tab: { readonly key: string; readonly title: string },
  options?: { readonly ownGroup?: boolean; readonly paneTitle?: string },
): Promise<TabMissionOutcome> {
  const create = window.nexus?.orch?.createPaneMission;
  if (!create) return { kind: 'unavailable' };
  let result: Awaited<ReturnType<typeof create>> | undefined;
  try {
    result = await create({
      paneId,
      title: uniqueMissionTitle(
        tabMissionTitle(options?.paneTitle?.trim() || tab.title),
      ),
      tabKey: tab.key,
      ...(options?.ownGroup ? { ownGroup: true } : {}),
    });
  } catch (error) {
    console.warn(`[promote] missão da aba falhou pane=${paneId}:`, error);
    return { kind: 'refused' };
  }
  const missionId = result?.ok === true ? result.mission?.id : undefined;
  if (!missionId) {
    if (result?.error === 'hardened') return { kind: 'hardened' };
    if (result?.error === 'pane_unavailable') return { kind: 'pane-unavailable' };
    return { kind: 'refused', error: result?.error };
  }
  useLayoutStore.getState().promoteMissionPaneRole(missionId, paneId);
  useOrchStore.getState().bindPaneMission(paneId, missionId);
  return { kind: 'created', missionId };
}

/**
 * F-374: missão própria do pane numa aba que já tem orquestrador vivo. Chama o
 * Main DIRETO — nunca por `createTabMission`/`tabMissionsInFlight`: o in-flight
 * da aba existe para a missão DA ABA e uma missão de grupo não se junta a ela
 * (nem a registra: entraria na mesma chave e a segunda criação da aba acharia
 * a missão do grupo).
 */
async function createOwnPaneMission(
  paneId: string,
  tab: { readonly key: string; readonly title: string },
  paneTitle?: string,
): Promise<TabMissionOutcome> {
  return requestTabMission(paneId, tab, { ownGroup: true, paneTitle });
}

/**
 * Duas "Missão · Checkout" no rail são indistinguíveis. O sufixo " 2", " 3"…
 * sai do primeiro livre e nunca passa de 120 caracteres (o máximo do schema
 * do Main) — o corte é na base, não no título final.
 */
function uniqueMissionTitle(base: string): string {
  const taken = new Set(
    useOrchStore.getState().missions.map((mission) => mission.title),
  );
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = ` ${index}`;
    const title = `${base.slice(0, 120 - suffix.length)}${suffix}`;
    if (!taken.has(title)) return title;
  }
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
  const promotedPane = listPanes(useLayoutStore.getState().root).find(
    (pane) => pane.id === input.paneId,
  );
  const paneMissionId = promotedPane?.missionId;
  const tab = paneTabContext(input.paneId);
  // A página de missão aberta (⌘K com a missão X na tela) só vincula um pane
  // que já mora na aba de X — nunca prende o pane de OUTRA aba à X.
  const destinationMissionId =
    destination.kind === 'mission' &&
    (!tab || tab.hostedMissionIds.includes(destination.missionId))
      ? destination.missionId
      : undefined;
  const target = resolvePanePromoteTarget({
    paneMissionId,
    destinationMissionId,
    boundMissionId: orch.paneMissions[input.paneId],
    missions: orch.missions,
  });

  if (target.kind === 'mission') {
    const promoted = await promoteToMission(target.missionId, input.paneId);
    if (!promoted.ok) {
      toastPromoteRefused(promoted.error);
      return null;
    }
    return target.missionId;
  }

  // Orquestrador POR ABA: a aba é a feature, e a missão dela é a do grupo de
  // panes dela. Aba que já hospeda uma missão viva a reusa; aba sem missão
  // ganha a sua, leve, na hora — sem diálogo com as missões das OUTRAS abas
  // (escolher uma delas era o que misturava os trabalhos).
  if (tab?.missionId) {
    // F-374: a missão da aba já é liderada por um pane VIVO e não é este. Tomar
    // a coroa em silêncio rebaixava o Maestro vigente a terminal comum — era o
    // que o operador via quando queria uma segunda missão. A escolha é dele.
    const leader = tab.leader;
    if (leader?.live && leader.paneId !== input.paneId) {
      const picked = await askChoice({
        title: 'Esta aba já tem uma missão rodando',
        body:
          `“${tab.missionTitle ?? tab.title}” é liderada por “${leader.title}”. ` +
          'Este painel pode começar uma missão própria, em paralelo, ou assumir a liderança dessa.',
        options: [
          {
            value: PROMOTE_OWN_MISSION,
            label: 'Nova missão deste painel',
            detail:
              'As duas missões seguem nesta aba, cada uma com o seu orquestrador.',
            primary: true,
          },
          {
            value: PROMOTE_TAKE_OVER,
            label: 'Assumir a liderança',
            detail: `“${leader.title}” deixa de coordenar e volta a ser um terminal comum.`,
          },
        ],
      });
      if (picked === null) return null;
      if (picked === PROMOTE_OWN_MISSION) {
        const created = await createOwnPaneMission(
          input.paneId,
          tab,
          promotedPane?.title ?? input.paneTitle,
        );
        switch (created.kind) {
          case 'created':
            return created.missionId;
          case 'refused':
            toastPromoteRefused(created.error);
            return null;
          case 'pane-unavailable':
            toastPaneWithoutLiveAgent();
            return null;
          case 'hardened':
            requestPaneAdoptionForNextMission(input.paneId, input.paneTitle);
            return null;
          case 'unavailable':
            toastPromoteRefused();
            return null;
        }
      }
      // PROMOTE_TAKE_OVER segue no promoteToMission abaixo.
    }
    const promoted = await promoteToMission(tab.missionId, input.paneId);
    if (!promoted.ok) {
      toastPromoteRefused(promoted.error);
      return null;
    }
    return tab.missionId;
  }
  if (tab) {
    const created = await createTabMission(input.paneId, tab);
    if (created.kind === 'created') return created.missionId;
    if (created.kind === 'refused') {
      toastPromoteRefused(created.error);
      return null;
    }
    if (created.kind === 'pane-unavailable') {
      toastPaneWithoutLiveAgent();
      return null;
    }
    // Hardened ou janela sem bridge: segue o fluxo de antes, com escolha
    // explícita.
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
export function toastPromoteRefused(error?: string): void {
  useToastStore.getState().push(
    'error',
    'Não foi possível definir o orquestrador',
    error === 'pane_mission_mismatch'
      ? 'Este painel ainda pertence a outra missão. Encerre-a pelo Quadro ou ' +
          'use outro painel desta aba.'
      : error === 'pane_read_only'
        ? 'Este painel é somente leitura (revisor/auditor) e não pode liderar a ' +
          'missão. O líder atual continua; para trocar, use um painel seu.'
      : error === 'mission_unavailable'
        ? 'A missão deste painel não está rodando agora. Retome-a pelo Quadro ou ' +
          'use um painel livre para começar outra missão.'
        : 'A missão não aceitou este painel como líder. Abra a missão pelo Quadro e ' +
          'tente de novo, ou crie uma nova missão.',
  );
}

function toastPaneWithoutLiveAgent(): void {
  useToastStore.getState().push(
    'info',
    'O painel não tem sessão de IA viva',
    'Espere a IA do painel terminar de abrir (ou reabra-a) e tente de novo.',
  );
}

/**
 * "Criar missão desta aba" (menu da aba): cria ou reusa a missão DESTA aba,
 * liderada por `paneId`. Sem os desvios de "Tornar orquestrador" — nada de
 * diálogo com missões de outras abas nem coroa local: só anuncia sucesso com
 * missão real. No Hardened abre o fluxo explícito de criação com este painel
 * reservado para liderar.
 */
export async function startTabMissionFor(input: {
  readonly paneId: string;
  readonly paneTitle?: string;
}): Promise<string | null> {
  const tab = paneTabContext(input.paneId);
  if (!tab) return null;
  if (tab.missionId) {
    const promoted = await promoteToMission(tab.missionId, input.paneId);
    if (promoted.ok) return tab.missionId;
    toastPromoteRefused(promoted.error);
    return null;
  }
  const created = await createTabMission(input.paneId, tab);
  switch (created.kind) {
    case 'created':
      return created.missionId;
    case 'hardened':
      requestPaneAdoptionForNextMission(input.paneId, input.paneTitle);
      return null;
    case 'pane-unavailable':
      toastPaneWithoutLiveAgent();
      return null;
    case 'refused':
      toastPromoteRefused(created.error);
      return null;
    case 'unavailable':
      toastPromoteRefused();
      return null;
  }
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

/**
 * Toast padrão de sucesso usado pelos pontos de entrada. Com a missão, ganha o
 * atalho para o mapa da equipe: é o momento em que ele passa a existir.
 */
export function toastPromoted(missionTitle: string | undefined, missionId?: string): void {
  const detail = missionTitle
    ? `Este painel agora lidera “${missionTitle}”.`
    : 'Este painel agora é o orquestrador líder.';
  useToastStore.getState().push(
    'success',
    'Orquestrador definido',
    missionId
      ? {
          detail,
          action: {
            label: 'Ver mapa da equipe',
            onClick: () => useProductNavigationStore.getState().openMission(missionId),
          },
        }
      : detail,
  );
}

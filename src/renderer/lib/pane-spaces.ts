import type { PaneModel } from '../../shared/types';

/**
 * ESCOPO do pane — a resposta para "de quem é este painel?".
 *
 * Um workspace tem UMA árvore de layout. Missão, espaço do operador e painel
 * solto sempre coexistiram nela, mas a vista Terminais só sabia filtrar por
 * missão: qualquer pane sem missão era invisível dentro de uma missão e, na
 * vista global, o filtro DESLIGAVA inteiro (visiblePaneIds === undefined) e
 * desenhava o mosaico completo. Foi assim que "Novo pedido → Montar meus
 * terminais" acabava com os painéis novos grudados na missão já aberta.
 *
 * Aqui o escopo vira uma chave única e total: todo pane pertence a exatamente
 * um escopo, e a vista desenha um escopo de cada vez.
 */
export type PaneScopeKind = 'mission' | 'space' | 'loose';

export interface PaneScopeMission {
  readonly id: string;
  readonly title: string;
  /** Estado da projeção; ausente enquanto o renderer não conhece a missão. */
  readonly state?: string;
}

export interface PaneScopeEntry {
  readonly isolated?: true;
  /** Chave opaca do escopo — é o que a aba guarda e o filtro compara. */
  readonly key: string;
  readonly kind: PaneScopeKind;
  /** Id da missão ou do espaço; ausente no balde de soltos. */
  readonly id?: string;
  readonly title: string;
  readonly paneCount: number;
  /** Estado da missão, quando o renderer já conhece a projeção. */
  readonly state?: string;
  /**
   * Missões que moram nesta aba: a própria (aba de missão) ou as que um pane
   * do operador desta aba adotou (`missionHost`) — a aba é a feature.
   */
  readonly missions: readonly PaneScopeMission[];
  /**
   * Orquestrador do escopo — a missão SEMPRE pode ter um, e a UI precisa
   * mostrá-lo por campo (cada aba tem o seu). `null` quando não há orquestrador
   * neste escopo (campo só de workers/shells).
   */
  readonly orchestrator: { readonly paneId: string; readonly title: string } | null;
}

/** Escopo sentinel de "mostrar a árvore inteira". */
export const ALL_SCOPES_KEY = '__all__';
/** Escopo dos panes sem missão e sem espaço (shells avulsos, restaurados). */
export const LOOSE_SCOPE_KEY = '__loose__';

const MISSION_SCOPE_PREFIX = 'mission:';
const SPACE_SCOPE_PREFIX = 'space:';

const SPACE_TITLE_BASE = 'Meus terminais';
const SPACE_TITLE_PATTERN = /^Meus terminais(?: (\d+))?$/;

export function missionScopeKey(missionId: string): string {
  return `${MISSION_SCOPE_PREFIX}${missionId}`;
}

export function spaceScopeKey(spaceId: string): string {
  return `${SPACE_SCOPE_PREFIX}${spaceId}`;
}

/** O espaço de uma chave `space:<id>`; `null` para missão/soltos. */
export function spaceIdOfScopeKey(key: string): string | null {
  return key.startsWith(SPACE_SCOPE_PREFIX) ? key.slice(SPACE_SCOPE_PREFIX.length) : null;
}

/** Rótulo neutro de missão que o renderer ainda não projetou. */
const UNKNOWN_MISSION_TITLE = 'Missão';
/** A aba dos panes sem espaço: é a casa padrão do checkout. */
export const LOOSE_SCOPE_TITLE = 'Terminais';

/**
 * Casa dos painéis soltos quando o operador tem um coordenador local.
 *
 * O operador abre panes e começa a missão direto por eles: "Tornar
 * orquestrador" num pane sem missão cria o coordenador DO OPERADOR (uma coroa
 * só entre os panes sem missão), que comanda os demais. Os soltos que ele
 * coordena ficavam numa aba e ele em outra, como se fossem trabalhos
 * diferentes. Com coordenador num espaço, os soltos entram no campo dele;
 * espaços nomeados e missões continuam separados.
 */
export function looseHomeScopeKey(
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
): string | null {
  const leader = panes.find(
    (pane) =>
      pane.role === 'orchestrator' &&
      !(pane.missionId ?? paneMissions[pane.id]),
  );
  return leader?.spaceId ? spaceScopeKey(leader.spaceId) : null;
}

/**
 * A aba de cada missão HOSPEDADA por um pane do operador.
 *
 * O operador abre panes numa aba e começa a missão direto por eles: o agente
 * de um pane cria a missão (`nexus_mission_create`) ou o operador adota o pane
 * como orquestrador. A aba é a feature — a missão, o orquestrador e os workers
 * que ele abrir ficam nela, não numa aba separada ao lado dos panes que a
 * começaram (campo 23/09: "todos fazem parte de uma missão só").
 *
 * `missionHost` é carimbado no pane na adoção (`reflectMissionLeader`); a casa
 * é o escopo do pane anfitrião ignorando a missão. Missão lançada pelo
 * assistente não tem anfitrião e segue com a aba própria.
 */
export function missionHomeScopeKeys(
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
  looseHome: string | null = looseHomeScopeKey(panes, paneMissions),
): ReadonlyMap<string, string> {
  const homes = new Map<string, string>();
  const hosts = panes
    .filter((pane) => pane.missionHost && (pane.missionId ?? paneMissions[pane.id]))
    // O orquestrador anfitrião decide; outro pane adotado só na falta dele.
    .sort(
      (left, right) =>
        Number(right.role === 'orchestrator') - Number(left.role === 'orchestrator'),
    );
  for (const host of hosts) {
    const missionId = (host.missionId ?? paneMissions[host.id])!;
    if (homes.has(missionId)) continue;
    homes.set(
      missionId,
      host.spaceId ? spaceScopeKey(host.spaceId) : (looseHome ?? LOOSE_SCOPE_KEY),
    );
  }
  return homes;
}

/**
 * A missão VENCE o espaço. Um pane adotado por uma missão não volta para o
 * espaço em que nasceu só porque o carimbo antigo continua no modelo — senão o
 * painel promovido sumiria da missão que ele lidera. A exceção é a missão com
 * casa (`missionHomes`): ela mora na aba do pane que a começou.
 *
 * `looseHome` (ver looseHomeScopeKey) recebe os panes sem missão e sem espaço.
 */
export function paneScopeKey(
  pane: PaneModel,
  paneMissions: Readonly<Record<string, string>>,
  looseHome: string | null = null,
  missionHomes: ReadonlyMap<string, string> | null = null,
): string {
  const missionId = pane.missionId ?? paneMissions[pane.id];
  if (missionId) return missionHomes?.get(missionId) ?? missionScopeKey(missionId);
  if (pane.spaceId) return spaceScopeKey(pane.spaceId);
  return looseHome ?? LOOSE_SCOPE_KEY;
}

/**
 * O escopo de cada pane com casa de missão e coordenador local resolvidos UMA
 * vez para a árvore inteira. Quem classifica mais de um pane usa isto — cada
 * chamada solta de `paneScopeKey` sem as casas mandaria a missão hospedada
 * para uma aba que não existe.
 */
export function paneScopeResolver(
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
): (pane: PaneModel) => string {
  const looseHome = looseHomeScopeKey(panes, paneMissions);
  const homes = missionHomeScopeKeys(panes, paneMissions, looseHome);
  return (pane) => paneScopeKey(pane, paneMissions, looseHome, homes);
}

export function scopeKeyForPaneId(
  paneId: string | null | undefined,
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
): string | null {
  if (!paneId) return null;
  const pane = panes.find((candidate) => candidate.id === paneId);
  return pane ? paneScopeResolver(panes, paneMissions)(pane) : null;
}

/**
 * Fallback de entrega (ditado, anexos, shell, orquestrador): o primeiro
 * candidato vivo do MESMO escopo do foco. Conteúdo da missão A nunca cai no
 * campo de trabalho da missão B — mesmo que o foco esteja morto, o alvo
 * alternativo só existe dentro do escopo dele.
 *
 * Sem foco (`null`/`undefined` = layout solo) devolve o primeiro candidato.
 * Foco que SUMIU da árvore devolve `null` — tratar "não achei o foco" como
 * "solo" reabriria o vazamento A→B no primeiro pane removido.
 */
export function pickFallbackInScope(
  candidates: readonly string[],
  focusedPaneId: string | null | undefined,
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
): string | null {
  if (candidates.length === 0) return null;
  if (!focusedPaneId) return candidates[0] ?? null;
  const scopeOf = paneScopeResolver(panes, paneMissions);
  const keyOf = (id: string): string | null => {
    const pane = panes.find((candidate) => candidate.id === id);
    return pane ? scopeOf(pane) : null;
  };
  const scope = keyOf(focusedPaneId);
  if (!scope) return null;
  for (const id of candidates) {
    if (keyOf(id) === scope) return id;
  }
  return null;
}

/**
 * Panes de UM escopo. `ALL_SCOPES_KEY` devolve a árvore inteira; escopo que não
 * existe mais devolve VAZIO — nunca a árvore inteira. Um fallback "mostra tudo"
 * aqui é exatamente o bug que esta camada existe para matar: quando o escopo
 * ativo evapora (missão encerrada, espaço fechado), a tela voltaria a misturar
 * os painéis de todo mundo.
 */
export function selectScopePanes(
  panes: readonly PaneModel[],
  scopeKey: string,
  paneMissions: Readonly<Record<string, string>>,
): PaneModel[] {
  if (scopeKey === ALL_SCOPES_KEY) return [...panes];
  const scopeOf = paneScopeResolver(panes, paneMissions);
  return panes.filter((pane) => scopeOf(pane) === scopeKey);
}

export interface ListPaneScopesInput {
  readonly panes: readonly PaneModel[];
  readonly paneMissions: Readonly<Record<string, string>>;
  readonly missions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly state: string;
  }>;
}

/**
 * As abas, na ordem em que os panes aparecem na árvore. Só escopo COM pane vira
 * aba: a aba é o mosaico, não um cadastro. E nenhum pane fica sem aba — missão
 * que o renderer ainda não conhece ganha rótulo neutro em vez de sumir.
 *
 * Cada entrada carrega o orquestrador do próprio campo: duas missões ao lado
 * mostram cada uma o seu, nunca o da vizinha.
 */
export function listPaneScopes(input: ListPaneScopesInput): PaneScopeEntry[] {
  const missionById = new Map(input.missions.map((m) => [m.id, m]));
  const order: string[] = [];
  const byKey = new Map<string, PaneScopeEntry>();
  const orchestratorByKey = new Map<
    string,
    { paneId: string; title: string } | null
  >();

  const scopeOf = paneScopeResolver(input.panes, input.paneMissions);
  const missionsByKey = new Map<string, PaneScopeMission[]>();
  for (const pane of input.panes) {
    const key = scopeOf(pane);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, paneCount: existing.paneCount + 1 });
    } else {
      order.push(key);
      byKey.set(key, scopeEntryFor(key, pane, missionById, input.panes));
      orchestratorByKey.set(key, null);
      missionsByKey.set(key, []);
    }
    if (pane.role === 'orchestrator' && !orchestratorByKey.get(key)) {
      orchestratorByKey.set(key, {
        paneId: pane.id,
        title: pane.title?.trim() || 'Orquestrador',
      });
    }
    const missionId = pane.missionId ?? input.paneMissions[pane.id];
    const hosted = missionsByKey.get(key)!;
    if (missionId && !hosted.some((mission) => mission.id === missionId)) {
      const summary = missionById.get(missionId);
      hosted.push({
        id: missionId,
        title: summary?.title?.trim() || UNKNOWN_MISSION_TITLE,
        ...(summary ? { state: summary.state } : {}),
      });
    }
  }

  const scopes = order.map((key) => {
    const entry = byKey.get(key)!;
    const missions = missionsByKey.get(key) ?? [];
    // Aba de feature que hospeda missão mostra o estado dela (o ponto da aba).
    const hostedState =
      entry.kind !== 'mission' && missions.length > 0
        ? (missions.find((mission) => mission.state === 'running') ?? missions[0])!
            .state
        : undefined;
    return {
      ...entry,
      ...(input.panes.some((pane) => scopeOf(pane) === key && pane.isolateSpace) ? { isolated: true as const } : {}),
      ...(entry.state === undefined && hostedState !== undefined
        ? { state: hostedState }
        : {}),
      missions,
      orchestrator: orchestratorByKey.get(key) ?? null,
    };
  });
  const titleCounts = new Map<string, number>();
  for (const s of scopes) {
    titleCounts.set(s.title, (titleCounts.get(s.title) ?? 0) + 1);
  }
  const duplicates = new Set(
    [...titleCounts.entries()].filter(([, count]) => count > 1).map(([title]) => title),
  );
  if (duplicates.size === 0) return scopes;

  const seenIndices = new Map<string, number>();
  return scopes.map((s) => {
    if (!duplicates.has(s.title)) return s;
    const nextIdx = (seenIndices.get(s.title) ?? 0) + 1;
    seenIndices.set(s.title, nextIdx);
    return { ...s, title: `${s.title} #${nextIdx}` };
  });
}

function scopeEntryFor(
  key: string,
  pane: PaneModel,
  missionById: ReadonlyMap<string, { title: string; state: string }>,
  panes: readonly PaneModel[],
): PaneScopeEntry {
  if (key === LOOSE_SCOPE_KEY) {
    return {
      key,
      kind: 'loose',
      title: LOOSE_SCOPE_TITLE,
      paneCount: 1,
      missions: [],
      orchestrator: null,
    };
  }
  if (key.startsWith(MISSION_SCOPE_PREFIX)) {
    const id = key.slice(MISSION_SCOPE_PREFIX.length);
    const summary = missionById.get(id);
    return {
      key,
      kind: 'mission',
      id,
      title: summary?.title?.trim() || UNKNOWN_MISSION_TITLE,
      paneCount: 1,
      missions: [],
      orchestrator: null,
      ...(summary ? { state: summary.state } : {}),
    };
  }
  const id = key.slice(SPACE_SCOPE_PREFIX.length);
  // O primeiro pane do campo pode ser um solto que entrou no campo do
  // coordenador ou um worker da missão hospedada: o nome vem de quem carrega
  // o carimbo do espaço — o anfitrião da missão inclusive.
  const stamped = pane.spaceId === id
    ? pane
    : panes.find(
        (candidate) =>
          candidate.spaceId === id &&
          (!candidate.missionId || candidate.missionHost === true),
      );
  return {
    key,
    kind: 'space',
    id,
    title: stamped?.spaceTitle?.trim() || SPACE_TITLE_BASE,
    paneCount: 1,
    missions: [],
    orchestrator: null,
  };
}

export function newPaneSpaceId(): string {
  return `space-${crypto.randomUUID()}`;
}

/**
 * Próximo nome livre. Numera só a partir dos rótulos que ainda seguem o padrão
 * — um espaço que o operador renomeou ("Build da API") não deve empurrar a
 * contagem nem ser sobrescrito.
 */
export function nextPaneSpaceTitle(panes: readonly PaneModel[]): string {
  let highest = 0;
  let sawAny = false;
  for (const pane of panes) {
    if (!pane.spaceId) continue;
    sawAny = true;
    const match = SPACE_TITLE_PATTERN.exec(pane.spaceTitle?.trim() ?? '');
    if (!match) continue;
    const ordinal = match[1] ? Number.parseInt(match[1], 10) : 1;
    if (ordinal > highest) highest = ordinal;
  }
  if (!sawAny) return SPACE_TITLE_BASE;
  const next = Math.max(highest, 1) + 1;
  return `${SPACE_TITLE_BASE} ${next}`;
}

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

export interface PaneScopeEntry {
  /** Chave opaca do escopo — é o que a aba guarda e o filtro compara. */
  readonly key: string;
  readonly kind: PaneScopeKind;
  /** Id da missão ou do espaço; ausente no balde de soltos. */
  readonly id?: string;
  readonly title: string;
  readonly paneCount: number;
  /** Estado da missão, quando o renderer já conhece a projeção. */
  readonly state?: string;
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

/** Rótulo neutro de missão que o renderer ainda não projetou. */
const UNKNOWN_MISSION_TITLE = 'Missão';
const LOOSE_TITLE = 'Painéis soltos';

/**
 * A missão VENCE o espaço. Um pane adotado por uma missão não volta para o
 * espaço em que nasceu só porque o carimbo antigo continua no modelo — senão o
 * painel promovido sumiria da missão que ele lidera.
 */
export function paneScopeKey(
  pane: PaneModel,
  paneMissions: Readonly<Record<string, string>>,
): string {
  const missionId = pane.missionId ?? paneMissions[pane.id];
  if (missionId) return missionScopeKey(missionId);
  if (pane.spaceId) return spaceScopeKey(pane.spaceId);
  return LOOSE_SCOPE_KEY;
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
  return panes.filter((pane) => paneScopeKey(pane, paneMissions) === scopeKey);
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
 */
export function listPaneScopes(input: ListPaneScopesInput): PaneScopeEntry[] {
  const missionById = new Map(input.missions.map((m) => [m.id, m]));
  const order: string[] = [];
  const byKey = new Map<string, PaneScopeEntry>();

  for (const pane of input.panes) {
    const key = paneScopeKey(pane, input.paneMissions);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, paneCount: existing.paneCount + 1 });
      continue;
    }
    order.push(key);
    byKey.set(key, scopeEntryFor(key, pane, missionById));
  }

  return order.map((key) => byKey.get(key)!);
}

function scopeEntryFor(
  key: string,
  pane: PaneModel,
  missionById: ReadonlyMap<string, { title: string; state: string }>,
): PaneScopeEntry {
  if (key === LOOSE_SCOPE_KEY) {
    return { key, kind: 'loose', title: LOOSE_TITLE, paneCount: 1 };
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
      ...(summary ? { state: summary.state } : {}),
    };
  }
  const id = key.slice(SPACE_SCOPE_PREFIX.length);
  return {
    key,
    kind: 'space',
    id,
    title: pane.spaceTitle?.trim() || SPACE_TITLE_BASE,
    paneCount: 1,
  };
}

let spaceSeq = 0;

export function newPaneSpaceId(): string {
  spaceSeq += 1;
  return `space-${Date.now().toString(36)}-${spaceSeq}`;
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

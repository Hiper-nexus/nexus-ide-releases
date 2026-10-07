// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: branded MessageId/RunId
// viraram string; threadKey virou scopeKey (missionId+filtro); disclosures de
// work-group removidas (não existem no Nexus); sem overlay de composer os
// chamadores passam inset 0; helpers novos createActivityScopeKey,
// isAtTimelineEnd e resolveTimelineScrollMode para a decisão seguir-no-fim.

export interface ActivityRunObservation {
  readonly scopeKey: string | null;
  readonly hydrated: boolean;
  readonly runId: string | null;
}

/** Opening a scope establishes a baseline; only later runs get new-turn framing. */
export function observeActivityRun(
  previous: ActivityRunObservation | null,
  input: ActivityRunObservation & {
    readonly queued: boolean;
    readonly itemId: string | null;
  },
): { observation: ActivityRunObservation; anchorItemId: string | null } {
  const observation = {
    scopeKey: input.scopeKey,
    hydrated: input.hydrated,
    runId: input.queued ? null : input.runId,
  };
  if (previous?.scopeKey !== input.scopeKey || !previous.hydrated) {
    return { observation, anchorItemId: null };
  }
  if (
    !input.hydrated ||
    input.runId === null ||
    input.queued ||
    previous.runId === input.runId ||
    input.itemId === null
  ) {
    return { observation: previous, anchorItemId: null };
  }
  return { observation, anchorItemId: input.itemId };
}

// Separa a primeira linha da barra de filtros para que a promoção de um item
// novo preserve a posição da linha visível.
export const ACTIVITY_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = 'following-end' | 'anchoring-new-turn' | 'free-scrolling';

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * Whether the timeline's real rows extend past the viewport. Unknown row
 * geometry or an unmeasured viewport counts as fitting. Nexus callers pass
 * composerInset 0 (there is no composer overlay above this list).
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== 'number' || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== 'number' || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(0, state.scrollLength - composerOverlayHeight - anchorOffset);
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

export interface RememberedTimelinePosition {
  readonly itemId: string;
  readonly offsetWithinItem: number;
  readonly scrollOffset: number;
  readonly atEnd: boolean;
}

// Scoped keys keep missions and filters independent. Bound the session cache.
const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

const REMEMBERED_TIMELINE_POSITION_LIMIT = 100;

export function readTimelinePosition(scopeKey: string) {
  return rememberedTimelinePositions.get(scopeKey);
}

export function rememberTimelinePosition(scopeKey: string, position: RememberedTimelinePosition) {
  rememberedTimelinePositions.delete(scopeKey);
  rememberedTimelinePositions.set(scopeKey, position);
  if (rememberedTimelinePositions.size > REMEMBERED_TIMELINE_POSITION_LIMIT) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }
}

export function clearTimelinePositions() {
  rememberedTimelinePositions.clear();
}

/** Scope key: trocar de missão ou filtro nunca reaproveita a âncora antiga. */
export function createActivityScopeKey(missionId: string, filter: string): string {
  return `${missionId}::${filter}`;
}

/**
 * Borda do fim: o stream só gruda no fim se o usuário já estava no fim.
 * Espelha o threshold que o componente passa a maintainScrollAtEndThreshold.
 */
export function isAtTimelineEnd(input: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly threshold?: number;
}): boolean {
  const threshold = input.threshold ?? 1;
  if (
    !Number.isFinite(input.scrollTop) ||
    !Number.isFinite(input.scrollHeight) ||
    !Number.isFinite(input.clientHeight)
  ) {
    return false;
  }
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

export function resolveTimelineScrollMode(input: {
  readonly atEnd: boolean;
  readonly anchorItemId: string | null;
}): TimelineScrollMode {
  if (input.anchorItemId !== null) return 'anchoring-new-turn';
  return input.atEnd ? 'following-end' : 'free-scrolling';
}

// Um gesto dentro da timeline pode pertencer a um <pre> de detalhe aninhado.
// Só trate como navegação da timeline se ele puder encadear para a lista externa.
export function isTimelineScrollTarget(
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
): boolean {
  if (!(target instanceof Element) || !timeline.contains(target) || deltaY === 0) return false;

  for (
    let element: Element | null = target;
    element && element !== timeline;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;

    const canScroll =
      deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (
      canScroll ||
      style.overscrollBehaviorY === 'contain' ||
      style.overscrollBehaviorY === 'none'
    ) {
      return false;
    }
  }
  return true;
}

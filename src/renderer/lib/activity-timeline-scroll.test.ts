// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ids string em vez de
// branded; scopeKey (missionId+filtro) em vez de threadKey; sem disclosures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_TIMELINE_ANCHOR_OFFSET,
  clearTimelinePositions,
  createActivityScopeKey,
  getAnchoredTurnMetrics,
  getRowBottom,
  isAtTimelineEnd,
  isTimelineScrollTarget,
  observeActivityRun,
  readTimelinePosition,
  rememberTimelinePosition,
  resolveTimelineScrollMode,
  timelineContentOverflowsViewport,
} from './activity-timeline-scroll';

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe('timelineContentOverflowsViewport', () => {
  const inset = { composerInset: 100, anchorOffset: 24 };

  it('reports overflow from the last row, not the inset spacer', () => {
    const fits = buildState({ positions: [0, 200], sizes: [200, 300], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(fits, inset)).toBe(false);

    const overflows = buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(overflows, inset)).toBe(true);
  });

  it('treats an empty or unmeasured list as fitting', () => {
    expect(timelineContentOverflowsViewport(undefined, inset)).toBe(false);
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 0 }),
        inset,
      ),
    ).toBe(false);
    expect(timelineContentOverflowsViewport(buildState({ positions: [], sizes: [] }), inset)).toBe(
      false,
    );
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, Number.NaN] }),
        inset,
      ),
    ).toBe(false);
  });
});

describe('timeline scroll anchoring', () => {
  it('measures row bottoms from list row position and size', () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it('treats the active turn as fitting when it fits in the usable viewport', () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it('targets the real row end instead of any temporary reserved tail', () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it('reports overflow only for the current anchored turn', () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it('returns the minimal positive scroll delta needed to reveal the turn end', () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it('subtracts the overlay height from usable viewport height', () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutOverlay = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withOverlay = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutOverlay?.overflowsUsableViewport).toBe(false);
    expect(withOverlay?.overflowsUsableViewport).toBe(true);
  });
});

describe('observeActivityRun', () => {
  const existing = {
    scopeKey: 'm-1::all',
    hydrated: true,
    runId: 'existing-run',
    queued: false,
    itemId: 'existing-item',
  };
  const next = {
    ...existing,
    runId: 'new-run',
    itemId: 'new-item',
  };

  it('opens an already hydrated scope at the end instead of framing its existing run', () => {
    const opened = observeActivityRun(null, existing);
    expect(opened.anchorItemId).toBeNull();
    expect(observeActivityRun(opened.observation, existing).anchorItemId).toBeNull();
    expect(observeActivityRun(opened.observation, next).anchorItemId).toBe(next.itemId);
  });

  it('does not mistake delayed hydration for a newly started turn', () => {
    const loading = { ...existing, hydrated: false, runId: null, itemId: null };
    const opened = observeActivityRun(null, loading);
    const stillLoading = observeActivityRun(opened.observation, loading);
    const hydrated = observeActivityRun(stillLoading.observation, existing);
    expect(hydrated.anchorItemId).toBeNull();
    expect(observeActivityRun(hydrated.observation, next).anchorItemId).toBe(next.itemId);
  });

  it('waits for a new run item and frames it only once', () => {
    const opened = observeActivityRun(null, existing);
    const waiting = observeActivityRun(opened.observation, { ...next, itemId: null });
    expect(waiting.anchorItemId).toBeNull();
    const ready = observeActivityRun(waiting.observation, next);
    expect(ready.anchorItemId).toBe(next.itemId);
    expect(observeActivityRun(ready.observation, next).anchorItemId).toBeNull();
  });

  it('establishes a separate baseline when the scope key changes', () => {
    const opened = observeActivityRun(null, existing);
    expect(
      observeActivityRun(opened.observation, { ...next, scopeKey: 'm-1::tools' }).anchorItemId,
    ).toBeNull();
  });

  it('frames the first new run in an initially empty scope', () => {
    const opened = observeActivityRun(null, { ...existing, runId: null, itemId: null });
    expect(observeActivityRun(opened.observation, next).anchorItemId).toBe(next.itemId);
  });
});

describe('remembered timeline positions', () => {
  afterEach(() => clearTimelinePositions());

  it('keeps mission and filter scopes independent', () => {
    rememberTimelinePosition('m-1::all', {
      itemId: 'a',
      offsetWithinItem: 0,
      scrollOffset: 10,
      atEnd: true,
    });
    expect(readTimelinePosition('m-1::tools')).toBeUndefined();
    expect(readTimelinePosition('m-2::all')).toBeUndefined();
    expect(readTimelinePosition('m-1::all')?.itemId).toBe('a');
  });

  it('bounds the session cache', () => {
    for (let i = 0; i < 120; i += 1) {
      rememberTimelinePosition(`m-${i}::all`, {
        itemId: `item-${i}`,
        offsetWithinItem: 0,
        scrollOffset: i,
        atEnd: i % 2 === 0,
      });
    }
    expect(readTimelinePosition('m-0::all')).toBeUndefined();
    expect(readTimelinePosition('m-119::all')?.scrollOffset).toBe(119);
  });
});

describe('createActivityScopeKey', () => {
  it('separates mission and filter so anchors never leak across scopes', () => {
    expect(createActivityScopeKey('m-1', 'all')).toBe('m-1::all');
    expect(createActivityScopeKey('m-1', 'all')).not.toBe(createActivityScopeKey('m-1', 'tools'));
    expect(createActivityScopeKey('m-1', 'all')).not.toBe(createActivityScopeKey('m-2', 'all'));
  });
});

describe('isAtTimelineEnd', () => {
  it('reports the live edge within threshold', () => {
    expect(isAtTimelineEnd({ scrollTop: 990, scrollHeight: 1400, clientHeight: 400 })).toBe(true);
    expect(isAtTimelineEnd({ scrollTop: 500, scrollHeight: 1400, clientHeight: 400 })).toBe(false);
  });

  it('rejects unmeasurable viewports instead of sticking to a guess', () => {
    expect(
      isAtTimelineEnd({ scrollTop: Number.NaN, scrollHeight: 1400, clientHeight: 400 }),
    ).toBe(false);
  });
});

describe('resolveTimelineScrollMode', () => {
  it('follows a new-turn anchor and the live edge, frees anything else', () => {
    expect(resolveTimelineScrollMode({ atEnd: true, anchorItemId: null })).toBe('following-end');
    expect(resolveTimelineScrollMode({ atEnd: false, anchorItemId: 'item-9' })).toBe(
      'anchoring-new-turn',
    );
    expect(resolveTimelineScrollMode({ atEnd: false, anchorItemId: null })).toBe('free-scrolling');
  });
});

describe('ACTIVITY_TIMELINE_ANCHOR_OFFSET', () => {
  it('keeps the upstream inset', () => {
    expect(ACTIVITY_TIMELINE_ANCHOR_OFFSET).toBe(24);
  });
});

class ScrollElement extends EventTarget {
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  overflowY = 'visible';
  overscrollBehaviorY = 'auto';

  constructor(readonly parentElement: ScrollElement | null = null) {
    super();
  }

  contains(target: ScrollElement): boolean {
    return target === this || (target.parentElement !== null && this.contains(target.parentElement));
  }
}

function targetsTimeline(target: EventTarget | null, timeline: ScrollElement, deltaY: number) {
  return isTimelineScrollTarget(target, timeline as unknown as HTMLElement, deltaY);
}

function setup() {
  const timeline = Object.assign(new ScrollElement(), {
    overflowY: 'auto',
    scrollHeight: 1500,
    clientHeight: 500,
    scrollTop: 1000,
  });
  const group = Object.assign(new ScrollElement(timeline), {
    overflowY: 'auto',
    scrollHeight: 300,
    scrollTop: 80,
  });
  return { timeline, group, content: new ScrollElement(group) };
}

describe('timeline scroll targets', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', ScrollElement);
    vi.stubGlobal('getComputedStyle', (element: ScrollElement) => element);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([-30, 30])('keeps a nested detail scroll out of the timeline: %i', (deltaY) => {
    const { timeline, group, content } = setup();
    expect(targetsTimeline(content, timeline, deltaY)).toBe(false);
    expect(targetsTimeline(group, timeline, deltaY)).toBe(false);
  });

  it.each([
    { scrollTop: 0, deltaY: -30 },
    { scrollTop: 200, deltaY: 30 },
  ])('allows chaining only past the matching edge: %j', ({ scrollTop, deltaY }) => {
    const { timeline, group, content } = setup();
    group.scrollTop = scrollTop;
    expect(targetsTimeline(content, timeline, deltaY)).toBe(true);
    expect(targetsTimeline(content, timeline, -deltaY)).toBe(false);
  });

  it.each(['contain', 'none'])('respects overscroll-y %s at either edge', (overscrollBehaviorY) => {
    const { timeline, group, content } = setup();
    group.overscrollBehaviorY = overscrollBehaviorY;
    group.scrollTop = 0;
    expect(targetsTimeline(content, timeline, -30)).toBe(false);
    group.scrollTop = 200;
    expect(targetsTimeline(content, timeline, 30)).toBe(false);
    group.scrollTop = 0;
    group.scrollHeight = group.clientHeight;
    expect(targetsTimeline(content, timeline, 30)).toBe(false);
  });

  it('allows ordinary item content and the outer viewport', () => {
    const { timeline } = setup();
    expect(targetsTimeline(new ScrollElement(timeline), timeline, -30)).toBe(true);
    expect(targetsTimeline(timeline, timeline, 30)).toBe(true);
  });

  it('rejects outside targets, non-elements, and zero deltas', () => {
    const { timeline, content } = setup();
    expect(targetsTimeline(new ScrollElement(), timeline, -30)).toBe(false);
    expect(targetsTimeline(new EventTarget(), timeline, -30)).toBe(false);
    expect(targetsTimeline(null, timeline, -30)).toBe(false);
    expect(targetsTimeline(content, timeline, 0)).toBe(false);
  });
});

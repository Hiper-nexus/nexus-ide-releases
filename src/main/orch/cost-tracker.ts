import type { ProjectExecutionScope } from '../../shared/types';
import type { CostSnapshot, PaneCost } from '../../shared/cost-types';
import { tapSessionData, tapSessionExit } from '../pty/pty-manager';
import { findPane, getPaneAuthzInfo } from './pane-registry';
import type { PaneAuthzInfo } from './pane-authz';
import { estimateCost, estimateTokens } from './pricing';
import { sameProjectScope } from './project-scoped-broadcast';

/**
 * Heuristic per-pane accounting. All mutable telemetry is partitioned by the
 * immutable authority attached to the PTY; renderer input never selects the
 * accounting scope.
 */

const INPUT_PER_OUTPUT_RATIO = 3;
const RATE_WINDOW_MS = 60_000;
const EMIT_THROTTLE_MS = 1_000;

interface PaneCostEntry extends PaneCost {
  sessionId: string;
}

interface RateSample {
  at: number;
  outputTokens: number;
  usd: number;
}

interface ScopeCostState {
  readonly scope: ProjectExecutionScope;
  readonly entries: Map<string, PaneCostEntry>;
  rateSamples: RateSample[];
  emitTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

export type CostChangeListener = (
  scope: ProjectExecutionScope,
  snapshot: CostSnapshot,
) => void;

const states = new Map<string, ScopeCostState>();
const stateKeyBySession = new Map<string, string>();
const listeners = new Set<CostChangeListener>();
let initialized = false;

function scopeKey(scope: ProjectExecutionScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ]);
}

function stateFor(
  scope: ProjectExecutionScope,
  create: boolean,
): ScopeCostState | null {
  const key = scopeKey(scope);
  const existing = states.get(key);
  if (existing) {
    if (!sameProjectScope(existing.scope, scope)) {
      throw new Error('cost tracker scope identity collision');
    }
    return existing;
  }
  if (!create) return null;
  const state: ScopeCostState = {
    scope: Object.freeze({ ...scope }),
    entries: new Map(),
    rateSamples: [],
    emitTimer: null,
    dirty: false,
  };
  states.set(key, state);
  return state;
}

function pruneSamples(state: ScopeCostState, now: number): void {
  state.rateSamples = state.rateSamples.filter(
    (sample) => now - sample.at <= RATE_WINDOW_MS,
  );
}

function snapshotOf(state: ScopeCostState | null): CostSnapshot {
  if (!state) {
    return { totalUsd: 0, perMinuteUsd: 0, tokPerSec: 0, panes: [] };
  }
  pruneSamples(state, Date.now());
  const panes: PaneCost[] = [...state.entries.values()].map((entry) => ({
    ...entry,
  }));
  return {
    totalUsd: panes.reduce((sum, pane) => sum + pane.costUsd, 0),
    perMinuteUsd: state.rateSamples.reduce(
      (sum, sample) => sum + sample.usd,
      0,
    ),
    tokPerSec:
      state.rateSamples.reduce(
        (sum, sample) => sum + sample.outputTokens,
        0,
      ) /
      (RATE_WINDOW_MS / 1_000),
    panes,
  };
}

function emitNow(state: ScopeCostState): void {
  state.dirty = false;
  const snapshot = snapshotOf(state);
  for (const listener of listeners) {
    try {
      listener(state.scope, snapshot);
    } catch (error) {
      console.warn('[cost-tracker] change listener threw:', error);
    }
  }
}

function scheduleEmit(state: ScopeCostState): void {
  state.dirty = true;
  if (state.emitTimer) return;
  state.emitTimer = setTimeout(() => {
    state.emitTimer = null;
    if (state.dirty) emitNow(state);
  }, EMIT_THROTTLE_MS);
  state.emitTimer.unref?.();
}

function handleChunk(sessionId: string, data: string): void {
  if (data.length === 0) return;
  const pane = getPaneAuthzInfo(sessionId);
  if (
    !pane?.scope ||
    pane.kind !== 'cli-agent' ||
    pane.sessionId !== sessionId
  ) {
    return;
  }

  const state = stateFor(pane.scope, true)!;
  const previous = state.entries.get(pane.paneId);
  const metadata = findPane(sessionId);
  const hasMatchingMetadata =
    metadata?.paneId === pane.paneId && metadata.sessionId === sessionId;
  const adapterId = hasMatchingMetadata
    ? metadata.adapterId
    : previous?.adapterId;
  const model = hasMatchingMetadata ? metadata.model : previous?.model;
  const outputTokens = estimateTokens(data);
  const inputTokens = outputTokens * INPUT_PER_OUTPUT_RATIO;
  const usd = estimateCost(model, inputTokens, outputTokens);
  const costUsd = (previous?.costUsd ?? 0) + usd;
  const capUsd = previous?.capUsd;
  state.entries.set(pane.paneId, {
    paneId: pane.paneId,
    sessionId,
    adapterId,
    model,
    inputTokens: (previous?.inputTokens ?? 0) + inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + outputTokens,
    costUsd,
    capUsd,
    paused: capUsd !== undefined && costUsd >= capUsd,
  });
  const now = Date.now();
  state.rateSamples = [
    ...state.rateSamples,
    { at: now, outputTokens, usd },
  ];
  pruneSamples(state, now);
  stateKeyBySession.set(sessionId, scopeKey(state.scope));
  scheduleEmit(state);
}

function handleExit(sessionId: string): void {
  const key = stateKeyBySession.get(sessionId);
  stateKeyBySession.delete(sessionId);
  const state = key ? states.get(key) : null;
  if (state) scheduleEmit(state);
}

/** Start metering once for the lifetime of the main process. */
export function initCostTracker(): void {
  if (initialized) return;
  initialized = true;
  tapSessionData(handleChunk, 'cost-tracker');
  tapSessionExit(handleExit);
}

/** Aggregate only the exact project/checkout/installation requested. */
export function getCostSnapshot(scope: ProjectExecutionScope): CostSnapshot {
  return snapshotOf(stateFor(scope, false));
}

function scopedPane(
  scope: ProjectExecutionScope,
  paneId: string,
): PaneAuthzInfo | null {
  const direct = getPaneAuthzInfo(paneId);
  return direct?.kind === 'cli-agent' &&
    direct.scope &&
    sameProjectScope(direct.scope, scope)
    ? direct
    : null;
}

/** Set or clear a cap without revealing panes owned by another scope. */
export function setPaneCap(
  scope: ProjectExecutionScope,
  paneId: string,
  capUsd: number | null,
): boolean {
  let state = stateFor(scope, false);
  let entry = state?.entries.get(paneId);
  if (!entry) {
    const pane = scopedPane(scope, paneId);
    if (!pane) return false;
    state = stateFor(scope, true)!;
    entry = {
      paneId,
      sessionId: pane.sessionId ?? '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      paused: false,
    };
  }
  const nextCap = capUsd ?? undefined;
  state!.entries.set(paneId, {
    ...entry,
    capUsd: nextCap,
    paused: nextCap !== undefined && entry.costUsd >= nextCap,
  });
  scheduleEmit(state!);
  return true;
}

/** Subscribe to scoped events. Returns an unsubscribe handle. */
export function onCostChange(listener: CostChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

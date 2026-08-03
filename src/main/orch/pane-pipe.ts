import type { WebContents } from 'electron';
import type { Pipe, PipeMode } from '../../shared/pipe-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getSessionState,
  orchWriteSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { getRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  getOwnedPaneAuthzInfoBySession,
  getPaneAuthzInfoOwnedByPane,
  getPanesVersion,
  readSessionOutput,
  stripAnsi,
} from './pane-registry';
import type { PaneAuthzInfo } from './pane-authz';
import { sameProjectScope } from './project-scoped-broadcast';
import { makeId } from './store-util';
import {
  InjectionGuard,
  PIPE_MARKER,
  canForward,
  extractCompleteLines,
  sanitizeForInjection,
} from './pane-pipe-core';
import {
  isSessionInjectableIdle,
  tapAgentSemanticStatus,
} from './agent-status';

/**
 * Pane pipes are runtime resources owned by one renderer and one immutable
 * project checkout. Pane ids remain stable across PTY respawns, while every
 * forwarding operation re-resolves the current session from that authority.
 */

const MAX_PIPES_PER_PARTITION = 64;
const FLUSH_INTERVAL_MS = 150;
const FLUSH_INTERVAL_FAST_MS = 50; // Used when queue is deep (high throughput)
const FLUSH_INTERVAL_SLOW_MS = 300; // Used when queue is shallow (low activity)
const FAST_FLUSH_THRESHOLD = 32; // Queue depth that triggers fast flush
const MAX_LINES_PER_FLUSH = 8;
const MAX_LINES_PER_FLUSH_FAST = 16; // Deliver more lines when queue is deep
const MAX_QUEUED_LINES = 400;
const IDLE_THROTTLE_MS = 3_000;
const IDLE_TAIL_LINES = 60;
const MAX_IDLE_DELIVERY_CHARS = 4_000;
const SUBMIT_ENTER_DELAY_MS = 150;

interface StreamState {
  sessionId: string;
  rest: string;
}

interface EndpointIdentity {
  readonly paneId: string;
  readonly missionId?: string;
  readonly role?: PaneAuthzInfo['role'];
  readonly kind: PaneAuthzInfo['kind'];
}

interface ScopedPipe {
  readonly pipe: Pipe;
  readonly source: EndpointIdentity;
  readonly target: EndpointIdentity;
}

interface PendingSubmit {
  readonly sessionId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface SourceIndex {
  panesVersion: number;
  pipesVersion: number;
  map: Map<string, ScopedPipe[]>;
}

interface PipePartition {
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
  readonly pipes: Map<string, ScopedPipe>;
  readonly streamStates: Map<string, StreamState>;
  readonly outQueues: Map<string, string[]>;
  readonly flushTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly idleDirty: Set<string>;
  readonly lastIdleDeliveryAt: Map<string, number>;
  readonly lastIdleDeliveryText: Map<string, string>;
  readonly deliveryCounts: Map<string, number>;
  readonly lastDeliveryAt: Map<string, number>;
  readonly submitTimers: Map<string, PendingSubmit>;
  readonly guard: InjectionGuard;
  pipesVersion: number;
  sourceIndex: SourceIndex | null;
}

export type PipesChangeListener = (
  owner: WebContents,
  scope: ProjectExecutionScope,
) => void;

const partitionsByOwner = new Map<WebContents, Map<string, PipePartition>>();
const listeners = new Set<PipesChangeListener>();
let tapsInstalled = false;

function scopeKey(scope: ProjectExecutionScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ]);
}

function partitionFor(
  owner: WebContents,
  scope: ProjectExecutionScope,
  create: boolean,
): PipePartition | null {
  let byScope = partitionsByOwner.get(owner);
  const key = scopeKey(scope);
  const existing = byScope?.get(key);
  if (existing) {
    if (!sameProjectScope(existing.scope, scope)) {
      throw new Error('pane pipe scope identity collision');
    }
    return existing;
  }
  if (!create) return null;
  if (!byScope) {
    byScope = new Map();
    partitionsByOwner.set(owner, byScope);
  }
  const partition: PipePartition = {
    owner,
    scope: Object.freeze({ ...scope }),
    pipes: new Map(),
    streamStates: new Map(),
    outQueues: new Map(),
    flushTimers: new Map(),
    idleDirty: new Set(),
    lastIdleDeliveryAt: new Map(),
    lastIdleDeliveryText: new Map(),
    deliveryCounts: new Map(),
    lastDeliveryAt: new Map(),
    submitTimers: new Map(),
    guard: new InjectionGuard(),
    pipesVersion: 0,
    sourceIndex: null,
  };
  byScope.set(key, partition);
  return partition;
}

function emitChange(partition: PipePartition): void {
  for (const listener of [...listeners]) {
    try {
      listener(partition.owner, partition.scope);
    } catch (error) {
      console.warn('[pipes] change listener threw:', error);
    }
  }
}

function currentPartitionScope(partition: PipePartition): boolean {
  const current = getRendererWorkspaceScope(partition.owner);
  return Boolean(current && sameProjectScope(current, partition.scope));
}

function endpointIdentity(pane: PaneAuthzInfo): EndpointIdentity | null {
  if (!pane.sessionId) return null;
  return Object.freeze({
    paneId: pane.paneId,
    missionId: pane.missionId,
    role: pane.role,
    kind: pane.kind,
  });
}

function sameEndpoint(
  current: PaneAuthzInfo,
  expected: EndpointIdentity,
): boolean {
  return (
    current.paneId === expected.paneId &&
    current.missionId === expected.missionId &&
    current.role === expected.role &&
    current.kind === expected.kind
  );
}

function resolveEndpoint(
  partition: PipePartition,
  expected: EndpointIdentity,
): PaneAuthzInfo | null {
  if (!currentPartitionScope(partition)) return null;
  const pane = getPaneAuthzInfoOwnedByPane(partition.owner, expected.paneId);
  return pane?.scope &&
    pane.sessionId &&
    sameProjectScope(pane.scope, partition.scope) &&
    sameEndpoint(pane, expected)
    ? pane
    : null;
}

function clearTransientPipeState(
  partition: PipePartition,
  pipeId: string,
): void {
  partition.streamStates.delete(pipeId);
  partition.outQueues.delete(pipeId);
  const flushTimer = partition.flushTimers.get(pipeId);
  if (flushTimer) clearTimeout(flushTimer);
  partition.flushTimers.delete(pipeId);
  const submit = partition.submitTimers.get(pipeId);
  if (submit) clearTimeout(submit.timer);
  partition.submitTimers.delete(pipeId);
  partition.idleDirty.delete(pipeId);
  partition.lastIdleDeliveryAt.delete(pipeId);
  partition.lastIdleDeliveryText.delete(pipeId);
}

function clearPipeState(partition: PipePartition, pipeId: string): void {
  clearTransientPipeState(partition, pipeId);
  partition.deliveryCounts.delete(pipeId);
  partition.lastDeliveryAt.delete(pipeId);
}

function resolveTargetSession(
  partition: PipePartition,
  scopedPipe: ScopedPipe,
  sourceSessionId: string,
): string | null {
  const target = resolveEndpoint(partition, scopedPipe.target);
  if (!target?.sessionId) return null;
  if (target.sessionId === sourceSessionId) return null;
  return target.sessionId;
}

function scheduleFlush(partition: PipePartition, pipeId: string): void {
  if (partition.flushTimers.has(pipeId)) return;
  // Adaptive flush interval: faster when queue is deep (high throughput),
  // slower when shallow (low activity). This reduces CPU for idle pipes
  // while keeping latency low for active streams.
  const queueDepth = partition.outQueues.get(pipeId)?.length ?? 0;
  const interval =
    queueDepth >= FAST_FLUSH_THRESHOLD
      ? FLUSH_INTERVAL_FAST_MS
      : queueDepth <= 4
        ? FLUSH_INTERVAL_SLOW_MS
        : FLUSH_INTERVAL_MS;
  partition.flushTimers.set(
    pipeId,
    setTimeout(() => {
      partition.flushTimers.delete(pipeId);
      flushQueue(partition, pipeId);
    }, interval),
  );
}

function flushQueue(partition: PipePartition, pipeId: string): void {
  const scopedPipe = partition.pipes.get(pipeId);
  const queue = partition.outQueues.get(pipeId);
  if (!scopedPipe || !queue || queue.length === 0) return;
  const source = resolveEndpoint(partition, scopedPipe.source);
  const targetSessionId = resolveTargetSession(
    partition,
    scopedPipe,
    source?.sessionId ?? '',
  );
  if (!targetSessionId) {
    partition.outQueues.delete(pipeId);
    return;
  }
  if (!isSessionInjectableIdle(targetSessionId)) return;

  // Adaptive batch size: deliver more lines when queue is deep to drain
  // faster, reducing latency for high-throughput streams.
  const maxLines =
    queue.length >= FAST_FLUSH_THRESHOLD
      ? MAX_LINES_PER_FLUSH_FAST
      : MAX_LINES_PER_FLUSH;
  const batch = queue.splice(0, maxLines);
  let delivered = 0;
  for (const line of batch) {
    partition.guard.markInjected(targetSessionId, line);
    if (!orchWriteSession(targetSessionId, `${line}\r`)) {
      partition.outQueues.delete(pipeId);
      return;
    }
    delivered += 1;
  }
  if (delivered > 0) {
    partition.deliveryCounts.set(
      pipeId,
      (partition.deliveryCounts.get(pipeId) ?? 0) + delivered,
    );
    partition.lastDeliveryAt.set(pipeId, Date.now());
    emitChange(partition);
  }
  if (queue.length > 0) scheduleFlush(partition, pipeId);
  else partition.outQueues.delete(pipeId);
}

function enqueueLine(
  partition: PipePartition,
  pipeId: string,
  line: string,
): void {
  let queue = partition.outQueues.get(pipeId);
  if (!queue) {
    queue = [];
    partition.outQueues.set(pipeId, queue);
  }
  queue.push(line);
  while (queue.length > MAX_QUEUED_LINES) queue.shift();
  scheduleFlush(partition, pipeId);
}

function renderedLine(rawLine: string): string {
  const segments = stripAnsi(rawLine).split('\n');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index].trim();
    if (segment.length > 0) return segment;
  }
  return '';
}

function handleStreamChunk(
  partition: PipePartition,
  scopedPipe: ScopedPipe,
  sourceSessionId: string,
  data: string,
): void {
  const pipeId = scopedPipe.pipe.id;
  let state = partition.streamStates.get(pipeId);
  if (!state || state.sessionId !== sourceSessionId) {
    state = { sessionId: sourceSessionId, rest: '' };
    partition.streamStates.set(pipeId, state);
  }
  const { lines, rest } = extractCompleteLines(state.rest, data);
  state.rest = rest;

  for (const rawLine of lines) {
    const line = renderedLine(rawLine);
    if (line.length === 0) continue;
    if (line.includes(PIPE_MARKER)) continue;
    if (partition.guard.isEcho(sourceSessionId, line)) continue;
    enqueueLine(partition, pipeId, line);
  }
}

function scheduleSubmit(
  partition: PipePartition,
  scopedPipe: ScopedPipe,
  targetSessionId: string,
): void {
  const pipeId = scopedPipe.pipe.id;
  const previous = partition.submitTimers.get(pipeId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    partition.submitTimers.delete(pipeId);
    const livePipe = partition.pipes.get(pipeId);
    const target = livePipe
      ? resolveEndpoint(partition, livePipe.target)
      : null;
    if (target?.sessionId === targetSessionId) {
      if (isSessionInjectableIdle(targetSessionId)) {
        orchWriteSession(targetSessionId, '\r');
      }
    }
  }, SUBMIT_ENTER_DELAY_MS);
  partition.submitTimers.set(pipeId, { sessionId: targetSessionId, timer });
}

function deliverIdle(
  partition: PipePartition,
  scopedPipe: ScopedPipe,
  sourceSessionId: string,
): void {
  const pipe = scopedPipe.pipe;
  const now = Date.now();
  const lastAt = partition.lastIdleDeliveryAt.get(pipe.id) ?? 0;
  if (now - lastAt < IDLE_THROTTLE_MS) return;
  const targetSessionId = resolveTargetSession(
    partition,
    scopedPipe,
    sourceSessionId,
  );
  if (!targetSessionId) return;
  if (!isSessionInjectableIdle(targetSessionId)) return;

  const tail = readSessionOutput(sourceSessionId, IDLE_TAIL_LINES);
  const text = sanitizeForInjection(
    tail
      .split('\n')
      .filter((line) => !line.includes(PIPE_MARKER))
      .join('\n'),
  ).slice(0, MAX_IDLE_DELIVERY_CHARS);
  if (
    text.length === 0 ||
    text === partition.lastIdleDeliveryText.get(pipe.id)
  ) {
    return;
  }

  const message =
    `${PIPE_MARKER} from=${sanitizeForInjection(pipe.sourcePaneId).slice(0, 128)} ` +
    text;
  partition.guard.markInjected(targetSessionId, message);
  if (!orchWriteSession(targetSessionId, message)) return;
  partition.deliveryCounts.set(
    pipe.id,
    (partition.deliveryCounts.get(pipe.id) ?? 0) + 1,
  );
  partition.lastDeliveryAt.set(pipe.id, now);
  partition.lastIdleDeliveryAt.set(pipe.id, now);
  partition.lastIdleDeliveryText.set(pipe.id, text);
  emitChange(partition);
  scheduleSubmit(partition, scopedPipe, targetSessionId);
}

function tryDeliverIdle(
  partition: PipePartition,
  scopedPipe: ScopedPipe,
): void {
  if (scopedPipe.pipe.mode !== 'onIdle') return;
  const source = resolveEndpoint(partition, scopedPipe.source);
  if (!source?.sessionId || getSessionState(source.sessionId) !== 'idle') return;
  partition.idleDirty.delete(scopedPipe.pipe.id);
  deliverIdle(partition, scopedPipe, source.sessionId);
}

function pipesBySource(partition: PipePartition): Map<string, ScopedPipe[]> {
  if (!currentPartitionScope(partition)) return new Map();
  const panesVersion = getPanesVersion();
  if (
    partition.sourceIndex?.panesVersion === panesVersion &&
    partition.sourceIndex.pipesVersion === partition.pipesVersion
  ) {
    return partition.sourceIndex.map;
  }
  const map = new Map<string, ScopedPipe[]>();
  for (const scopedPipe of partition.pipes.values()) {
    const source = resolveEndpoint(partition, scopedPipe.source);
    if (!source?.sessionId) continue;
    const attached = map.get(source.sessionId) ?? [];
    attached.push(scopedPipe);
    map.set(source.sessionId, attached);
  }
  partition.sourceIndex = {
    panesVersion,
    pipesVersion: partition.pipesVersion,
    map,
  };
  return map;
}

function partitionForSession(sessionId: string): PipePartition | null {
  const authority = getOwnedPaneAuthzInfoBySession(sessionId);
  return authority?.scope
    ? partitionFor(authority.owner, authority.scope, false)
    : null;
}

export function initPanePipes(): void {
  if (tapsInstalled) return;
  tapsInstalled = true;

  tapSessionData((sessionId, data) => {
    const partition = partitionForSession(sessionId);
    if (!partition) return;
    const attached = pipesBySource(partition).get(sessionId);
    if (!attached) return;
    for (const scopedPipe of attached) {
      if (scopedPipe.pipe.mode === 'stream') {
        handleStreamChunk(partition, scopedPipe, sessionId, data);
      } else {
        partition.idleDirty.add(scopedPipe.pipe.id);
      }
    }
  });

  tapSessionState((sessionId, state) => {
    if (state !== 'idle') return;
    const partition = partitionForSession(sessionId);
    if (!partition) return;
    for (const scopedPipe of pipesBySource(partition).get(sessionId) ?? []) {
      if (
        scopedPipe.pipe.mode === 'onIdle' &&
        partition.idleDirty.has(scopedPipe.pipe.id)
      ) {
        tryDeliverIdle(partition, scopedPipe);
      }
    }
  });

  tapAgentSemanticStatus((entry) => {
    if (
      (entry.status !== 'idle' && entry.status !== 'completed') ||
      !isSessionInjectableIdle(entry.sessionId)
    ) return;
    for (const byScope of partitionsByOwner.values()) {
      for (const partition of byScope.values()) {
        for (const [pipeId, scopedPipe] of partition.pipes) {
          const target = resolveEndpoint(partition, scopedPipe.target);
          if (target?.sessionId !== entry.sessionId) continue;
          if (scopedPipe.pipe.mode === 'stream') flushQueue(partition, pipeId);
          else if (partition.idleDirty.has(pipeId)) {
            tryDeliverIdle(partition, scopedPipe);
          }
        }
      }
    }
  });

  tapSessionExit((sessionId) => {
    for (const byScope of partitionsByOwner.values()) {
      for (const partition of byScope.values()) {
        partition.guard.clearSession(sessionId);
        for (const [pipeId, scopedPipe] of partition.pipes) {
          const source = getPaneAuthzInfoOwnedByPane(
            partition.owner,
            scopedPipe.source.paneId,
          );
          const streamState = partition.streamStates.get(pipeId);
          if (
            source?.sessionId === sessionId ||
            streamState?.sessionId === sessionId
          ) {
            clearTransientPipeState(partition, pipeId);
          }
        }
        for (const [pipeId, submit] of [...partition.submitTimers]) {
          if (submit.sessionId !== sessionId) continue;
          clearTimeout(submit.timer);
          partition.submitTimers.delete(pipeId);
        }
      }
    }
  });
}

export function listPipes(
  owner: WebContents,
  scope: ProjectExecutionScope,
): Pipe[] {
  const partition = partitionFor(owner, scope, false);
  if (!partition || !currentPartitionScope(partition)) return [];
  return [...partition.pipes.values()].map(({ pipe }) => ({
    ...pipe,
    deliveryCount: partition.deliveryCounts.get(pipe.id) ?? 0,
    lastDeliveredAt: partition.lastDeliveryAt.get(pipe.id),
  }));
}

export function addPipe(
  owner: WebContents,
  scope: ProjectExecutionScope,
  sourcePaneId: string,
  targetPaneId: string,
  mode: PipeMode,
): Pipe | null {
  if (!canForward(sourcePaneId, targetPaneId)) return null;
  const currentScope = getRendererWorkspaceScope(owner);
  if (!currentScope || !sameProjectScope(currentScope, scope)) return null;
  const sourcePane = getPaneAuthzInfoOwnedByPane(owner, sourcePaneId);
  const targetPane = getPaneAuthzInfoOwnedByPane(owner, targetPaneId);
  const source = sourcePane?.scope ? endpointIdentity(sourcePane) : null;
  const target = targetPane?.scope ? endpointIdentity(targetPane) : null;
  if (
    !sourcePane?.scope ||
    !targetPane?.scope ||
    !sameProjectScope(sourcePane.scope, scope) ||
    !sameProjectScope(targetPane.scope, scope) ||
    !source ||
    !target ||
    sourcePane.sessionId === targetPane.sessionId
  ) {
    return null;
  }

  const partition = partitionFor(owner, scope, true)!;
  for (const existing of partition.pipes.values()) {
    if (
      existing.pipe.sourcePaneId === sourcePaneId &&
      existing.pipe.targetPaneId === targetPaneId &&
      existing.pipe.mode === mode
    ) {
      return existing.pipe;
    }
  }
  if (partition.pipes.size >= MAX_PIPES_PER_PARTITION) return null;
  const pipe: Pipe = {
    id: makeId('pipe'),
    sourcePaneId,
    targetPaneId,
    mode,
  };
  const scopedPipe: ScopedPipe = { pipe, source, target };
  partition.pipes.set(pipe.id, scopedPipe);
  partition.pipesVersion += 1;
  partition.sourceIndex = null;
  emitChange(partition);
  if (mode === 'onIdle') {
    partition.idleDirty.add(pipe.id);
    tryDeliverIdle(partition, scopedPipe);
  }
  return pipe;
}

export function removePipe(
  owner: WebContents,
  scope: ProjectExecutionScope,
  id: string,
): boolean {
  const partition = partitionFor(owner, scope, false);
  if (!partition || !currentPartitionScope(partition)) return false;
  if (!partition.pipes.delete(id)) return false;
  partition.pipesVersion += 1;
  partition.sourceIndex = null;
  clearPipeState(partition, id);
  emitChange(partition);
  return true;
}

export function clearPipePartitions(
  owner: WebContents,
  scope?: ProjectExecutionScope,
): void {
  const byScope = partitionsByOwner.get(owner);
  if (!byScope) return;
  const targets = [...byScope.entries()].filter(([, partition]) =>
    scope ? sameProjectScope(partition.scope, scope) : true,
  );
  for (const [key, partition] of targets) {
    for (const pipeId of partition.pipes.keys()) {
      clearPipeState(partition, pipeId);
    }
    partition.pipes.clear();
    byScope.delete(key);
    emitChange(partition);
  }
  if (byScope.size === 0) partitionsByOwner.delete(owner);
}

export function onPipesChange(listener: PipesChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

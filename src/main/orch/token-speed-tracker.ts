import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { subscribePtyAnalysis } from '../pty/pty-analysis-runtime';
import type { ProjectExecutionScope } from '../../shared/types'
import type { TokenSpeedSnapshot } from '../../shared/token-speed-types'
import { EMPTY_TOKEN_SPEED_SNAPSHOT } from '../../shared/token-speed-types'
import {
  tapSessionExit,
  tapSessionTermination,
} from '../pty/pty-manager'
import { findPane, getPaneAuthzInfo } from './pane-registry'
import { sameProjectScope } from './project-scoped-broadcast'
import {
  TokenSpeedMeter,
  type TokenSpeedUsageEvent,
} from '../usage/token-speed-meter'

/**
 * Cronômetro de geração por pane, particionado pela MESMA autoridade imutável
 * do PTY que o cost-tracker usa: o renderer nunca escolhe o escopo, e um
 * checkout jamais enxerga a velocidade de outro.
 *
 * O medidor puro vive em `../usage/token-speed-meter`; aqui só há plumbing:
 * taps do PTY, detecção de submit, throttle de emissão e limpeza de sessão.
 */

const EMIT_THROTTLE_MS = 500
/** Enquanto gera, reemite o velocímetro com o relógio atual (não só no chunk). */
const LIVE_TICK_MS = 250
/** Folga sobre o idle do medidor para fechar a rodada e emitir o número final. */
const SETTLE_GRACE_MS = 120
/** Teto do rascunho de prompt mantido em memória volátil por sessão. */
interface ScopeSpeedState {
  readonly scope: ProjectExecutionScope
  readonly meter: TokenSpeedMeter
  emitTimer: ReturnType<typeof setTimeout> | null
  settleTimer: ReturnType<typeof setTimeout> | null
  liveTimer: ReturnType<typeof setInterval> | null
  dirty: boolean
  controller: AbortController
}

interface SessionBinding {
  scopeKey: string
  paneId: string
}

export type TokenSpeedChangeListener = (
  scope: ProjectExecutionScope,
  snapshot: TokenSpeedSnapshot,
) => void

const states = new Map<string, ScopeSpeedState>()
const bindings = new Map<string, SessionBinding>()
/** Rascunho do que foi digitado e ainda não submetido. Some no Enter. */
const listeners = new Set<TokenSpeedChangeListener>()
let initialized = false

function scopeKey(scope: ProjectExecutionScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ])
}

function stateFor(
  scope: ProjectExecutionScope,
  create: boolean,
): ScopeSpeedState | null {
  const key = scopeKey(scope)
  const existing = states.get(key)
  if (existing) {
    if (!sameProjectScope(existing.scope, scope)) {
      throw new Error('token speed tracker scope identity collision')
    }
    return existing
  }
  if (!create) return null
  const state: ScopeSpeedState = {
    scope: Object.freeze({ ...scope }),
    meter: new TokenSpeedMeter(),
    emitTimer: null,
    settleTimer: null,
    liveTimer: null,
    dirty: false,
    controller: new AbortController(),
  }
  states.set(key, state)
  return state
}

function emitNow(state: ScopeSpeedState): void {
  const key = scopeKey(state.scope)
  void runPeriodicTask(`token-speed-live:${key}`, async (context) => {
    if (states.get(key) !== state) return
    state.dirty = false
    const snapshot = state.meter.snapshot(Date.now())
    if (snapshot.streaming) startLiveTick(state)
    else stopLiveTick(state)
    for (const listener of [...listeners]) {
      await context.checkpoint()
      if (states.get(key) !== state || !listeners.has(listener)) continue
      try { listener(state.scope, snapshot) }
      catch (error) { console.warn('[token-speed] change listener threw:', error) }
    }
  }, { signal: state.controller.signal, cadenceMs: LIVE_TICK_MS }).catch(() => undefined)
}

function startLiveTick(state: ScopeSpeedState): void {
  if (state.liveTimer) return
  state.liveTimer = setInterval(() => {
    emitNow(state)
  }, LIVE_TICK_MS)
  state.liveTimer.unref?.()
}

function stopLiveTick(state: ScopeSpeedState): void {
  if (!state.liveTimer) return
  clearInterval(state.liveTimer)
  state.liveTimer = null
}

function scheduleEmit(state: ScopeSpeedState): void {
  state.dirty = true
  if (!state.emitTimer) {
    state.emitTimer = setTimeout(() => {
      state.emitTimer = null
      if (state.dirty) emitNow(state)
    }, EMIT_THROTTLE_MS)
    state.emitTimer.unref?.()
  }
  // Uma rodada só fecha por silêncio; sem este timer o último número da
  // resposta ficaria preso até o próximo evento de PTY.
  if (state.settleTimer) clearTimeout(state.settleTimer)
  state.settleTimer = setTimeout(() => {
    state.settleTimer = null
    if (state.meter.flushIdle(Date.now())) emitNow(state)
  }, state.meter.idleCloseMs + SETTLE_GRACE_MS)
  state.settleTimer.unref?.()
}

/** Pane de agente com autoridade coerente, ou null. */
function meteredPane(
  sessionId: string,
): { paneId: string; scope: ProjectExecutionScope; model?: string } | null {
  const pane = getPaneAuthzInfo(sessionId)
  if (
    !pane?.scope ||
    pane.kind !== 'cli-agent' ||
    pane.sessionId !== sessionId
  ) {
    return null
  }
  const metadata = findPane(sessionId)
  const model =
    metadata?.paneId === pane.paneId && metadata.sessionId === sessionId
      ? metadata.model
      : undefined
  return { paneId: pane.paneId, scope: pane.scope, model }
}

/**
 * Enter (CR/LF) é o sinal universal de submit nas CLIs de agente. O rascunho
 * acumulado serve SÓ para reconhecer o eco do TUI e é descartado no submit.
 */
export { splitSubmittedInput, hasSubmittedPrompt } from '../usage/token-speed-input'
export function tokenSpeedUsageEventAt(
  event: TokenSpeedUsageEvent,
  observedAt: number,
): number {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? event.timestamp
    : observedAt
}

function handleAnalysis(sessionId: string, value: { submit?: boolean; tokens?: number; at: number }): void {
  const pane = meteredPane(sessionId); if (!pane) return
  const state = stateFor(pane.scope, true)!
  bindings.set(sessionId, { scopeKey: scopeKey(state.scope), paneId: pane.paneId })
  if (value.submit) { state.meter.noteSubmit(pane.paneId, value.at); scheduleEmit(state) }
  else if (value.tokens !== undefined && state.meter.noteAnalyzedOutput(pane.paneId, value.at, value.tokens, pane.model)) scheduleEmit(state)
}

function handleExit(sessionId: string): void {
  const binding = bindings.get(sessionId)
  bindings.delete(sessionId)
  if (!binding) return
  const state = states.get(binding.scopeKey)
  if (!state) return
  if (state.meter.forget(binding.paneId)) emitNow(state)
}

/** Start metering once for the lifetime of the main process. */
export function initTokenSpeedTracker(): void {
  if (initialized) return
  initialized = true
  subscribePtyAnalysis('token', (sessionId, value) => handleAnalysis(sessionId, value as Parameters<typeof handleAnalysis>[1]))
  tapSessionExit(handleExit)
  tapSessionTermination(handleExit)
}

/**
 * Corrige a última amostra de um pane com a contagem REAL do transcript.
 * Sem pane vivo com autoridade, o evento é descartado.
 */
export function recordTokenSpeedUsage(
  paneId: string,
  event: TokenSpeedUsageEvent,
): boolean {
  const pane = getPaneAuthzInfo(paneId)
  if (!pane?.scope) return false
  const state = stateFor(pane.scope, false)
  if (!state) return false
  const observedAt = Date.now()
  if (
    !state.meter.noteUsage(
      paneId,
      tokenSpeedUsageEventAt(event, observedAt),
      event,
    )
  ) {
    return false
  }
  scheduleEmit(state)
  return true
}

/** Aggregate only the exact project/checkout/installation requested. */
export function getTokenSpeedSnapshot(
  scope: ProjectExecutionScope,
): TokenSpeedSnapshot {
  const state = stateFor(scope, false)
  if (!state) return { ...EMPTY_TOKEN_SPEED_SNAPSHOT, generatedAt: Date.now() }
  return state.meter.snapshot(Date.now())
}

/** Subscribe to scoped events. Returns an unsubscribe handle. */
export function onTokenSpeedChange(
  listener: TokenSpeedChangeListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: drop every scope, binding, draft and timer. */
export function resetTokenSpeedTrackerForTests(): void {
  for (const state of states.values()) {
    if (state.emitTimer) clearTimeout(state.emitTimer)
    if (state.settleTimer) clearTimeout(state.settleTimer)
    stopLiveTick(state)
    state.controller.abort(new Error('token speed tracker stopped'))
    void stopPeriodicTask(`token-speed-live:${scopeKey(state.scope)}`)
  }
  states.clear()
  bindings.clear()
  listeners.clear()
}

import type { ProjectExecutionScope } from '../../shared/types'
import type { TokenSpeedSnapshot } from '../../shared/token-speed-types'
import { EMPTY_TOKEN_SPEED_SNAPSHOT } from '../../shared/token-speed-types'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import {
  tapSessionData,
  tapSessionExit,
  tapSessionInput,
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
/** Folga sobre o idle do medidor para fechar a rodada e emitir o número final. */
const SETTLE_GRACE_MS = 120
/** Teto do rascunho de prompt mantido em memória volátil por sessão. */
const PROMPT_DRAFT_LIMIT = 4_000
/** Ctrl+C e Ctrl+Z. */
const CANCEL_KEY_PATTERN = /[\u0003\u001a]/
/** Bytes de controle que não são quebra de linha. */
const CONTROL_EXCEPT_NEWLINE_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

interface ScopeSpeedState {
  readonly scope: ProjectExecutionScope
  readonly meter: TokenSpeedMeter
  emitTimer: ReturnType<typeof setTimeout> | null
  settleTimer: ReturnType<typeof setTimeout> | null
  dirty: boolean
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
const drafts = new Map<string, string>()
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
    dirty: false,
  }
  states.set(key, state)
  return state
}

function emitNow(state: ScopeSpeedState): void {
  state.dirty = false
  const snapshot = state.meter.snapshot(Date.now())
  for (const listener of listeners) {
    try {
      listener(state.scope, snapshot)
    } catch (error) {
      console.warn('[token-speed] change listener threw:', error)
    }
  }
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
export function splitSubmittedInput(
  draft: string,
  data: string,
): { submitted: string | null; draft: string } {
  // Ctrl+C / Ctrl+Z abortam a composição: o rascunho morre e nada é submetido.
  if (CANCEL_KEY_PATTERN.test(data)) return { submitted: null, draft: '' }
  const clean = stripAnsiEscapeSequences(data).replace(
    CONTROL_EXCEPT_NEWLINE_PATTERN,
    '',
  )
  const marker = Math.max(clean.lastIndexOf('\r'), clean.lastIndexOf('\n'))
  if (marker < 0) {
    return {
      submitted: null,
      draft: (draft + clean).slice(-PROMPT_DRAFT_LIMIT),
    }
  }
  const submitted = (draft + clean.slice(0, marker)).slice(-PROMPT_DRAFT_LIMIT)
  return { submitted, draft: clean.slice(marker + 1).slice(-PROMPT_DRAFT_LIMIT) }
}

function handleInput(sessionId: string, data: string): void {
  const pane = meteredPane(sessionId)
  if (!pane) return
  const { submitted, draft } = splitSubmittedInput(
    drafts.get(sessionId) ?? '',
    data,
  )
  if (draft.length > 0) drafts.set(sessionId, draft)
  else drafts.delete(sessionId)
  if (submitted === null) return

  const state = stateFor(pane.scope, true)!
  bindings.set(sessionId, { scopeKey: scopeKey(state.scope), paneId: pane.paneId })
  state.meter.noteSubmit(pane.paneId, Date.now(), submitted)
  scheduleEmit(state)
}

function handleChunk(sessionId: string, data: string): void {
  if (data.length === 0) return
  const pane = meteredPane(sessionId)
  if (!pane) return
  const state = stateFor(pane.scope, true)!
  bindings.set(sessionId, { scopeKey: scopeKey(state.scope), paneId: pane.paneId })
  if (state.meter.noteOutput(pane.paneId, Date.now(), data, pane.model)) {
    scheduleEmit(state)
  }
}

function handleExit(sessionId: string): void {
  drafts.delete(sessionId)
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
  tapSessionInput(handleInput)
  tapSessionData(handleChunk)
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
  if (!state.meter.noteUsage(paneId, Date.now(), event)) return false
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
  }
  states.clear()
  bindings.clear()
  drafts.clear()
  listeners.clear()
}

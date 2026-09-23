import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type {
  ModelTokenSpeed,
  PaneTokenSpeed,
  TokenSpeedSample,
  TokenSpeedSnapshot,
} from '../../shared/token-speed-types'

/**
 * Motor PURO de velocidade de geração: recebe eventos cronometrados e devolve
 * tok/s por rodada, TTFT, média/pico das últimas N e a curva. Sem timers, sem
 * estado global, sem I/O — o relógio entra por parâmetro em TODA chamada, e é
 * por isso que o comportamento inteiro é testável sem PTY nem Electron.
 *
 * Doutrina de honestidade: quando a medição não sustenta um número (rodada
 * curta demais, submit não observado, zero token), o campo vai `null`. Nunca
 * 0 falso, nunca NaN, nunca Infinity.
 *
 * Privacidade: o texto do prompt é mantido SÓ até o 1º token da rodada, apenas
 * para separar eco do terminal de token do modelo, truncado, e nunca sai deste
 * objeto. Nenhum conteúdo entra em `TokenSpeedSample`.
 */

export interface TokenSpeedMeterOptions {
  /** Silêncio que fecha a rodada aberta. */
  idleCloseMs?: number
  /** Teto do buffer da curva, por pane. */
  historyLimit?: number
  /** "Últimas N" de média e pico. */
  recentWindow?: number
  /** Abaixo disso a janela de geração é curta demais para virar tok/s. */
  minGenerationMs?: number
  /** Rodadas com menos tokens que isto são ruído de TUI, não resposta. */
  minTurnTokens?: number
  /** Janela em que um evento de uso real pode corrigir uma amostra. */
  usageMatchWindowMs?: number
}

export const TOKEN_SPEED_DEFAULTS = {
  idleCloseMs: 1_200,
  historyLimit: 60,
  recentWindow: 5,
  minGenerationMs: 40,
  minTurnTokens: 4,
  usageMatchWindowMs: 180_000,
} as const

/** Quanto do prompt fica em memória volátil para suprimir eco. */
const PROMPT_ECHO_MEMORY_CHARS = 4_000
/** Heurística de tokens: mesma régua do cost-tracker (4 chars ≈ 1 token). */
const CHARS_PER_TOKEN = 4

/**
 * Molduras de spinner, barras de progresso e bordas de TUI. Um chunk composto
 * SÓ destes glifos é repintura de tela, não geração.
 */
const TUI_GLYPH_PATTERN = /[\u2500-\u257f\u2580-\u259f\u2800-\u28ff]/gu
/**
 * Zero-width e seletor de variação: nunca são conteúdo sozinhos. Ficam FORA
 * da classe de caracteres de propósito — um combining mark dentro de classe
 * parte cluster de grafema (o ZWJ de familia/emoji composto), e a intenção
 * aqui é só decidir se sobrou texto, nunca reescrever a saída do modelo.
 */
const ZERO_WIDTH_PATTERN = /\u200b|\u200c|\u200d|\ufe0f/g
/** Glifos que CLIs colocam antes do prompt redesenhado. */
const PROMPT_PREFIX_PATTERN = /^(?:[│┃┆┊]\s*)*(?:[>›❯»]\s*)*/u

export interface TokenSpeedUsageEvent {
  /** Chave de dedupe estável do provider (sessionId:messageId). */
  key: string
  outputTokens: number
  model?: string | null
  /** epoch ms do evento no transcript, quando o provider expõe. */
  timestamp?: number | null
}

interface PendingUsage {
  key: string | null
  outputTokens: number
  model: string | null
}

interface OpenTurn {
  submittedAt: number | null
  firstTokenAt: number | null
  lastTokenAt: number
  tokens: number
  model: string | null
  /** Volátil: some no 1º token ou no fechamento da rodada. */
  echo: string | null
  /** Uso real pode chegar antes do timer que fecha a rodada. */
  pendingUsage: PendingUsage | null
}

/**
 * Amostra + a chave do evento de uso que a corrigiu. O provider REESCREVE a
 * mesma mensagem enquanto ela transmite (uma vez por bloco de conteúdo), e
 * cada reescrita traz um total de saída maior: por isso a chave atualiza a
 * MESMA amostra em vez de ser descartada como duplicata.
 */
interface HistoryEntry {
  sample: TokenSpeedSample
  usageKey: string | null
}

interface PaneState {
  paneId: string
  model: string | null
  turns: number
  history: HistoryEntry[]
  open: OpenTurn | null
  /** Linhas já vistas no pane (LRU pela ordem de inserção). */
  seenLines: Map<string, true>
}

/**
 * Teto físico de tok/s: guarda de sanidade, não régua de velocidade. Os
 * providers mais rápidos (Cerebras/Groq) ficam em poucos milhares e cabem
 * aqui; acima disso é a janela medida que está errada (35 mil tok/s num pane
 * parado, 23/09), e o número vira "—" em vez de mentir.
 */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 6_000

/**
 * Um TUI parado redesenha a tela inteira (resize, barra de status, foco, volta
 * ao workspace). Contar esse texto de novo abria rodada e mostrava tok/s num
 * terminal ocioso (operador, 23/09). Só linha NOVA é geração: linhas já vistas
 * no pane não viram token. Linhas curtas ("}", "ok") contam sempre — repetem
 * legitimamente e pesam pouco.
 */
const MIN_DEDUPED_LINE_CHARS = 8
const MAX_SEEN_LINES = 4_000
/** Saída sem submit só abre rodada com geração de verdade, não com sobra de repaint. */
export const MIN_UNPROMPTED_OPEN_TOKENS = 12

function unseenVisibleText(state: PaneState, visible: string): string {
  const kept: string[] = []
  for (const segment of visible.split('\n')) {
    const normalized = segment.replace(/\s+/g, ' ').trim()
    if (normalized.length < MIN_DEDUPED_LINE_CHARS) {
      kept.push(segment)
      continue
    }
    if (state.seenLines.has(normalized)) {
      state.seenLines.delete(normalized)
      state.seenLines.set(normalized, true)
      continue
    }
    state.seenLines.set(normalized, true)
    if (state.seenLines.size > MAX_SEEN_LINES) {
      const oldest = state.seenLines.keys().next().value
      if (oldest !== undefined) state.seenLines.delete(oldest)
    }
    kept.push(segment)
  }
  return kept.join('\n')
}

/** Texto visível de um chunk de PTY (sem ANSI, sem bytes de controle). */
export function visibleText(chunk: string): string {
  return stripAnsiEscapeSequences(chunk)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
}

/** Só moldura/spinner/espaço: repintura de TUI, não token do modelo. */
export function isTuiNoise(visible: string): boolean {
  const meaningful = visible
    .replace(TUI_GLYPH_PATTERN, '')
    .replace(ZERO_WIDTH_PATTERN, '')
    .trim()
  return meaningful.length === 0
}

function normalizeForEcho(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(PROMPT_PREFIX_PATTERN, '')
}

/**
 * O TUI redesenha o prompt submetido assim que ele entra. Esse repaint chega
 * em milissegundos e, sem este filtro, zeraria o TTFT de toda rodada.
 */
export function isPromptEcho(visible: string, echo: string | null): boolean {
  if (!echo) return false
  const candidate = normalizeForEcho(visible)
  if (candidate.length === 0) return true
  return echo.includes(candidate)
}

function estimateVisibleTokens(visible: string): number {
  const trimmed = visible.trim()
  if (trimmed.length === 0) return 0
  return Math.ceil(trimmed.length / CHARS_PER_TOKEN)
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function averageOf(values: number[]): number | null {
  if (values.length === 0) return null
  return round1(mean(values))
}

/**
 * Chave de agrupamento por modelo. `null`, string vazia e só-espaço são a
 * MESMA LLM não identificada — senão a tabela ganha linhas fantasma.
 */
export function modelKey(model: string | null | undefined): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  return trimmed.length > 0 ? trimmed : '\u0000unknown'
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function liveSpeedOf(lives: number[] | undefined): number | null {
  if (!lives || lives.length === 0) return null
  return round1(Math.max(...lives))
}

function liveScopeSpeed(panes: PaneTokenSpeed[]): number | null {
  const lives = panes
    .map((pane) => pane.liveTokensPerSecond)
    .filter((value): value is number => value !== null)
  return liveSpeedOf(lives)
}

export class TokenSpeedMeter {
  readonly idleCloseMs: number
  readonly historyLimit: number
  readonly recentWindow: number
  readonly minGenerationMs: number
  readonly minTurnTokens: number
  readonly usageMatchWindowMs: number

  #panes = new Map<string, PaneState>()

  constructor(options: TokenSpeedMeterOptions = {}) {
    this.idleCloseMs = positiveInt(
      options.idleCloseMs,
      TOKEN_SPEED_DEFAULTS.idleCloseMs,
    )
    this.historyLimit = positiveInt(
      options.historyLimit,
      TOKEN_SPEED_DEFAULTS.historyLimit,
    )
    this.recentWindow = positiveInt(
      options.recentWindow,
      TOKEN_SPEED_DEFAULTS.recentWindow,
    )
    this.minGenerationMs = positiveInt(
      options.minGenerationMs,
      TOKEN_SPEED_DEFAULTS.minGenerationMs,
    )
    this.minTurnTokens = positiveInt(
      options.minTurnTokens,
      TOKEN_SPEED_DEFAULTS.minTurnTokens,
    )
    this.usageMatchWindowMs = positiveInt(
      options.usageMatchWindowMs,
      TOKEN_SPEED_DEFAULTS.usageMatchWindowMs,
    )
  }

  #state(paneId: string): PaneState {
    const existing = this.#panes.get(paneId)
    if (existing) return existing
    const created: PaneState = {
      paneId,
      model: null,
      turns: 0,
      history: [],
      open: null,
      seenLines: new Map(),
    }
    this.#panes.set(paneId, created)
    return created
  }

  /**
   * Prompt entregue ao pane (digitado pelo humano ou injetado pelo Main).
   * Fecha a rodada anterior — um submit novo encerra a geração em curso.
   */
  noteSubmit(paneId: string, at: number, promptText = ''): boolean {
    if (!paneId || !Number.isFinite(at)) return false
    const state = this.#state(paneId)
    const closed = this.#closeTurn(state)
    state.open = {
      submittedAt: at,
      firstTokenAt: null,
      lastTokenAt: at,
      tokens: 0,
      model: state.model,
      echo: normalizeForEcho(promptText).slice(0, PROMPT_ECHO_MEMORY_CHARS),
      pendingUsage: null,
    }
    return closed
  }

  /** Chunk de saída do PTY. Retorna true quando virou medição. */
  noteOutput(
    paneId: string,
    at: number,
    chunk: string,
    model?: string | null,
  ): boolean {
    if (!paneId || !Number.isFinite(at) || chunk.length === 0) return false
    const state = this.#state(paneId)
    if (typeof model === 'string' && model.length > 0) state.model = model

    const visible = visibleText(chunk)
    if (isTuiNoise(visible)) return false

    let open = state.open
    if (open && open.firstTokenAt === null && isPromptEcho(visible, open.echo)) {
      // Eco do prompt: não é o 1º token, e não pode empurrar o relógio.
      return false
    }
    if (
      open &&
      open.firstTokenAt !== null &&
      this.#isSilent(open.lastTokenAt, at)
    ) {
      // Rodada anterior gerou e emudeceu, mas ninguém chamou flushIdle (timer
      // atrasado, máquina suspensa, app em segundo plano). Sem este corte ela
      // absorveria a resposta seguinte e diluiria tok/s pelo tempo ocioso.
      this.#closeTurn(state)
      open = null
    }

    const tokens = estimateVisibleTokens(unseenVisibleText(state, visible))
    if (tokens === 0) return false

    if (!open) {
      if (tokens < MIN_UNPROMPTED_OPEN_TOKENS) return false
      // Saída sem submit observado (boot, retomada de tool call, agente
      // autônomo): mede geração, mas TTFT fica honestamente ausente.
      state.open = {
        submittedAt: null,
        firstTokenAt: at,
        lastTokenAt: at,
        tokens,
        model: state.model,
        echo: null,
        pendingUsage: null,
      }
      return true
    }

    if (open.firstTokenAt === null) {
      open.firstTokenAt = at
      open.echo = null
    }
    open.tokens += tokens
    open.lastTokenAt = Math.max(open.lastTokenAt, at)
    open.model = state.model ?? open.model
    return true
  }

  /**
   * Contagem exata do transcript do provider corrige a última amostra
   * estimada do pane. Sem amostra na janela, o evento é ignorado: timing
   * inventado seria pior que métrica ausente.
   */
  noteUsage(paneId: string, at: number, event: TokenSpeedUsageEvent): boolean {
    if (!paneId || !Number.isFinite(at)) return false
    if (!Number.isFinite(event.outputTokens) || event.outputTokens <= 0) {
      return false
    }
    const state = this.#panes.get(paneId)
    if (!state) return false
    const outputTokens = Math.round(event.outputTokens)
    const key = event.key || null

    const ownedIndex = key
      ? state.history.findIndex((entry) => entry.usageKey === key)
      : -1
    if (ownedIndex >= 0) {
      return this.#updateHistoryUsage(
        state,
        ownedIndex,
        key,
        outputTokens,
        event.model,
      )
    }

    const open = state.open
    if (open?.pendingUsage && open.pendingUsage.key === key) {
      if (
        open.pendingUsage.outputTokens === outputTokens &&
        open.pendingUsage.model === (event.model ?? open.pendingUsage.model)
      ) {
        return false
      }
      open.pendingUsage = {
        key,
        outputTokens,
        model: event.model ?? open.pendingUsage.model,
      }
      return true
    }

    if (open && this.#usageFitsOpenTurn(open, at)) {
      open.pendingUsage = {
        key,
        outputTokens,
        model: event.model ?? open.model ?? state.model,
      }
      return true
    }

    const index = this.#usageTargetIndex(state, at, key)
    if (index === null) return false
    return this.#updateHistoryUsage(
      state,
      index,
      key,
      outputTokens,
      event.model,
    )
  }

  #updateHistoryUsage(
    state: PaneState,
    index: number,
    key: string | null,
    outputTokens: number,
    model: string | null | undefined,
  ): boolean {
    const entry = state.history[index]
    if (
      entry.sample.source === 'real' &&
      entry.sample.outputTokens === outputTokens &&
      entry.usageKey === key &&
      entry.sample.model === (model ?? entry.sample.model)
    ) {
      return false
    }
    state.history = state.history.map((current, position) =>
      position === index
        ? {
            usageKey: key,
            sample: {
              ...current.sample,
              outputTokens,
              ...this.#rateFor(
                outputTokens,
                current.sample.generationMs,
                current.sample.ttftMs,
                true,
              ),
              model: model ?? current.sample.model,
              source: 'real' as const,
            },
          }
        : current,
    )
    return true
  }

  #usageFitsOpenTurn(open: OpenTurn, at: number): boolean {
    const startedAt =
      open.submittedAt ?? open.firstTokenAt ?? open.lastTokenAt
    if (at < startedAt) return false
    return at - open.lastTokenAt <= this.usageMatchWindowMs
  }

  /**
   * Alvo da correção: a amostra que JÁ pertence a esta chave (reescrita de
   * streaming) ou, na falta dela, a estimativa mais recente dentro da janela.
   */
  #usageTargetIndex(
    state: PaneState,
    at: number,
    key: string | null,
  ): number | null {
    if (key) {
      const owned = state.history.findIndex((entry) => entry.usageKey === key)
      if (owned >= 0) return owned
    }
    let nearestIndex: number | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < state.history.length; index += 1) {
      const entry = state.history[index]
      if (entry.sample.source === 'real') continue
      const distance = Math.abs(at - entry.sample.at)
      if (
        distance <= this.usageMatchWindowMs &&
        distance < nearestDistance
      ) {
        nearestIndex = index
        nearestDistance = distance
      }
    }
    return nearestIndex
  }

  /** Pane/sessão morreu: fecha o que dava e some com o estado. */
  forget(paneId: string): boolean {
    const state = this.#panes.get(paneId)
    if (!state) return false
    this.#closeTurn(state)
    this.#panes.delete(paneId)
    return true
  }

  /**
   * Fecha rodadas que ficaram em silêncio. Retorna true se algo mudou.
   *
   * Uma rodada que AINDA ESPERA o 1º token nunca é fechada aqui: o silêncio
   * entre o submit e o 1º token É o TTFT que queremos medir, e ele passa dos
   * segundos em qualquer modelo real. Fechá-la destruiria justamente a
   * métrica principal — só o próximo submit ou o fim do pane a encerram.
   */
  flushIdle(now: number): boolean {
    let changed = false
    for (const state of this.#panes.values()) {
      const open = state.open
      if (!open || open.firstTokenAt === null) continue
      if (!this.#isSilent(open.lastTokenAt, now)) continue
      if (this.#closeTurn(state)) changed = true
    }
    return changed
  }

  /** Fotografia do escopo. Fecha antes as rodadas já ociosas. */
  snapshot(now: number): TokenSpeedSnapshot {
    this.flushIdle(now)
    const panes: PaneTokenSpeed[] = []
    const streamingModels = new Map<
      string,
      { model: string | null; paneIds: Set<string>; lives: number[] }
    >()
    let merged: TokenSpeedSample[] = []
    let turns = 0
    let streaming = false

    for (const state of [...this.#panes.values()].sort((a, b) =>
      a.paneId.localeCompare(b.paneId),
    )) {
      const samples = state.history.map((entry) => entry.sample)
      const recent = samples.slice(-this.recentWindow)
      const speeds = recent
        .map((sample) => sample.tokensPerSecond)
        .filter((value): value is number => value !== null)
      const paneStreaming = this.#paneStreaming(state, now)
      const liveTokensPerSecond = this.#liveSpeed(state, now)
      streaming ||= paneStreaming
      if (paneStreaming) {
        // O modelo que está gerando AGORA é o da rodada aberta, que pode já
        // ser diferente do modelo da última rodada fechada.
        const liveModel = state.open?.model ?? state.model
        const key = modelKey(liveModel)
        const live = streamingModels.get(key)
        if (live) {
          live.paneIds.add(state.paneId)
          if (liveTokensPerSecond !== null) live.lives.push(liveTokensPerSecond)
        } else {
          streamingModels.set(key, {
            model: liveModel,
            paneIds: new Set([state.paneId]),
            lives:
              liveTokensPerSecond !== null ? [liveTokensPerSecond] : [],
          })
        }
      }
      turns += state.turns
      merged = [...merged, ...samples]
      const last = samples.at(-1) ?? null
      panes.push({
        paneId: state.paneId,
        model: last?.model ?? state.model,
        turns: state.turns,
        last,
        averageTokensPerSecond: averageOf(speeds),
        peakTokensPerSecond: speeds.length > 0 ? round1(Math.max(...speeds)) : null,
        lastTtftMs: last?.ttftMs ?? null,
        streaming: paneStreaming,
        liveTokensPerSecond,
        history: samples,
      })
    }

    const ordered = merged.sort((a, b) => a.at - b.at)
    const models = this.#aggregateByModel(ordered, streamingModels)
    const recent = ordered.slice(-this.recentWindow)
    const speeds = recent
      .map((sample) => sample.tokensPerSecond)
      .filter((value): value is number => value !== null)

    return {
      generatedAt: now,
      recentWindow: this.recentWindow,
      last: ordered.at(-1) ?? null,
      averageTokensPerSecond: averageOf(speeds),
      peakTokensPerSecond: speeds.length > 0 ? round1(Math.max(...speeds)) : null,
      turns,
      streaming,
      liveTokensPerSecond: liveScopeSpeed(panes),
      panes,
      models,
    }
  }

  /**
   * Um item por LLM. A chave é o modelo REGISTRADO NA AMOSTRA, não o modelo
   * atual do pane: quem troca de modelo no meio da sessão não reescreve o
   * passado, e as duas LLMs aparecem com seus próprios números.
   *
   * Ordem: atividade mais recente primeiro, desempate por nome — determinístico
   * mesmo com amostras no mesmo milissegundo.
   */
  #aggregateByModel(
    ordered: TokenSpeedSample[],
    streamingModels: Map<
      string,
      { model: string | null; paneIds: Set<string>; lives: number[] }
    >,
  ): ModelTokenSpeed[] {
    const groups = new Map<string, TokenSpeedSample[]>()
    for (const sample of ordered) {
      const key = modelKey(sample.model)
      groups.set(key, [...(groups.get(key) ?? []), sample])
    }

    const models: ModelTokenSpeed[] = []
    for (const [key, samples] of groups) {
      const history = samples.slice(-this.historyLimit)
      const last = samples.at(-1) ?? null
      const recent = samples.slice(-this.recentWindow)
      const speeds = recent
        .map((sample) => sample.tokensPerSecond)
        .filter((value): value is number => value !== null)
      // Pico sobre TODO o histórico retido: o teto observado de uma LLM não
      // deve evaporar só porque saiu da janela das últimas N.
      const allSpeeds = samples
        .map((sample) => sample.tokensPerSecond)
        .filter((value): value is number => value !== null)
      const ttfts = recent
        .map((sample) => sample.ttftMs)
        .filter((value): value is number => value !== null)
      const model = last?.model ?? null
      const live = streamingModels.get(key)
      models.push({
        model,
        turns: samples.length,
        paneCount: new Set([
          ...samples.map((sample) => sample.paneId),
          ...(live?.paneIds ?? []),
        ]).size,
        last,
        averageTokensPerSecond: averageOf(speeds),
        peakTokensPerSecond:
          allSpeeds.length > 0 ? round1(Math.max(...allSpeeds)) : null,
        averageTtftMs: ttfts.length > 0 ? Math.round(mean(ttfts)) : null,
        lastTtftMs: last?.ttftMs ?? null,
        streaming: live !== undefined,
        liveTokensPerSecond: liveSpeedOf(live?.lives),
        history,
      })
    }

    // Uma LLM que está gerando a PRIMEIRA resposta ainda não tem rodada
    // fechada. Sem esta linha, o monitor ficaria mudo justamente no momento
    // em que há algo acontecendo.
    for (const [key, live] of streamingModels) {
      if (groups.has(key)) continue
      models.push({
        model: live.model,
        turns: 0,
        paneCount: live.paneIds.size,
        last: null,
        averageTokensPerSecond: null,
        peakTokensPerSecond: null,
        averageTtftMs: null,
        lastTtftMs: null,
        streaming: true,
        liveTokensPerSecond: liveSpeedOf(live.lives),
        history: [],
      })
    }

    return models.sort((a, b) => {
      // Quem está gerando agora vem primeiro: é um monitor ao vivo.
      if (a.streaming !== b.streaming) return a.streaming ? -1 : 1
      const byRecency = (b.last?.at ?? 0) - (a.last?.at ?? 0)
      if (byRecency !== 0) return byRecency
      return modelKey(a.model).localeCompare(modelKey(b.model))
    })
  }

  /**
   * Fronteira do silêncio, em um lugar só: um intervalo de EXATAMENTE
   * `idleCloseMs` já encerra a rodada. `flushIdle`, o corte de rodada
   * obsoleta e o indicador de streaming compartilham esta régua — se cada um
   * arredondasse do seu jeito, um turno poderia ser contado duas vezes.
   */
  #isSilent(since: number, now: number): boolean {
    return now - since >= this.idleCloseMs
  }

  #paneStreaming(state: PaneState, now: number): boolean {
    const open = state.open
    if (!open || open.firstTokenAt === null) return false
    return !this.#isSilent(open.lastTokenAt, now)
  }

  /**
   * tok/s da rodada aberta neste instante. Relógio é `now` (velocímetro),
   * não o último chunk — senão o número congela entre bytes do PTY.
   */
  #liveSpeed(state: PaneState, now: number): number | null {
    const open = state.open
    if (!open || open.firstTokenAt === null) return null
    if (this.#isSilent(open.lastTokenAt, now)) return null
    const tokens = open.pendingUsage?.outputTokens ?? open.tokens
    if (tokens < this.minTurnTokens) return null
    const ttftMs =
      open.submittedAt !== null && open.firstTokenAt >= open.submittedAt
        ? open.firstTokenAt - open.submittedAt
        : null
    return this.#rateFor(
      tokens,
      Math.max(0, now - open.firstTokenAt),
      ttftMs,
      open.pendingUsage !== null,
    ).tokensPerSecond
  }

  #speedOf(outputTokens: number, generationMs: number): number | null {
    if (outputTokens <= 0) return null
    if (generationMs < this.minGenerationMs) return null
    const rate = (outputTokens / generationMs) * 1_000
    // Acima de qualquer provider real: a janela medida não sustenta a
    // contagem (ex.: 2 mil tokens do transcript sobre 57 ms de tela davam
    // 35 mil tok/s num pane parado). Métrica ausente, nunca número falso.
    if (rate > MAX_PLAUSIBLE_TOKENS_PER_SECOND) return null
    return round1(rate)
  }

  /**
   * Janela e taxa de uma amostra — um lugar só para fechamento, correção pelo
   * transcript e velocímetro ao vivo.
   * - Estimativa: tokens vistos / janela do 1º ao último texto na tela.
   * - Contagem REAL do transcript: inclui pensamento e tool calls gerados no
   *   silêncio antes do 1º texto, então a janela vai do submit ao último
   *   token. Dividir pela janela da tela dava 35 mil tok/s (23/09).
   * - Real SEM submit visto (prompt por argv, retomada): o início da geração
   *   é desconhecido; não há janela honesta e a taxa fica null.
   */
  #rateFor(
    outputTokens: number,
    generationMs: number,
    ttftMs: number | null,
    real: boolean,
  ): { rateWindowMs: number | null; tokensPerSecond: number | null } {
    if (!real) {
      return {
        rateWindowMs: generationMs,
        tokensPerSecond: this.#speedOf(outputTokens, generationMs),
      }
    }
    if (ttftMs === null) return { rateWindowMs: null, tokensPerSecond: null }
    const rateWindowMs = ttftMs + generationMs
    return {
      rateWindowMs,
      tokensPerSecond: this.#speedOf(outputTokens, rateWindowMs),
    }
  }

  #closeTurn(state: PaneState): boolean {
    const open = state.open
    state.open = null
    if (!open || open.firstTokenAt === null) return false
    if (!open.pendingUsage && open.tokens < this.minTurnTokens) return false

    const endedAt = Math.max(open.lastTokenAt, open.firstTokenAt)
    const generationMs = Math.max(0, endedAt - open.firstTokenAt)
    const ttftMs =
      open.submittedAt !== null && open.firstTokenAt >= open.submittedAt
        ? open.firstTokenAt - open.submittedAt
        : null
    const outputTokens = open.pendingUsage?.outputTokens ?? open.tokens
    const sample: TokenSpeedSample = {
      paneId: state.paneId,
      // Marca o ÚLTIMO token, não o instante em que o fechamento foi
      // percebido: o atraso do detector de ocioso não é tempo de geração.
      at: endedAt,
      startedAt: open.submittedAt ?? open.firstTokenAt,
      outputTokens,
      generationMs,
      ...this.#rateFor(
        outputTokens,
        generationMs,
        ttftMs,
        open.pendingUsage !== null,
      ),
      ttftMs,
      model: open.pendingUsage?.model ?? open.model ?? state.model,
      source: open.pendingUsage ? 'real' : 'estimated',
    }
    state.history = [
      ...state.history,
      { sample, usageKey: open.pendingUsage?.key ?? null },
    ].slice(-this.historyLimit)
    state.turns += 1
    return true
  }
}

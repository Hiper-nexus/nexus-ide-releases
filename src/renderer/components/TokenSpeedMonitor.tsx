import { useMemo } from 'react'
import {
  TOKEN_SPEED_EMPTY_LABEL,
  modelLabel,
  type ModelTokenSpeed,
  type PaneTokenSpeed,
  type TokenSpeedSample,
  type TokenSpeedSnapshot,
} from '../../shared/token-speed-types'
import { useTokenSpeedStore } from '../state/token-speed-store'
import { PixelIcon } from './PixelIcon'

/**
 * Monitor de velocidade de geração: quanto o modelo cospe por segundo NESTA
 * rodada, quanto demorou até o 1º token, média/pico das últimas N e a curva.
 *
 * Regra de honestidade herdada do medidor: métrica ausente aparece como "—".
 * A UI nunca inventa 0, nunca mostra NaN, e diz de onde veio o número
 * (transcript do provider = real; stream do PTY = estimado).
 */

export function formatSpeed(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return TOKEN_SPEED_EMPTY_LABEL
  if (value >= 100) return String(Math.round(value))
  return value.toFixed(1)
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return TOKEN_SPEED_EMPTY_LABEL
  }
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(1)} s`
}

export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return TOKEN_SPEED_EMPTY_LABEL
  if (value < 10_000) return String(Math.round(value))
  return `${(value / 1_000).toFixed(1)}k`
}

export function formatClock(epochMs: number | null): string {
  if (!epochMs || !Number.isFinite(epochMs)) return TOKEN_SPEED_EMPTY_LABEL
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false })
}

export interface TokenSpeedView {
  last: TokenSpeedSample | null
  averageTokensPerSecond: number | null
  peakTokensPerSecond: number | null
  turns: number
  streaming: boolean
  recentWindow: number
  history: TokenSpeedSample[]
  /** Escopo exibido: um pane específico ou o workspace inteiro. */
  scopeLabel: string
}

/**
 * Seleciona o recorte exibido. `paneId` ausente (ou desconhecido) recai no
 * agregado do workspace em vez de sumir com o painel.
 */
export function deriveTokenSpeedView(
  snapshot: TokenSpeedSnapshot,
  paneId?: string | null,
): TokenSpeedView {
  const pane: PaneTokenSpeed | undefined = paneId
    ? snapshot.panes.find((entry) => entry.paneId === paneId)
    : undefined
  if (pane) {
    return {
      last: pane.last,
      averageTokensPerSecond: pane.averageTokensPerSecond,
      peakTokensPerSecond: pane.peakTokensPerSecond,
      turns: pane.turns,
      streaming: pane.streaming,
      recentWindow: snapshot.recentWindow,
      history: pane.history,
      scopeLabel: 'Pane atual',
    }
  }
  const history = snapshot.panes
    .flatMap((entry) => entry.history)
    .sort((a, b) => a.at - b.at)
  return {
    last: snapshot.last,
    averageTokensPerSecond: snapshot.averageTokensPerSecond,
    peakTokensPerSecond: snapshot.peakTokensPerSecond,
    turns: snapshot.turns,
    streaming: snapshot.streaming,
    recentWindow: snapshot.recentWindow,
    history,
    scopeLabel: 'Workspace',
  }
}

/** Pontos normalizados da curva (0..100 em x e y, y invertido para SVG). */
export function sparklinePoints(
  samples: TokenSpeedSample[],
  limit: number,
): { points: string; peak: number } | null {
  const speeds = samples
    .slice(-Math.max(2, limit))
    .map((sample) => sample.tokensPerSecond)
    .filter((value): value is number => value !== null && value > 0)
  if (speeds.length < 2) return null
  const peak = Math.max(...speeds)
  const span = speeds.length - 1
  const points = speeds
    .map((value, index) => {
      const x = (index / span) * 100
      const y = 100 - (value / peak) * 100
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return { points, peak }
}

function SourceTag({ sample }: { sample: TokenSpeedSample | null }) {
  if (!sample) {
    return (
      <span className="tokspeed__source" title="Nenhuma rodada medida ainda.">
        Aguardando dados
      </span>
    )
  }
  const real = sample?.source === 'real'
  return (
    <span
      className={`tokspeed__source${real ? ' tokspeed__source--real' : ''}`}
      title={
        real
          ? 'Tokens contados pelo transcript do provider (exato).'
          : 'Tokens estimados pelo stream do terminal (ordem de grandeza).'
      }
    >
      {real ? 'Dados reais · transcript' : 'Estimado · stream do terminal'}
    </span>
  )
}

function Tile({
  label,
  value,
  unit,
  detail,
}: {
  label: string
  value: string
  unit?: string
  detail?: string
}) {
  return (
    <div className="tokspeed__tile">
      <span className="tokspeed__tile-label">{label}</span>
      <span className="tokspeed__tile-value">
        {value}
        {unit ? <em className="tokspeed__unit">{unit}</em> : null}
      </span>
      {detail ? <span className="tokspeed__tile-detail">{detail}</span> : null}
    </div>
  )
}

function Curve({ view }: { view: TokenSpeedView }) {
  const curve = useMemo(
    () => sparklinePoints(view.history, Math.max(view.recentWindow, 12)),
    [view.history, view.recentWindow],
  )
  return (
    <div className="tokspeed__curve">
      <div className="tokspeed__curve-head">
        <span>Curva de velocidade de geração</span>
        <span className="tokspeed__curve-legend">
          tok/s · últimas {Math.max(view.recentWindow, 12)}
        </span>
      </div>
      {curve ? (
        <svg
          className="tokspeed__curve-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Curva de velocidade, pico ${formatSpeed(curve.peak)} tokens por segundo`}
        >
          <polyline points={curve.points} vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <p className="tokspeed__empty">
          Duas rodadas medidas desenham a curva.
        </p>
      )}
      {curve ? (
        <span className="tokspeed__curve-peak">{formatSpeed(curve.peak)}</span>
      ) : null}
    </div>
  )
}

/**
 * Comparativo por LLM. A ordem vem do Main (gerando agora primeiro, depois
 * atividade mais recente) — a UI não reordena, para a linha não pular de
 * lugar entre dois snapshots.
 */
function ModelTable({ models }: { models: ModelTokenSpeed[] }) {
  if (models.length === 0) return null
  return (
    <div className="tokspeed__models">
      <div className="tokspeed__models-head">
        <span>Por LLM</span>
        <span className="tokspeed__curve-legend">
          {models.length} {models.length === 1 ? 'modelo' : 'modelos'}
        </span>
      </div>
      <table className="tokspeed__table">
        <thead>
          <tr>
            <th scope="col">Modelo</th>
            <th scope="col">Última</th>
            <th scope="col">Média</th>
            <th scope="col">Pico</th>
            <th scope="col">TTFT</th>
            <th scope="col">Rodadas</th>
          </tr>
        </thead>
        <tbody>
          {models.map((entry) => (
            <tr
              key={modelLabel(entry.model)}
              data-streaming={entry.streaming ? 'on' : 'off'}
            >
              <th scope="row" title={modelLabel(entry.model)}>
                {entry.streaming ? (
                  <span className="tokspeed__dot" aria-label="gerando agora" />
                ) : null}
                {modelLabel(entry.model)}
              </th>
              <td>{formatSpeed(entry.last?.tokensPerSecond ?? null)}</td>
              <td>{formatSpeed(entry.averageTokensPerSecond)}</td>
              <td>{formatSpeed(entry.peakTokensPerSecond)}</td>
              <td>{formatMs(entry.averageTtftMs)}</td>
              <td>
                {entry.turns}
                {entry.paneCount > 1 ? (
                  <em
                    className="tokspeed__unit"
                    title={`${entry.paneCount} panes usaram este modelo`}
                  >
                    /{entry.paneCount}p
                  </em>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tokspeed__note">
        Média e TTFT das últimas rodadas; pico é o melhor já observado.
      </p>
    </div>
  )
}

/** Painel completo, no formato do monitor que inspirou a peça. */
export function TokenSpeedMonitor({ paneId }: { paneId?: string | null }) {
  const snapshot = useTokenSpeedStore((s) => s.snapshot)
  const view = useMemo(
    () => deriveTokenSpeedView(snapshot, paneId),
    [snapshot, paneId],
  )
  const last = view.last

  return (
    <section
      className="tokspeed"
      data-streaming={view.streaming ? 'on' : 'off'}
      aria-label="Velocidade de tokens"
    >
      <header className="tokspeed__head">
        <span className="tokspeed__title">
          <PixelIcon name="bolt" size={12} /> Velocidade de tokens
        </span>
        <span className="tokspeed__clock">
          <span className="tokspeed__dot" aria-hidden="true" />
          {formatClock(last?.at ?? null)}
        </span>
      </header>

      <div className="tokspeed__meta">
        <SourceTag sample={last} />
        <span className="tokspeed__scope">{view.scopeLabel}</span>
      </div>

      <div className="tokspeed__hero">
        <span className="tokspeed__hero-label">
          Velocidade da última resposta
        </span>
        <span className="tokspeed__hero-value">
          {formatSpeed(last?.tokensPerSecond ?? null)}
          <em className="tokspeed__unit">tok/s</em>
        </span>
        <span className="tokspeed__hero-detail">
          {last
            ? `${modelLabel(last.model)} · saída ${formatTokens(last.outputTokens)} tok · geração ${formatMs(last.generationMs)}`
            : 'Nenhuma rodada medida ainda nesta sessão.'}
        </span>
      </div>

      <div className="tokspeed__hero tokspeed__hero--secondary">
        <span className="tokspeed__hero-label">Latência do 1º token (TTFT)</span>
        <span className="tokspeed__hero-value">
          {formatMs(last?.ttftMs ?? null)}
        </span>
        <span className="tokspeed__hero-detail">
          {last?.ttftMs === null || last === null
            ? 'Sem submit observado nesta rodada.'
            : 'Tempo até o modelo começar a responder.'}
        </span>
      </div>

      <div className="tokspeed__grid">
        <Tile
          label={`Média últimas ${view.recentWindow}`}
          value={formatSpeed(view.averageTokensPerSecond)}
          unit="tok/s"
        />
        <Tile
          label={`Pico últimas ${view.recentWindow}`}
          value={formatSpeed(view.peakTokensPerSecond)}
          unit="tok/s"
        />
        <Tile
          label="Saída última rodada"
          value={formatTokens(last?.outputTokens ?? null)}
          unit="tok"
        />
        <Tile
          label="Rodadas na sessão"
          value={String(view.turns)}
          unit={view.turns === 1 ? 'rodada' : 'rodadas'}
        />
      </div>

      <Curve view={view} />
      <ModelTable models={snapshot.models} />
    </section>
  )
}

/**
 * Versão compacta para a toolbar de um pane.
 *
 * Diferente do painel, aqui a busca é ESTRITA: um pane sem medição não cai no
 * agregado do workspace, porque exibir na barra do pane A o número que o pane
 * B produziu é atribuir a ele uma velocidade que ele nunca teve. Em repouso,
 * o chip exibe o estado pronto ('— tok/s') sem inventar números.
 */
export function TokenSpeedChip({ paneId }: { paneId?: string | null }) {
  const snapshot = useTokenSpeedStore((s) => s.snapshot)
  const own = paneId
    ? snapshot.panes.find((entry) => entry.paneId === paneId)
    : undefined
  const view = paneId
    ? own
      ? deriveTokenSpeedView(snapshot, paneId)
      : null
    : deriveTokenSpeedView(snapshot, null)

  const speed = view?.last?.tokensPerSecond ?? null
  const streaming = view?.streaming ?? false
  const turns = view?.turns ?? 0
  const isIdle = !view?.last && !streaming
  const kind = streaming ? 'live' : view?.last ? 'last' : 'idle'

  const title = streaming
    ? `Ao vivo: ${formatSpeed(speed)} tok/s nesta rodada`
    : view?.last
      ? `Última rodada: ${formatSpeed(speed)} tok/s · TTFT ${formatMs(view.last?.ttftMs ?? null)} · ${turns} rodada(s) — não é o agora`
      : 'Velocidade do modelo: aguardando resposta para medir tok/s e TTFT'

  return (
    <span
      className="tokspeed-chip"
      data-streaming={streaming ? 'on' : 'off'}
      data-kind={kind}
      data-idle={isIdle ? 'true' : undefined}
      title={title}
    >
      <PixelIcon name="bolt" size={10} />
      {formatSpeed(speed)}
      <em className="tokspeed__unit">tok/s</em>
    </span>
  )
}

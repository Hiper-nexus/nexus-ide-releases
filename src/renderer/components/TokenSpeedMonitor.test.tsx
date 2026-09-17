/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EMPTY_TOKEN_SPEED_SNAPSHOT,
  type ModelTokenSpeed,
  type TokenSpeedSample,
  type TokenSpeedSnapshot,
} from '../../shared/token-speed-types'
import {
  TokenSpeedChip,
  TokenSpeedMonitor,
  deriveTokenSpeedView,
  formatMs,
  formatSpeed,
  formatTokens,
  sparklinePoints,
} from './TokenSpeedMonitor'
import { useTokenSpeedStore } from '../state/token-speed-store'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function sample(over: Partial<TokenSpeedSample> = {}): TokenSpeedSample {
  return {
    paneId: 'p1',
    at: 1_000,
    startedAt: 0,
    outputTokens: 403,
    generationMs: 1_300,
    tokensPerSecond: 310,
    ttftMs: 5_200,
    model: 'gemini-3.8-flash-high',
    source: 'estimated',
    ...over,
  }
}

function snapshot(over: Partial<TokenSpeedSnapshot> = {}): TokenSpeedSnapshot {
  return { ...EMPTY_TOKEN_SPEED_SNAPSHOT, generatedAt: 2_000, ...over }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useTokenSpeedStore.getState().reset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useTokenSpeedStore.getState().reset()
})

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

describe('formatadores', () => {
  it('nunca imprime NaN, Infinity ou zero falso', () => {
    expect(formatSpeed(null)).toBe('—')
    expect(formatSpeed(Number.NaN)).toBe('—')
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatSpeed(12.34)).toBe('12.3')
    expect(formatSpeed(547.6)).toBe('548')
    expect(formatMs(null)).toBe('—')
    expect(formatMs(-5)).toBe('—')
    expect(formatMs(420)).toBe('420 ms')
    expect(formatMs(5_200)).toBe('5.2 s')
    expect(formatTokens(null)).toBe('—')
    expect(formatTokens(403)).toBe('403')
    expect(formatTokens(12_400)).toBe('12.4k')
  })
})

describe('deriveTokenSpeedView', () => {
  it('sem paneId cai no agregado do workspace', () => {
    const view = deriveTokenSpeedView(
      snapshot({ last: sample(), turns: 3, averageTokensPerSecond: 136.1 }),
    )
    expect(view.scopeLabel).toBe('Workspace')
    expect(view.turns).toBe(3)
    expect(view.averageTokensPerSecond).toBe(136.1)
  })

  it('paneId conhecido recorta o pane', () => {
    const view = deriveTokenSpeedView(
      snapshot({
        turns: 5,
        panes: [
          {
            paneId: 'p1',
            model: 'm',
            turns: 2,
            last: sample(),
            averageTokensPerSecond: 200,
            peakTokensPerSecond: 310,
            lastTtftMs: 5_200,
            streaming: true,
            history: [sample()],
          },
        ],
      }),
      'p1',
    )
    expect(view.scopeLabel).toBe('Pane atual')
    expect(view.turns).toBe(2)
    expect(view.streaming).toBe(true)
  })

  it('paneId desconhecido cai no workspace em vez de sumir', () => {
    const view = deriveTokenSpeedView(snapshot({ turns: 7 }), 'fantasma')
    expect(view.scopeLabel).toBe('Workspace')
    expect(view.turns).toBe(7)
  })
})

describe('sparklinePoints', () => {
  it('exige duas medições válidas', () => {
    expect(sparklinePoints([], 12)).toBeNull()
    expect(sparklinePoints([sample()], 12)).toBeNull()
    expect(
      sparklinePoints([sample({ tokensPerSecond: null }), sample()], 12),
    ).toBeNull()
  })

  it('normaliza pelo pico sem dividir por zero', () => {
    const curve = sparklinePoints(
      [
        sample({ tokensPerSecond: 50 }),
        sample({ tokensPerSecond: 100 }),
        sample({ tokensPerSecond: 0 }),
      ],
      12,
    )
    expect(curve).toEqual({ points: '0.00,50.00 100.00,0.00', peak: 100 })
  })
})

describe('TokenSpeedMonitor', () => {
  it('estado vazio mostra travessões e convite, sem quebrar', () => {
    render(<TokenSpeedMonitor />)
    const text = container.textContent ?? ''
    expect(text).toContain('Velocidade da última resposta')
    expect(text).toContain('—')
    expect(text).toContain('Nenhuma rodada medida ainda nesta sessão.')
    expect(text).not.toContain('NaN')
  })

  it('renderiza a rodada medida com modelo, TTFT e procedência', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(
        snapshot({
          last: sample({ source: 'real' }),
          turns: 5,
          averageTokensPerSecond: 136.1,
          peakTokensPerSecond: 547.6,
          recentWindow: 5,
          panes: [
            {
              paneId: 'p1',
              model: 'gemini-3.8-flash-high',
              turns: 5,
              last: sample({ source: 'real' }),
              averageTokensPerSecond: 136.1,
              peakTokensPerSecond: 547.6,
              lastTtftMs: 5_200,
              streaming: false,
              history: [
                sample({ tokensPerSecond: 90 }),
                sample({ tokensPerSecond: 310 }),
              ],
            },
          ],
        }),
      )
    })
    render(<TokenSpeedMonitor />)
    const text = container.textContent ?? ''
    expect(text).toContain('310')
    expect(text).toContain('5.2 s')
    expect(text).toContain('gemini-3.8-flash-high')
    expect(text).toContain('Dados reais · transcript')
    expect(text).toContain('Média últimas 5')
    expect(container.querySelector('polyline')).not.toBeNull()
  })

  it('marca streaming na raiz para o pulso do indicador', () => {
    act(() => {
      useTokenSpeedStore
        .getState()
        .receive(snapshot({ last: sample(), streaming: true }))
    })
    render(<TokenSpeedMonitor />)
    expect(
      container.querySelector('.tokspeed')?.getAttribute('data-streaming'),
    ).toBe('on')
  })
})

describe('TokenSpeedChip', () => {
  it('não ocupa espaço enquanto não houver medição', () => {
    render(<TokenSpeedChip />)
    expect(container.querySelector('.tokspeed-chip')).toBeNull()
  })

  it('aparece com a última velocidade medida', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(snapshot({ last: sample() }))
    })
    render(<TokenSpeedChip />)
    expect(container.querySelector('.tokspeed-chip')?.textContent).toContain(
      '310',
    )
  })
})

function modelRow(over: Partial<ModelTokenSpeed> = {}): ModelTokenSpeed {
  return {
    model: 'gpt-5',
    turns: 3,
    paneCount: 1,
    last: sample(),
    averageTokensPerSecond: 136.1,
    peakTokensPerSecond: 547.6,
    averageTtftMs: 4_800,
    lastTtftMs: 5_200,
    streaming: false,
    history: [sample()],
    ...over,
  }
}

function rowsText(): string[] {
  return [...container.querySelectorAll('.tokspeed__table tbody tr')].map(
    (row) =>
      [...row.querySelectorAll('th, td')]
        .map((cell) => cell.textContent?.trim() ?? '')
        .join('|'),
  )
}

describe('TokenSpeedMonitor — comparativo por LLM', () => {
  it('sem modelos a tabela não é renderizada', () => {
    render(<TokenSpeedMonitor />)
    expect(container.querySelector('.tokspeed__table')).toBeNull()
  })

  it('uma linha por LLM, com os números de cada uma', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(
        snapshot({
          last: sample(),
          models: [
            modelRow({
              model: 'gpt-5',
              averageTokensPerSecond: 50,
              peakTokensPerSecond: 80,
              averageTtftMs: 900,
              turns: 2,
            }),
            modelRow({
              model: 'claude-opus',
              last: sample({ tokensPerSecond: 25 }),
              averageTokensPerSecond: 25,
              peakTokensPerSecond: 31,
              averageTtftMs: 2_400,
              turns: 4,
            }),
          ],
        }),
      )
    })
    render(<TokenSpeedMonitor />)
    expect(rowsText()).toEqual([
      'gpt-5|310|50.0|80.0|900 ms|2',
      'claude-opus|25.0|25.0|31.0|2.4 s|4',
    ])
    expect(container.textContent).toContain('2 modelos')
  })

  it('preserva a ordem vinda do Main, sem reordenar na UI', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(
        snapshot({
          last: sample(),
          models: [
            modelRow({ model: 'lento', averageTokensPerSecond: 5 }),
            modelRow({ model: 'rapido', averageTokensPerSecond: 900 }),
          ],
        }),
      )
    })
    render(<TokenSpeedMonitor />)
    expect(rowsText().map((row) => row.split('|')[0])).toEqual([
      'lento',
      'rapido',
    ])
  })

  it('marca a LLM que está gerando agora', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(
        snapshot({
          last: sample(),
          streaming: true,
          models: [
            modelRow({ model: 'gpt-5', streaming: true }),
            modelRow({ model: 'claude-opus', streaming: false }),
          ],
        }),
      )
    })
    render(<TokenSpeedMonitor />)
    const rows = [...container.querySelectorAll('.tokspeed__table tbody tr')]
    expect(rows.map((row) => row.getAttribute('data-streaming'))).toEqual([
      'on',
      'off',
    ])
  })

  it('LLM ainda sem rodada fechada aparece com travessões, não com zeros', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(
        snapshot({
          last: sample(),
          streaming: true,
          models: [
            modelRow({
              model: 'gpt-5',
              turns: 0,
              last: null,
              averageTokensPerSecond: null,
              peakTokensPerSecond: null,
              averageTtftMs: null,
              lastTtftMs: null,
              streaming: true,
              history: [],
            }),
          ],
        }),
      )
    })
    render(<TokenSpeedMonitor />)
    expect(rowsText()).toEqual(['gpt-5|—|—|—|—|0'])
    expect(container.textContent).not.toContain('NaN')
  })

  it('LLM sem nome recebe rótulo explícito em vez de célula vazia', () => {
    act(() => {
      useTokenSpeedStore
        .getState()
        .receive(snapshot({ last: sample(), models: [modelRow({ model: null })] }))
    })
    render(<TokenSpeedMonitor />)
    expect(rowsText()[0]).toContain('modelo desconhecido')
  })

  it('mostra quantos panes compartilham a mesma LLM', () => {
    act(() => {
      useTokenSpeedStore.getState().receive(
        snapshot({
          last: sample(),
          models: [modelRow({ model: 'gpt-5', turns: 6, paneCount: 3 })],
        }),
      )
    })
    render(<TokenSpeedMonitor />)
    expect(rowsText()[0]).toContain('6/3p')
  })
})

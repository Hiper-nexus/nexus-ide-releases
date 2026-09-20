import { describe, expect, it } from 'vitest'
import {
  TokenSpeedMeter,
  isPromptEcho,
  isTuiNoise,
  modelKey,
  visibleText,
} from './token-speed-meter'

const OPTS = {
  idleCloseMs: 1_000,
  recentWindow: 5,
  minGenerationMs: 40,
  minTurnTokens: 4,
  historyLimit: 8,
}

/** 40 chars visíveis ≈ 10 tokens pela régua de 4 chars/token. */
const CHUNK = 'palavra '.repeat(5)

function meter(overrides = {}) {
  return new TokenSpeedMeter({ ...OPTS, ...overrides })
}

describe('visibleText / ruído de TUI', () => {
  it('remove ANSI, controle e CR preservando o texto', () => {
    expect(visibleText('\u001b[32mverde\u001b[0m\r\nfim')).toBe('verde\nfim')
  })

  it('trata spinner, moldura e barra de progresso como ruído', () => {
    expect(isTuiNoise('\u280b')).toBe(true)
    expect(isTuiNoise('──────────')).toBe(true)
    expect(isTuiNoise('   \n  ')).toBe(true)
    expect(isTuiNoise('▁▂▃▄▅')).toBe(true)
    expect(isTuiNoise('resposta do modelo')).toBe(false)
    expect(isTuiNoise('│ 42 tokens')).toBe(false)
  })

  it('não descarta resposta válida composta por pontuação ou emoji', () => {
    expect(isTuiNoise('{} [] =>')).toBe(false)
    expect(isTuiNoise('⭐')).toBe(false)
    expect(isTuiNoise('...')).toBe(false)
  })

  it('emoji composto por ZWJ continua sendo conteúdo, não ruído', () => {
    expect(isTuiNoise('\u{1F468}\u200d\u{1F469}\u200d\u{1F466}')).toBe(false)
    expect(isTuiNoise('\u2B50\ufe0f')).toBe(false)
    expect(isTuiNoise('\u{1F44D}\u{1F3FD}')).toBe(false)
  })

  it('sequência só de zero-width não conta como geração', () => {
    expect(isTuiNoise('\u200b\u200d\ufe0f')).toBe(true)
  })

  it('reconhece eco do prompt independentemente de espaçamento e caixa', () => {
    const echo = 'refatore o cost tracker'
    expect(isPromptEcho('Refatore   o Cost', echo)).toBe(true)
    expect(isPromptEcho('❯ Refatore o Cost', echo)).toBe(true)
    expect(isPromptEcho('│ > Refatore o Cost', echo)).toBe(true)
    expect(isPromptEcho('claro, vou refatorar', echo)).toBe(false)
    expect(isPromptEcho('qualquer coisa', null)).toBe(false)
  })
})

describe('TokenSpeedMeter — estado vazio e bordas', () => {
  it('sem eventos devolve tudo null, nunca NaN', () => {
    const snap = meter().snapshot(1_000)
    expect(snap).toMatchObject({
      last: null,
      averageTokensPerSecond: null,
      peakTokensPerSecond: null,
      turns: 0,
      streaming: false,
      panes: [],
    })
  })

  it('ignora paneId vazio, timestamp inválido e chunk vazio', () => {
    const m = meter()
    expect(m.noteOutput('', 10, CHUNK)).toBe(false)
    expect(m.noteOutput('p1', Number.NaN, CHUNK)).toBe(false)
    expect(m.noteOutput('p1', 10, '')).toBe(false)
    expect(m.noteSubmit('', 10, 'x')).toBe(false)
    expect(m.snapshot(5_000).panes).toHaveLength(0)
  })

  it('opções inválidas caem no default em vez de quebrar a divisão', () => {
    const m = new TokenSpeedMeter({ idleCloseMs: 0, recentWindow: -3 })
    expect(m.idleCloseMs).toBeGreaterThan(0)
    expect(m.recentWindow).toBeGreaterThan(0)
  })
})

describe('TokenSpeedMeter — uma rodada de ponta a ponta', () => {
  it('mede TTFT do submit ao 1º token e tok/s da janela de geração', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'gere um relatório')
    m.noteOutput('p1', 5_200, CHUNK, 'gemini-3.8-flash-high')
    m.noteOutput('p1', 5_700, CHUNK)
    m.noteOutput('p1', 6_200, CHUNK)
    const snap = m.snapshot(7_500)

    expect(snap.last).toMatchObject({
      paneId: 'p1',
      ttftMs: 5_200,
      generationMs: 1_000,
      outputTokens: 30,
      tokensPerSecond: 30,
      model: 'gemini-3.8-flash-high',
      source: 'estimated',
    })
    expect(snap.turns).toBe(1)
    expect(snap.streaming).toBe(false)
  })

  it('o eco do prompt não vira 1º token', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'gere um relatório completo do trimestre')
    // Repaint imediato do TUI com o próprio prompt.
    expect(m.noteOutput('p1', 30, 'gere um relatório completo do trimestre')).toBe(false)
    m.noteOutput('p1', 2_000, CHUNK)
    m.noteOutput('p1', 2_500, CHUNK)
    expect(m.snapshot(4_000).last?.ttftMs).toBe(2_000)
  })

  it('spinner sozinho não abre rodada nem conta token', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'oi')
    m.noteOutput('p1', 100, '\u001b[2K\u280b')
    m.noteOutput('p1', 200, '\u280f')
    expect(m.snapshot(3_000).turns).toBe(0)
    expect(m.snapshot(3_000).last).toBeNull()
  })

  it('marca streaming enquanto os tokens continuam chegando', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'oi')
    m.noteOutput('p1', 500, CHUNK)
    expect(m.snapshot(900).streaming).toBe(true)
    expect(m.snapshot(900).turns).toBe(0)
    expect(m.snapshot(2_500).streaming).toBe(false)
    expect(m.snapshot(2_500).turns).toBe(1)
  })

  it('expõe tok/s ao vivo da rodada aberta (tokens / tempo desde o 1º token)', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'oi')
    m.noteOutput('p1', 500, CHUNK)
    const live = m.snapshot(900)
    expect(live.streaming).toBe(true)
    expect(live.turns).toBe(0)
    expect(live.last).toBeNull()
    // 10 tok em 400 ms = 25 tok/s. Relógio é `now`, não o último chunk.
    expect(live.liveTokensPerSecond).toBe(25)
    expect(live.panes[0]?.liveTokensPerSecond).toBe(25)
    expect(live.models[0]?.liveTokensPerSecond).toBe(25)

    m.noteOutput('p1', 1_000, CHUNK)
    const later = m.snapshot(1_100)
    expect(later.liveTokensPerSecond).toBe(33.3)

    const closed = m.snapshot(2_500)
    expect(closed.streaming).toBe(false)
    expect(closed.liveTokensPerSecond).toBeNull()
    expect(closed.last?.tokensPerSecond).toBe(40)
  })

  it('live fica null no TTFT e com poucos tokens — nunca inventa 0', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'oi')
    expect(m.snapshot(400).liveTokensPerSecond).toBeNull()
    expect(m.snapshot(400).streaming).toBe(false)
    m.noteOutput('p1', 500, 'ab')
    expect(m.snapshot(600).streaming).toBe(true)
    expect(m.snapshot(600).liveTokensPerSecond).toBeNull()
  })
})

describe('TokenSpeedMeter — honestidade da métrica', () => {
  it('rodada curta demais não inventa tok/s', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'oi')
    m.noteOutput('p1', 1_000, CHUNK.repeat(4))
    const sample = m.snapshot(3_000).last
    expect(sample?.outputTokens).toBe(40)
    expect(sample?.generationMs).toBe(0)
    expect(sample?.tokensPerSecond).toBeNull()
  })

  it('média e pico ignoram amostras sem tok/s conhecido', () => {
    const m = meter()
    // Rodada 1: mensurável.
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    // Rodada 2: chunk único, duração 0.
    m.noteSubmit('p1', 5_000, 'b')
    m.noteOutput('p1', 5_100, CHUNK.repeat(3))
    const snap = m.snapshot(10_000)
    expect(snap.turns).toBe(2)
    expect(snap.averageTokensPerSecond).toBe(40)
    expect(snap.peakTokensPerSecond).toBe(40)
  })

  it('saída sem submit observado mede geração e deixa TTFT ausente', () => {
    const m = meter()
    m.noteOutput('p1', 1_000, CHUNK)
    m.noteOutput('p1', 1_500, CHUNK)
    const sample = m.snapshot(4_000).last
    expect(sample?.ttftMs).toBeNull()
    expect(sample?.tokensPerSecond).toBe(40)
    expect(sample?.startedAt).toBe(1_000)
  })

  it('relógio andando para trás não produz TTFT negativo', () => {
    const m = meter()
    m.noteSubmit('p1', 10_000, 'a')
    m.noteOutput('p1', 9_000, CHUNK)
    m.noteOutput('p1', 10_500, CHUNK)
    expect(m.snapshot(13_000).last?.ttftMs).toBeNull()
  })

  it('rodada abaixo do piso de tokens é descartada como ruído', () => {
    const m = meter({ minTurnTokens: 25 })
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    expect(m.snapshot(4_000).turns).toBe(0)
  })
})

describe('TokenSpeedMeter — ciclo de vida das rodadas', () => {
  it('submit novo fecha a rodada aberta', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    m.noteSubmit('p1', 700, 'b')
    const snap = m.snapshot(800)
    expect(snap.turns).toBe(1)
    expect(snap.last?.generationMs).toBe(500)
  })

  it('curva respeita o teto do histórico', () => {
    const m = meter({ historyLimit: 3 })
    for (let turn = 0; turn < 6; turn += 1) {
      const base = turn * 10_000
      m.noteSubmit('p1', base, 'a')
      m.noteOutput('p1', base + 100, CHUNK)
      m.noteOutput('p1', base + 600, CHUNK)
    }
    const snap = m.snapshot(100_000)
    expect(snap.turns).toBe(6)
    expect(snap.panes[0].history).toHaveLength(3)
  })

  it('forget fecha o pane e some com ele do snapshot', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    expect(m.forget('p1')).toBe(true)
    expect(m.forget('desconhecido')).toBe(false)
    expect(m.snapshot(5_000)).toMatchObject({ panes: [], turns: 0, last: null })
  })

  it('flushIdle é idempotente', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    expect(m.flushIdle(5_000)).toBe(true)
    expect(m.flushIdle(5_001)).toBe(false)
    expect(m.snapshot(6_000).turns).toBe(1)
  })
})

describe('TokenSpeedMeter — correção por uso real', () => {
  function withOneTurn() {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    m.flushIdle(3_000)
    return m
  }

  it('substitui a estimativa pela contagem do transcript', () => {
    const m = withOneTurn()
    expect(m.noteUsage('p1', 3_500, { key: 's:1', outputTokens: 403, model: 'gpt-x' })).toBe(true)
    const sample = m.snapshot(4_000).last
    expect(sample).toMatchObject({
      outputTokens: 403,
      generationMs: 500,
      tokensPerSecond: 806,
      model: 'gpt-x',
      source: 'real',
    })
  })

  it('deduplica o mesmo evento de uso', () => {
    const m = withOneTurn()
    expect(m.noteUsage('p1', 3_500, { key: 's:1', outputTokens: 403 })).toBe(true)
    expect(m.noteUsage('p1', 3_600, { key: 's:1', outputTokens: 403 })).toBe(false)
  })

  it('reescrita de streaming do mesmo messageId atualiza a MESMA amostra', () => {
    const m = withOneTurn()
    expect(m.noteUsage('p1', 3_200, { key: 's:1', outputTokens: 120 })).toBe(true)
    expect(m.noteUsage('p1', 3_400, { key: 's:1', outputTokens: 403 })).toBe(true)
    const snap = m.snapshot(4_000)
    expect(snap.turns).toBe(1)
    expect(snap.panes[0].history).toHaveLength(1)
    expect(snap.last?.outputTokens).toBe(403)
    expect(snap.last?.tokensPerSecond).toBe(806)
  })

  it('retém uso real que chega antes do fechamento ocioso da rodada', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    expect(
      m.noteUsage('p1', 650, {
        key: 's:streaming',
        outputTokens: 403,
        model: 'claude-sonnet-4',
      }),
    ).toBe(true)
    expect(m.snapshot(2_000).last).toMatchObject({
      outputTokens: 403,
      tokensPerSecond: 806,
      model: 'claude-sonnet-4',
      source: 'real',
    })
  })

  it('atualiza uso real pendente quando o transcript reescreve a mensagem', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    expect(
      m.noteUsage('p1', 300, {
        key: 's:streaming',
        outputTokens: 120,
      }),
    ).toBe(true)
    expect(
      m.noteUsage('p1', 650, {
        key: 's:streaming',
        outputTokens: 403,
      }),
    ).toBe(true)
    const snap = m.snapshot(2_000)
    expect(snap.turns).toBe(1)
    expect(snap.last?.outputTokens).toBe(403)
    expect(snap.last?.source).toBe('real')
  })

  it('uso real preserva resposta curta que a heurística descartaria como ruído', () => {
    const m = meter({ minTurnTokens: 100 })
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, 'sim')
    m.noteOutput('p1', 600, '!')
    expect(
      m.noteUsage('p1', 650, {
        key: 's:curta',
        outputTokens: 2,
        model: 'gpt-5',
      }),
    ).toBe(true)
    expect(m.snapshot(2_000).last).toMatchObject({
      outputTokens: 2,
      model: 'gpt-5',
      source: 'real',
    })
  })

  it('corrige a amostra temporalmente mais próxima, não apenas a mais recente', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'primeiro')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    m.noteSubmit('p1', 5_000, 'segundo')
    m.noteOutput('p1', 5_100, CHUNK)
    m.noteOutput('p1', 5_600, CHUNK)
    m.flushIdle(7_000)
    expect(
      m.noteUsage('p1', 650, {
        key: 's:primeiro',
        outputTokens: 100,
        model: 'modelo-antigo',
      }),
    ).toBe(true)
    const history = m.snapshot(8_000).panes[0].history
    expect(history[0]).toMatchObject({
      outputTokens: 100,
      model: 'modelo-antigo',
      source: 'real',
    })
    expect(history[1]).toMatchObject({
      outputTokens: 20,
      source: 'estimated',
    })
  })

  it('ignora uso fora da janela, sem pane, zerado ou já corrigido', () => {
    const m = withOneTurn()
    expect(m.noteUsage('p2', 3_500, { key: 'x', outputTokens: 10 })).toBe(false)
    expect(m.noteUsage('p1', 3_500, { key: 'z', outputTokens: 0 })).toBe(false)
    expect(m.noteUsage('p1', 10_000_000, { key: 'y', outputTokens: 10 })).toBe(false)
    expect(m.noteUsage('p1', 3_500, { key: 'a', outputTokens: 403 })).toBe(true)
    expect(m.noteUsage('p1', 3_600, { key: 'b', outputTokens: 500 })).toBe(false)
  })
})

describe('TokenSpeedMeter — vários panes', () => {
  it('isola panes e agrega a última amostra por tempo', () => {
    const m = meter()
    m.noteSubmit('p1', 0, 'a')
    m.noteOutput('p1', 100, CHUNK)
    m.noteOutput('p1', 600, CHUNK)
    m.noteSubmit('p2', 2_000, 'b')
    m.noteOutput('p2', 2_100, CHUNK.repeat(2))
    m.noteOutput('p2', 2_600, CHUNK.repeat(2))

    const snap = m.snapshot(5_000)
    expect(snap.panes.map((p) => p.paneId)).toEqual(['p1', 'p2'])
    expect(snap.turns).toBe(2)
    expect(snap.last?.paneId).toBe('p2')
    expect(snap.peakTokensPerSecond).toBe(80)
    expect(snap.averageTokensPerSecond).toBe(60)
    expect(snap.panes[0].peakTokensPerSecond).toBe(40)
  })
})

describe('modelKey', () => {
  it('colapsa null, vazio e só-espaço numa única LLM desconhecida', () => {
    const unknown = modelKey(null)
    expect(modelKey(undefined)).toBe(unknown)
    expect(modelKey('')).toBe(unknown)
    expect(modelKey('   ')).toBe(unknown)
    expect(modelKey('gpt-5')).not.toBe(unknown)
  })

  it('ignora espaço nas pontas do nome do modelo', () => {
    expect(modelKey('  gpt-5 ')).toBe(modelKey('gpt-5'))
  })
})

describe('TokenSpeedMeter — agregação por LLM', () => {
  /**
   * Uma rodada completa num pane. `spanMs` é a janela de geração e PRECISA
   * ficar abaixo de `idleCloseMs`: um intervalo igual ao limiar de silêncio
   * encerra a rodada por contrato e partiria esta em duas.
   */
  function turn(
    m: TokenSpeedMeter,
    paneId: string,
    base: number,
    model: string | null,
    chunks: number,
    spanMs: number,
  ) {
    m.noteSubmit(paneId, base, 'prompt')
    for (let index = 0; index < chunks; index += 1) {
      const at = base + 100 + (index * spanMs) / Math.max(1, chunks - 1)
      m.noteOutput(paneId, at, CHUNK, model)
    }
  }

  it('sem rodada medida a lista de modelos fica vazia', () => {
    expect(meter().snapshot(1_000).models).toEqual([])
  })

  it('separa cada LLM com seus próprios números', () => {
    const m = meter()
    turn(m, 'p1', 0, 'claude-opus', 2, 800)
    turn(m, 'p2', 5_000, 'gpt-5', 2, 400)
    const { models } = m.snapshot(10_000)

    expect(models).toHaveLength(2)
    // Mais recente primeiro.
    expect(models[0].model).toBe('gpt-5')
    expect(models[0].averageTokensPerSecond).toBe(50)
    expect(models[1].model).toBe('claude-opus')
    expect(models[1].averageTokensPerSecond).toBe(25)
    expect(models.every((entry) => entry.turns === 1)).toBe(true)
    expect(models.every((entry) => entry.paneCount === 1)).toBe(true)
  })

  it('soma panes distintos que rodam a MESMA LLM', () => {
    const m = meter()
    turn(m, 'p1', 0, 'gpt-5', 2, 500)
    turn(m, 'p2', 5_000, 'gpt-5', 2, 500)
    const { models } = m.snapshot(10_000)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ model: 'gpt-5', turns: 2, paneCount: 2 })
  })

  it('pane que troca de modelo alimenta as duas linhas, sem reescrever o passado', () => {
    const m = meter()
    turn(m, 'p1', 0, 'claude-opus', 2, 800)
    turn(m, 'p1', 5_000, 'gpt-5', 2, 400)
    const { models, panes } = m.snapshot(10_000)

    expect(models.map((entry) => entry.model)).toEqual(['gpt-5', 'claude-opus'])
    expect(models[0].averageTokensPerSecond).toBe(50)
    expect(models[1].averageTokensPerSecond).toBe(25)
    // O pane inteiro continua existindo como um só, já no modelo atual.
    expect(panes).toHaveLength(1)
    expect(panes[0].model).toBe('gpt-5')
  })

  it('pico do modelo sobrevive à janela das últimas N', () => {
    const m = meter({ recentWindow: 2 })
    turn(m, 'p1', 0, 'gpt-5', 2, 250)
    for (let index = 1; index <= 3; index += 1) {
      turn(m, 'p1', index * 10_000, 'gpt-5', 2, 500)
    }
    const model = m.snapshot(60_000).models[0]
    expect(model.peakTokensPerSecond).toBe(80)
    expect(model.averageTokensPerSecond).toBe(40)
  })

  it('média de TTFT por LLM ignora rodadas sem submit observado', () => {
    const m = meter()
    turn(m, 'p1', 0, 'gpt-5', 2, 500)
    // Rodada sem submit: TTFT ausente, não zero.
    m.noteOutput('p1', 20_000, CHUNK, 'gpt-5')
    m.noteOutput('p1', 20_500, CHUNK, 'gpt-5')
    const model = m.snapshot(30_000).models[0]
    expect(model.turns).toBe(2)
    expect(model.lastTtftMs).toBeNull()
    expect(model.averageTtftMs).toBe(100)
  })

  it('LLM sem nome vira uma única linha desconhecida', () => {
    const m = meter()
    turn(m, 'p1', 0, null, 2, 500)
    turn(m, 'p2', 5_000, null, 2, 500)
    const { models } = m.snapshot(10_000)
    expect(models).toHaveLength(1)
    expect(models[0].model).toBeNull()
    expect(models[0].turns).toBe(2)
  })

  it('marca streaming na LLM da rodada ABERTA, não na da última fechada', () => {
    const m = meter()
    turn(m, 'p1', 0, 'claude-opus', 2, 1_000)
    m.flushIdle(5_000)
    m.noteSubmit('p1', 6_000, 'prompt')
    m.noteOutput('p1', 6_100, CHUNK, 'gpt-5')
    const { models } = m.snapshot(6_500)

    const opus = models.find((entry) => entry.model === 'claude-opus')
    expect(opus?.streaming).toBe(false)
    expect(models.some((entry) => entry.streaming)).toBe(true)
  })

  it('correção pelo transcript reclassifica a amostra para a LLM reportada', () => {
    const m = meter()
    turn(m, 'p1', 0, 'apelido-da-cli', 2, 500)
    m.flushIdle(5_000)
    expect(
      m.noteUsage('p1', 5_500, {
        key: 's:1',
        outputTokens: 403,
        model: 'claude-sonnet-4',
      }),
    ).toBe(true)
    const { models } = m.snapshot(6_000)
    expect(models).toHaveLength(1)
    expect(models[0].model).toBe('claude-sonnet-4')
    expect(models[0].last?.tokensPerSecond).toBe(806)
    expect(models[0].last?.source).toBe('real')
  })

  it('histórico por LLM respeita o teto do buffer', () => {
    const m = meter({ historyLimit: 3 })
    for (let index = 0; index < 6; index += 1) {
      turn(m, 'p1', index * 10_000, 'gpt-5', 2, 500)
    }
    const model = m.snapshot(100_000).models[0]
    expect(model.turns).toBe(3)
    expect(model.history).toHaveLength(3)
  })

  it('esquecer o pane remove a LLM que só ele usava', () => {
    const m = meter()
    turn(m, 'p1', 0, 'claude-opus', 2, 500)
    turn(m, 'p2', 5_000, 'gpt-5', 2, 500)
    m.flushIdle(10_000)
    m.forget('p1')
    const { models } = m.snapshot(11_000)
    expect(models.map((entry) => entry.model)).toEqual(['gpt-5'])
  })
})

import { z } from 'zod'

/**
 * Contratos do medidor de VELOCIDADE de geração (tok/s + TTFT), compartilhados
 * entre main / preload / renderer. Tudo JSON-serializável.
 *
 * Diferença em relação a `cost-types` e `usage`:
 *  - `cost-types` responde QUANTO custou (acumulado, $/min, tok/s da janela de
 *    60s do workspace inteiro);
 *  - `usage` responde QUANTOS tokens reais o provider cobrou (transcript);
 *  - este arquivo responde QUÃO RÁPIDO o modelo respondeu ESTA rodada:
 *    latência até o 1º token e throughput de geração por turno.
 *
 * Nenhum campo carrega texto de prompt ou de resposta. O medidor observa o
 * stream do PTY apenas para cronometrar; conteúdo nunca entra no snapshot.
 */

/** Procedência dos tokens de saída de uma amostra. */
export type TokenSpeedSource =
  /** Heurística por bytes visíveis do PTY (universal, vale para toda CLI). */
  | 'estimated'
  /** Contagem exata do transcript do provider (Claude/Codex). */
  | 'real'

/** Uma rodada (turno) medida de ponta a ponta. */
export interface TokenSpeedSample {
  paneId: string
  /** epoch ms do fechamento do turno (último token). */
  at: number
  /** epoch ms do submit do prompt, ou do 1º token quando não houve submit. */
  startedAt: number
  outputTokens: number
  /** Janela de geração: 1º token -> último token. */
  generationMs: number
  /** `null` quando duração/tokens não sustentam um número honesto. */
  tokensPerSecond: number | null
  /** Latência submit -> 1º token. `null` sem submit observado. */
  ttftMs: number | null
  model: string | null
  source: TokenSpeedSource
}

/** Estado de velocidade de um pane de agente. */
export interface PaneTokenSpeed {
  paneId: string
  model: string | null
  /** Rodadas fechadas desde que o pane entrou em cena. */
  turns: number
  last: TokenSpeedSample | null
  /** Média das últimas `recentWindow` amostras com tok/s conhecido. */
  averageTokensPerSecond: number | null
  peakTokensPerSecond: number | null
  lastTtftMs: number | null
  /** Há um turno aberto recebendo tokens agora. */
  streaming: boolean
  /**
   * tok/s da rodada ABERTA (tokens até agora / tempo desde o 1º token).
   * `null` no TTFT, com poucos tokens, ou fora de streaming.
   */
  liveTokensPerSecond: number | null
  /** Buffer limitado (mais antigo -> mais recente) para a curva. */
  history: TokenSpeedSample[]
}

/**
 * Velocidade agregada de UM modelo (LLM), somando todos os panes que o
 * usaram. É o recorte que responde "qual LLM está mais rápida agora".
 *
 * Um pane que troca de modelo no meio da sessão contribui para as duas
 * linhas: cada amostra carrega o modelo vigente na rodada, nunca o atual.
 */
export interface ModelTokenSpeed {
  /** Identificador do modelo; `null` quando a CLI não o expõe. */
  model: string | null
  /** Rodadas fechadas deste modelo no escopo. */
  turns: number
  /** Quantos panes distintos usaram este modelo. */
  paneCount: number
  last: TokenSpeedSample | null
  /** Média das últimas `recentWindow` rodadas DESTE modelo. */
  averageTokensPerSecond: number | null
  /**
   * Melhor tok/s observado em TODO o histórico retido deste modelo — não na
   * janela recente. Comparar LLMs pede o teto observado; um pico que cai fora
   * de uma janela de 5 amostras vira ruído, não informação.
   */
  peakTokensPerSecond: number | null
  /** Média de TTFT das últimas `recentWindow` rodadas com submit observado. */
  averageTtftMs: number | null
  lastTtftMs: number | null
  /** Algum pane deste modelo está gerando agora. */
  streaming: boolean
  /** tok/s da rodada aberta deste modelo, se houver. */
  liveTokensPerSecond: number | null
  /** Buffer limitado (mais antigo -> mais recente) para a curva. */
  history: TokenSpeedSample[]
}

/** Agregado do workspace empurrado ao renderer no canal `changed`. */
export interface TokenSpeedSnapshot {
  generatedAt: number
  /** Quantas amostras entram em média/pico (o "últimas N" da UI). */
  recentWindow: number
  /** Amostra mais recente entre todos os panes do escopo. */
  last: TokenSpeedSample | null
  averageTokensPerSecond: number | null
  peakTokensPerSecond: number | null
  /** Soma de rodadas fechadas no escopo. */
  turns: number
  /** Algum pane está gerando agora. */
  streaming: boolean
  /** tok/s ao vivo no escopo (máximo entre panes em streaming). */
  liveTokensPerSecond: number | null
  panes: PaneTokenSpeed[]
  /**
   * Um item por LLM observada, mais recente primeiro (desempate por nome).
   * Vazio até a primeira rodada medida.
   */
  models: ModelTokenSpeed[]
}

export const EMPTY_TOKEN_SPEED_SNAPSHOT: TokenSpeedSnapshot = {
  generatedAt: 0,
  recentWindow: 5,
  last: null,
  averageTokensPerSecond: null,
  peakTokensPerSecond: null,
  turns: 0,
  streaming: false,
  liveTokensPerSecond: null,
  panes: [],
  models: [],
}

export const TOKEN_SPEED_CHANNELS = {
  snapshot: 'tokenSpeed:snapshot',
  changed: 'tokenSpeed:changed',
} as const

/** Placeholder de UI para métrica ausente — nunca renderize NaN/Infinity. */
export const TOKEN_SPEED_EMPTY_LABEL = '—'

/** Rótulo de uma LLM que a CLI não identificou. */
export const UNKNOWN_MODEL_LABEL = 'modelo desconhecido'

/** Nome exibível de um modelo, sem inventar identidade. */
export function modelLabel(model: string | null): string {
  return model && model.trim().length > 0 ? model : UNKNOWN_MODEL_LABEL
}

export const tokenSpeedSnapshotSchema: z.ZodType<TokenSpeedSnapshot> = z.lazy(
  () => {
    const sample = z.object({
      paneId: z.string(),
      at: z.number(),
      startedAt: z.number(),
      outputTokens: z.number(),
      generationMs: z.number(),
      tokensPerSecond: z.number().nullable(),
      ttftMs: z.number().nullable(),
      model: z.string().nullable(),
      source: z.union([z.literal('estimated'), z.literal('real')]),
    })
    return z.object({
      generatedAt: z.number(),
      recentWindow: z.number(),
      last: sample.nullable(),
      averageTokensPerSecond: z.number().nullable(),
      peakTokensPerSecond: z.number().nullable(),
      turns: z.number(),
      streaming: z.boolean(),
      liveTokensPerSecond: z.number().nullable(),
      panes: z.array(
        z.object({
          paneId: z.string(),
          model: z.string().nullable(),
          turns: z.number(),
          last: sample.nullable(),
          averageTokensPerSecond: z.number().nullable(),
          peakTokensPerSecond: z.number().nullable(),
          lastTtftMs: z.number().nullable(),
          streaming: z.boolean(),
          liveTokensPerSecond: z.number().nullable(),
          history: z.array(sample),
        }),
      ),
      models: z.array(
        z.object({
          model: z.string().nullable(),
          turns: z.number(),
          paneCount: z.number(),
          last: sample.nullable(),
          averageTokensPerSecond: z.number().nullable(),
          peakTokensPerSecond: z.number().nullable(),
          averageTtftMs: z.number().nullable(),
          lastTtftMs: z.number().nullable(),
          streaming: z.boolean(),
          liveTokensPerSecond: z.number().nullable(),
          history: z.array(sample),
        }),
      ),
    })
  },
)

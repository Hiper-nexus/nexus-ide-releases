/**
 * Telemetria REAL de tokens (transcript watchers → SQLite) — tipos e canais
 * compartilhados main/renderer. Distinta do cost-tracker heurístico: quando um
 * pane tem dados aqui, a UI mostra custo `real`; sem dados, cai na estimativa.
 */

export const USAGE_CHANNELS = {
  snapshot: 'usage:snapshot',
  changed: 'usage:changed',
  /** Totais de VIDA ÚTIL (todos os escopos) — alimenta o perfil do operador. */
  lifetime: 'usage:lifetime',
  /** Rollup diário limitado (todos os escopos) — gráfico de Uso e cotas. */
  history: 'usage:history',
} as const;

/** Teto do rollup diário persistido: o gráfico nunca pede mais que isso. */
export const USAGE_HISTORY_MAX_DAYS = 90;

/** Consumo de UM dia local (YYYY-MM-DD), somado em todos os escopos. */
export interface UsageDailyBucket {
  readonly day: string;
  /** input + output, a mesma conta de `tokensBurned` do perfil. */
  readonly tokens: number;
  /** Equivalente de API pública — não é fatura nem débito do plano. */
  readonly usdEquivalent: number;
  readonly turns: number;
}

export interface UsageHistory {
  /** Dias com consumo, do mais antigo ao mais novo; no máximo 90. */
  readonly days: readonly UsageDailyBucket[];
  /** Quando o rollup começou a contar (instalação ou atualização). */
  readonly since: number;
  readonly updatedAt: number;
}

export interface PaneUsage {
  paneId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  /**
   * Preenchimento da janela de contexto na última rodada (input + cache_read
   * do evento mais recente). `null` sem leitura — métrica ausente nunca é 0.
   */
  lastContextTokens?: number | null;
  source: 'real';
}

export interface AccountUsage {
  accountId: string;
  provider: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  source: 'real';
}

export interface UsageSnapshot {
  byPane: Record<string, PaneUsage>;
  /** Auditable transcript spend keyed by the exact Nexus vault account. */
  byAccount: Record<string, AccountUsage>;
  global: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    turns: number;
  };
  /** Custo acumulado de geração de mídia (imagem/vídeo/áudio) — SQLite. */
  media: {
    generations: number;
    costUsd: number;
  };
  /**
   * Série diária por provedor (`days`) e, por janela de 7/30/90 dias, o
   * agregado por provedor (`byProvider`), por modelo e os totais detalhados.
   * Opcional: Mains antigos e o snapshot vazio não trazem; a tela some com o
   * painel em vez de mostrar zero.
   */
  analytics?: UsageAnalytics;
}

/**
 * Janelas do painel de Uso e custos (estilo "Usage" do T3). Cada janela é
 * contada em dias locais: 30 = hoje e os 29 dias anteriores.
 */
export const USAGE_WINDOW_OPTIONS = [7, 30, 90] as const;
export type UsageWindowDays = (typeof USAGE_WINDOW_OPTIONS)[number];
export const USAGE_DEFAULT_WINDOW: UsageWindowDays = 30;
/** O rollup diário por provedor nunca passa da maior janela. */
export const USAGE_ANALYTICS_MAX_DAYS: UsageWindowDays = 90;

/** Fatia de um provedor dentro de um dia. */
export interface UsageDayProviderSlice {
  readonly costUsd: number;
  /** cached + uncached input + output (tokens processados). */
  readonly totalTokens: number;
}

/** Um dia local (YYYY-MM-DD) com consumo, somado e por provedor. */
export interface UsageDayPoint {
  readonly day: string;
  /** Equivalente de API pública — não é fatura nem débito do plano. */
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: Readonly<Record<string, UsageDayProviderSlice>>;
}

/** Agregado de um provedor numa janela. */
export interface UsageProviderAggregate {
  readonly provider: string;
  /** Sessões distintas do provedor com atividade na janela. */
  readonly sessions: number;
  readonly costUsd: number;
  /** Fração (0..1) do custo da janela; 0 quando a janela não tem custo. */
  readonly costShare: number;
  readonly totalTokens: number;
  /** Input sem cache (inclui escrita de cache: foi cobrado como input novo). */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** Agregado de um modelo numa janela (tabela "Detalhamento"). */
export interface UsageModelAggregate {
  readonly model: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly costShare: number;
  readonly totalTokens: number;
}

/** Totais detalhados de uma janela (faixa "Totais"). */
export interface UsageDetailedTotals {
  /** cachedInput + uncachedInput + output. */
  readonly processedTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  /**
   * Estimativa do que o cache poupou: tokens lidos do cache × (preço de input
   * − preço de leitura de cache), pela tabela de preços do modelo.
   */
  readonly cacheSavingsUsd: number;
  readonly costUsd: number;
  /** Sessões distintas na janela (todas as ferramentas). */
  readonly sessions: number;
  readonly turns: number;
}

export interface UsageWindowSummary {
  readonly windowDays: UsageWindowDays;
  /** Primeiro dia local da janela (YYYY-MM-DD). */
  readonly startDay: string;
  /** Ordenado por custo, do maior ao menor. */
  readonly byProvider: readonly UsageProviderAggregate[];
  /** Ordenado por custo, do maior ao menor. */
  readonly byModel: readonly UsageModelAggregate[];
  readonly totals: UsageDetailedTotals;
}

/** Série diária + resumos por janela, do mesmo SQLite do projeto. */
export interface UsageAnalytics {
  /** Dia local de referência ("hoje") usado para cortar as janelas. */
  readonly today: string;
  /** Dias com consumo nos últimos 90, do mais antigo ao mais novo. */
  readonly days: readonly UsageDayPoint[];
  readonly windows: Readonly<Record<UsageWindowDays, UsageWindowSummary>>;
}

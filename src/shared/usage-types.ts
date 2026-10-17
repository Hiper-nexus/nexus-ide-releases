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
   * Linhas do rollup (dia local × ferramenta × modelo) e as sessões, de onde
   * a tela tira qualquer recorte: 7/30/90 dias, intervalo, um dia, uma
   * ferramenta, um modelo. Opcional: Mains antigos e o snapshot vazio não
   * trazem; a tela some com o painel em vez de mostrar zero.
   */
  analytics?: UsageAnalytics;
}

/**
 * Presets do painel de Uso e custos (estilo "Usage" do T3). Cada preset é
 * contado em dias locais: 30 = hoje e os 29 dias anteriores.
 */
export const USAGE_WINDOW_OPTIONS = [7, 30, 90] as const;
export type UsageWindowDays = (typeof USAGE_WINDOW_OPTIONS)[number];
export const USAGE_DEFAULT_WINDOW: UsageWindowDays = 30;
/** O rollup nunca passa da maior janela: é também o limite do seletor de datas. */
export const USAGE_ANALYTICS_MAX_DAYS: UsageWindowDays = 90;

/** Um dia local × ferramenta × modelo, somado no SQLite do projeto. */
export interface UsageRollupRow {
  readonly day: string;
  readonly provider: string;
  readonly model: string;
  /** Equivalente de API pública — não é fatura nem débito do plano. */
  readonly costUsd: number;
  /** Input sem cache, como o store grava (`input_units`). */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly cacheSavingsUsd: number;
  readonly turns: number;
}

/**
 * Uma sessão distinta (o id fica no main) com os pares [dia local, modelo] em
 * que ela teve evento. Sessão não soma entre dias — uma que atravessa a
 * meia-noite contaria duas vezes —, então o recorte conta "teve atividade em
 * algum par que casa", exato para qualquer intervalo, ferramenta e modelo.
 */
export interface UsageSessionActivity {
  readonly provider: string;
  readonly cells: readonly (readonly [day: string, model: string])[];
}

/** Rollup dos últimos 90 dias do projeto: a única fonte de todos os recortes. */
export interface UsageAnalytics {
  /** Dia local de referência ("hoje") usado para cortar as janelas. */
  readonly today: string;
  /** Do dia mais antigo ao mais novo; só dias com consumo. */
  readonly rows: readonly UsageRollupRow[];
  readonly sessions: readonly UsageSessionActivity[];
}

/** Recorte pedido pela tela: intervalo de dias locais (inclusive) e filtros. */
export interface UsageQuery {
  /** Primeiro dia (YYYY-MM-DD). */
  readonly from: string;
  /** Último dia (YYYY-MM-DD), inclusive. */
  readonly to: string;
  /** Uma ferramenta; ausente/null = todas. */
  readonly provider?: string | null;
  /**
   * Um modelo dessa ferramenta. O nome sozinho pode repetir entre ferramentas,
   * então só vale junto com `provider`.
   */
  readonly model?: string | null;
}

/** Fatia de uma ferramenta dentro de um dia. */
export interface UsageDayProviderSlice {
  readonly costUsd: number;
  /** cached + uncached input + output (tokens processados). */
  readonly totalTokens: number;
}

/** Um dia local (YYYY-MM-DD) somado e por ferramenta; dia sem consumo vale zero. */
export interface UsageDayPoint {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: Readonly<Record<string, UsageDayProviderSlice>>;
}

/** Agregado de uma ferramenta no recorte. */
export interface UsageProviderAggregate {
  readonly provider: string;
  /** Sessões distintas da ferramenta com atividade no recorte. */
  readonly sessions: number;
  readonly costUsd: number;
  /** Fração (0..1) do custo do recorte; 0 quando o recorte não tem custo. */
  readonly costShare: number;
  readonly totalTokens: number;
  /** Fração (0..1) dos tokens do recorte; 0 quando o recorte não tem tokens. */
  readonly tokenShare: number;
  /** Input sem cache (inclui escrita de cache: foi cobrado como input novo). */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** Agregado de um modelo no recorte (tabela "Detalhamento"). */
export interface UsageModelAggregate {
  readonly model: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly costShare: number;
  readonly totalTokens: number;
  readonly tokenShare: number;
}

/** Totais detalhados do recorte (faixa "Totais"). */
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
  /** Sessões distintas no recorte (todas as ferramentas incluídas). */
  readonly sessions: number;
  readonly turns: number;
}

/** Tudo que a tela mostra de um recorte, calculado de uma vez só. */
export interface UsageRangeSummary {
  readonly from: string;
  readonly to: string;
  /** Ordenado por custo, do maior ao menor. */
  readonly byProvider: readonly UsageProviderAggregate[];
  /** Ordenado por custo, do maior ao menor. */
  readonly byModel: readonly UsageModelAggregate[];
  readonly totals: UsageDetailedTotals;
  /** Um ponto por dia local de `from` a `to`, do mais antigo ao mais novo. */
  readonly days: readonly UsageDayPoint[];
}

export type UsageMetric = 'cost' | 'tokens';

/** Destaques de uma série diária: total, pico e média por dia com uso. */
export interface UsageDayStats {
  readonly dayCount: number;
  /** Dias com custo ou tokens. */
  readonly activeDays: number;
  readonly costUsd: number;
  readonly totalTokens: number;
  /** Média por dia COM uso (dia sem registro não dilui a média); 0 sem uso. */
  readonly averageCostUsd: number;
  readonly averageTokens: number;
  /** Dia de maior valor da medida pedida (sem valor nela, o de mais tokens); null sem uso. */
  readonly peak: UsageDayPoint | null;
}

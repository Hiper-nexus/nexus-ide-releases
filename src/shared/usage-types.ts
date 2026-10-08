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
}

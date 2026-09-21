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
} as const;

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

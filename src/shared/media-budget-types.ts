/**
 * Teto de gasto de mídia (F-1606). Main ↔ renderer: os dois canais são
 * `handleTrusted`; o renderer só lê e grava os limites, o livro-razão fica no Main.
 */

export const MEDIA_BUDGET_CHANNELS = {
  get: 'mediaBudget:get',
  set: 'mediaBudget:set',
} as const;

export interface MediaBudgetLimitsView {
  /** USD por missão; null = sem teto. */
  readonly perMissionUsd: number | null;
  /** USD por dia (todos os projetos); null = sem teto. */
  readonly perDayUsd: number | null;
}

export interface MediaBudgetStateView {
  readonly limits: MediaBudgetLimitsView;
  readonly spentTodayUsd: number;
}

export type MediaBudgetSetResult =
  | ({ readonly ok: true } & MediaBudgetStateView)
  | { readonly ok: false; readonly error: string };

export interface MediaBudgetApi {
  get(): Promise<MediaBudgetStateView>;
  set(limits: MediaBudgetLimitsView): Promise<MediaBudgetSetResult>;
}

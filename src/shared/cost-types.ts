import { z } from 'zod';

/**
 * Cost tracker types shared across main / preload / renderer. Everything is
 * JSON-serializable. Token counts are heuristic estimates from the PTY stream
 * (no provider usage API), so treat costUsd as an order-of-magnitude gauge —
 * parity with Overclock's per-pane cost accounting.
 */

/** Accumulated token/cost accounting for one cli-agent pane. */
export interface PaneCost {
  paneId: string;
  sessionId: string;
  adapterId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Spending cap in USD; absent = uncapped. */
  capUsd?: number;
  /** True once costUsd crossed capUsd (integration decides what pausing does). */
  paused: boolean;
}

/** Workspace-wide aggregate pushed to the renderer on the `changed` channel. */
export interface CostSnapshot {
  totalUsd: number;
  /** USD spent over the last rolling minute. */
  perMinuteUsd: number;
  /** Output-token throughput over the last rolling minute. */
  tokPerSec: number;
  panes: PaneCost[];
}

export const setCapSchema = z.object({
  paneId: z.string().min(1).max(128),
  /** null clears the cap (and un-pauses the pane). */
  capUsd: z.number().min(0).max(1_000_000).nullable(),
});
export type SetCapRequest = z.infer<typeof setCapSchema>;

export const COST_CHANNELS = {
  snapshot: 'cost:snapshot',
  setCap: 'cost:setCap',
  changed: 'cost:changed',
} as const;

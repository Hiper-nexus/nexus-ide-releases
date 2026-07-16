import { z } from 'zod';
import { FEATURE_FLAG_IDS } from './feature-flags';

/**
 * Crossover feature-flag toggle contract (oh-my-pi integration).
 *
 * Two oh-my-pi-derived capabilities ship default OFF and fail-closed:
 * `feature.remote.relayTransport` and `feature.memory.workspaceMemory`. Their
 * built-in definitions never change (fail-closed is doctrine); this contract
 * only adds a CONSCIOUS UI path to flip a persisted override, reusing the main
 * registry's existing `setOverride` + `persistOverrides` mechanism.
 */

/** invoke: renderer → main. Sets one persisted flag override. */
export const CROSSOVER_FLAG_SET_CHANNEL = 'product:flags.setOverride';

export const crossoverFlagSetRequestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-zA-Z0-9._-]*$/),
    enabled: z.boolean(),
  })
  .strict();

export type CrossoverFlagSetRequest = z.infer<
  typeof crossoverFlagSetRequestSchema
>;

export interface CrossoverFlagSetResult {
  readonly id: string;
  readonly enabled: boolean;
  /** Resolution reason from the registry (kill-switch / channel-blocked / …). */
  readonly reason: string;
  /** False when the in-memory override applied but persistence to disk failed. */
  readonly persisted: boolean;
}

/** Optional preload surface (wired onto NexusApi.product). */
export interface CrossoverFlagBridge {
  flagsSetOverride(input: CrossoverFlagSetRequest): Promise<CrossoverFlagSetResult>;
}

/**
 * The flags the crossover Settings section exposes for conscious toggling.
 * Kept in declaration order so the UI is deterministic.
 */
export const CROSSOVER_TOGGLEABLE_FLAG_IDS: readonly string[] = [
  FEATURE_FLAG_IDS.remoteRelayTransport,
  FEATURE_FLAG_IDS.workspaceMemory,
];

/**
 * Extra UI warning per flag — the "com cuidado" copy layered on top of the
 * neutral registry description. Keyed by flag id; absent ⇒ no extra warning.
 */
export const CROSSOVER_FLAG_WARNINGS: Readonly<Record<string, string>> = {
  [FEATURE_FLAG_IDS.remoteRelayTransport]:
    'Ligar o relay expõe um transporte de rede para o companion mobile (relay cego + AES-256-GCM). A URL do relay precisa ser configurada explicitamente — nunca aponte para um relay público.',
  [FEATURE_FLAG_IDS.workspaceMemory]:
    'Memória de workspace é nova: passa a reter/recuperar contexto por projeto (SQLite FTS5) compartilhado por todas as CLIs hospedadas. Reversível a qualquer momento.',
};

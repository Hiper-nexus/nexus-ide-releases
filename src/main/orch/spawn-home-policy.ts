import type { CliPtyAdapter } from '../../shared/adapter-types';

type SpawnHomeAdapter = Pick<CliPtyAdapter, 'env' | 'quirks'>;

/**
 * HOME efêmero é uma técnica do adapter Claude-like: ele precisa enxergar o
 * settings/MCP gerado pelo Nexus sem herdar hooks globais. CLIs como Codex,
 * AGY, Kimi e Grok guardam login no HOME real; trocar HOME nelas quebra auth.
 */
export function shouldUseEphemeralHome(
  adapter: SpawnHomeAdapter,
  gated: boolean,
): boolean {
  return adapter.quirks.mcpAutoload && (gated || adapter.env.ephemeralHome);
}

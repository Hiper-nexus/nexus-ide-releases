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

/**
 * Um adapter Claude-family (roda o binário `claude`, mcpAutoload) que aponta
 * para um endpoint DE TERCEIRO via override estático de ANTHROPIC_BASE_URL —
 * GLM, LongCat. Ele autentica por ANTHROPIC_AUTH_TOKEN injetado, então nunca
 * precisa (e nunca pode tocar) o ~/.claude da assinatura nativa. Reutilizar o
 * home real deixaria o binário do Claude reescrever o estado OAuth da
 * assinatura e deslogar o usuário (/login); esses adapters recebem um HOME
 * isolado.
 */
export function isThirdPartyClaudeFamily(adapter: SpawnHomeAdapter): boolean {
  const baseUrl = adapter.env.static?.ANTHROPIC_BASE_URL;
  return (
    adapter.quirks.mcpAutoload &&
    typeof baseUrl === 'string' &&
    baseUrl.length > 0
  );
}
